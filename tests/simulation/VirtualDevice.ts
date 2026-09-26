import { IVaultStorage } from '../../src/core/storage/IVaultStorage';
import { InMemoryVaultStorage } from '../../src/core/storage/InMemoryVaultStorage';
import { INetworkTransport } from '../../src/core/transport/INetworkTransport';
import { MerkleManager } from '../../src/core/sync/MerkleManager';
import { VersionVectorManager } from '../../src/core/sync/VersionVectorManager';
import { ConflictResolver, ConflictStrategy } from '../../src/core/sync/ConflictResolver';
import { VersionVector, DeviceRole } from '../../src/types';

export interface VirtualDeviceConfig {
    deviceId: string;
    storage?: IVaultStorage;
    conflictStrategy?: ConflictStrategy;
    role?: DeviceRole;
}

export type WireMessage =
    | { type: 'merkle-root'; rootHash: string; deviceId: string }
    | { type: 'request-sync'; remoteHash: string; deviceId: string }
    | { type: 'request-file'; path: string; deviceId: string }
    | { type: 'file-update'; path: string; content: string; mtime: number; isBinary: boolean; versionVector: VersionVector; deviceId: string }
    | { type: 'file-delta'; path: string; patches: string; mtime: number; baseHash: string; versionVector: VersionVector; deviceId: string }
    | { type: 'file-delete'; path: string; deviceId: string }
    | { type: 'file-rename'; oldPath: string; newPath: string; deviceId: string };

/**
 * Headless virtual device that encapsulates vault storage, sync algorithms,
 * version vectors, and networking transport.
 */
export class VirtualDevice {
    public readonly deviceId: string;
    public readonly storage: IVaultStorage;
    public readonly merkleManager: MerkleManager;
    public readonly conflictResolver: ConflictResolver;
    public readonly conflictStrategy: ConflictStrategy;
    public role: DeviceRole;

    private transport: INetworkTransport | null = null;
    private fileVersions: Map<string, VersionVector> = new Map();
    private baseContents: Map<string, string> = new Map();
    private peers: Set<string> = new Set();
    private unsubscribeTransport: (() => void) | null = null;
    private unsubscribeStorage: (() => void) | null = null;

    constructor(config: VirtualDeviceConfig) {
        this.deviceId = config.deviceId;
        this.storage = config.storage ?? new InMemoryVaultStorage();
        this.merkleManager = new MerkleManager(this.storage);
        this.conflictStrategy = config.conflictStrategy ?? 'three-way-merge';
        this.conflictResolver = new ConflictResolver();
        this.role = config.role ?? 'primary';

        // Auto-invalidate Merkle cache on local storage changes
        this.unsubscribeStorage = this.storage.onVaultChange(() => {
            this.merkleManager.invalidate();
        });
    }

    public attachTransport(transport: INetworkTransport) {
        this.transport = transport;
        this.unsubscribeTransport = transport.onMessage((fromPeerId, raw) => {
            this.handleIncomingMessage(fromPeerId, raw);
        });
        transport.onPeerConnect((peerId) => this.peers.add(peerId));
        transport.onPeerDisconnect((peerId) => this.peers.delete(peerId));
    }

    public async connectTo(peerId: string) {
        this.peers.add(peerId);
    }

    public async syncWith(peerId: string): Promise<void> {
        const root = await this.merkleManager.getMerkleTree();
        await this.sendMessage(peerId, {
            type: 'merkle-root',
            rootHash: root.hash,
            deviceId: this.deviceId
        });
    }

    public async syncAll(): Promise<void> {
        for (const peerId of this.peers) {
            await this.syncWith(peerId);
        }
    }

    public async getMerkleRoot(): Promise<string> {
        const root = await this.merkleManager.getMerkleTree();
        return root.hash;
    }

    public async writeFile(filePath: string, content: string, mtime?: number): Promise<void> {
        const fileMtime = mtime ?? Date.now();
        await this.storage.write(filePath, content, fileMtime);
        if (!this.baseContents.has(filePath)) {
            this.baseContents.set(filePath, content);
        }
        this.incrementVersion(filePath);

        // Broadcast to connected peers
        for (const peerId of this.peers) {
            await this.sendMessage(peerId, {
                type: 'file-update',
                path: filePath,
                content,
                mtime: fileMtime,
                isBinary: false,
                versionVector: this.fileVersions.get(filePath) || {},
                deviceId: this.deviceId
            });
        }
    }

    public async writeBinary(filePath: string, content: ArrayBuffer, mtime?: number): Promise<void> {
        const fileMtime = mtime ?? Date.now();
        await this.storage.writeBinary(filePath, content, fileMtime);
        this.incrementVersion(filePath);

        // Convert to base64 string for message transport
        const b64 = Buffer.from(content).toString('base64');
        for (const peerId of this.peers) {
            await this.sendMessage(peerId, {
                type: 'file-update',
                path: filePath,
                content: b64,
                mtime: fileMtime,
                isBinary: true,
                versionVector: this.fileVersions.get(filePath) || {},
                deviceId: this.deviceId
            });
        }
    }

    public async deleteFile(filePath: string): Promise<void> {
        await this.storage.delete(filePath);
        this.incrementVersion(filePath);

        for (const peerId of this.peers) {
            await this.sendMessage(peerId, {
                type: 'file-delete',
                path: filePath,
                deviceId: this.deviceId
            });
        }
    }

    public async renameFile(oldPath: string, newPath: string): Promise<void> {
        await this.storage.rename(oldPath, newPath);
        const vv = this.fileVersions.get(oldPath) || {};
        this.fileVersions.delete(oldPath);
        this.fileVersions.set(newPath, VersionVectorManager.increment(vv, this.deviceId));

        for (const peerId of this.peers) {
            await this.sendMessage(peerId, {
                type: 'file-rename',
                oldPath,
                newPath,
                deviceId: this.deviceId
            });
        }
    }

    private incrementVersion(path: string) {
        const current = this.fileVersions.get(path) || {};
        this.fileVersions.set(path, VersionVectorManager.increment(current, this.deviceId));
    }

    private async sendMessage(peerId: string, msg: WireMessage): Promise<void> {
        if (!this.transport) return;
        const payload = JSON.stringify(msg);
        await this.transport.send(peerId, payload);
    }

    private async handleIncomingMessage(fromPeerId: string, raw: Uint8Array | string) {
        const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
        let msg: WireMessage;
        try {
            msg = JSON.parse(text);
        } catch {
            return;
        }

        switch (msg.type) {
            case 'merkle-root': {
                const localRoot = await this.merkleManager.getMerkleTree();
                if (localRoot.hash !== msg.rootHash) {
                    // Tree mismatch: send full tree or sync request
                    const files = await this.storage.listFiles();
                    for (const file of files) {
                        try {
                            const content = file.isBinary
                                ? Buffer.from(await this.storage.readBinary(file.path)).toString('base64')
                                : await this.storage.read(file.path);

                            await this.sendMessage(fromPeerId, {
                                type: 'file-update',
                                path: file.path,
                                content,
                                mtime: file.mtime,
                                isBinary: file.isBinary,
                                versionVector: this.fileVersions.get(file.path) || {},
                                deviceId: this.deviceId
                            });
                        } catch {
                            // Concurrently deleted, ignore
                        }
                    }
                }
                break;
            }

            case 'file-update': {
                await this.applyIncomingUpdate(msg);
                break;
            }

            case 'file-delete': {
                if (await this.storage.exists(msg.path)) {
                    await this.storage.delete(msg.path);
                }
                break;
            }

            case 'file-rename': {
                if (await this.storage.exists(msg.oldPath)) {
                    await this.storage.rename(msg.oldPath, msg.newPath);
                }
                break;
            }
        }
    }

    private async applyIncomingUpdate(msg: {
        path: string;
        content: string;
        mtime: number;
        isBinary: boolean;
        versionVector: VersionVector;
        deviceId: string;
    }) {
        const exists = await this.storage.exists(msg.path);
        const localVV = this.fileVersions.get(msg.path) || {};
        const remoteVV = msg.versionVector || {};

        if (!exists) {
            // New file: write directly
            if (msg.isBinary) {
                const buf = Buffer.from(msg.content, 'base64');
                await this.storage.writeBinary(msg.path, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), msg.mtime);
            } else {
                await this.storage.write(msg.path, msg.content, msg.mtime);
                this.baseContents.set(msg.path, msg.content);
            }
            this.fileVersions.set(msg.path, VersionVectorManager.merge(localVV, remoteVV));
            return;
        }

        // Existing file: check version vectors and detect conflicts
        const relation = VersionVectorManager.compare(localVV, remoteVV);

        if (relation === 'LESSER') {
            // Remote is causally newer
            if (msg.isBinary) {
                const buf = Buffer.from(msg.content, 'base64');
                await this.storage.writeBinary(msg.path, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), msg.mtime);
            } else {
                await this.storage.write(msg.path, msg.content, msg.mtime);
                this.baseContents.set(msg.path, msg.content);
            }
            this.fileVersions.set(msg.path, VersionVectorManager.merge(localVV, remoteVV));
            return;
        }

        if (relation === 'GREATER' || relation === 'EQUAL') {
            // Local is newer or equal, ignore
            return;
        }

        // Concurrent edit: invoke ConflictResolver
        const localMtime = (await this.storage.stat(msg.path))?.mtime ?? 0;
        const localContent = msg.isBinary
            ? await this.storage.readBinary(msg.path)
            : await this.storage.read(msg.path);

        const remoteContent = msg.isBinary
            ? Buffer.from(msg.content, 'base64')
            : msg.content;

        // Try 3-way text merge if enabled
        if (this.conflictStrategy === 'three-way-merge' && typeof localContent === 'string' && typeof remoteContent === 'string') {
            const base = this.baseContents.get(msg.path) || localContent;
            const patch = this.conflictResolver.createPatch(base, remoteContent);
            const { mergedText, success } = this.conflictResolver.mergePatches(localContent, patch);
            if (success) {
                await this.storage.write(msg.path, mergedText, Math.max(localMtime, msg.mtime) + 1);
                this.baseContents.set(msg.path, mergedText);
                const mergedVV = VersionVectorManager.merge(localVV, remoteVV);
                mergedVV[this.deviceId] = (mergedVV[this.deviceId] || 0) + 1;
                this.fileVersions.set(msg.path, mergedVV);
                return;
            }
        }

        const outcome = this.conflictResolver.resolve({
            strategy: this.conflictStrategy,
            filePath: msg.path,
            localContent,
            localMtime,
            remoteContent: typeof remoteContent === 'string' ? remoteContent : remoteContent.buffer,
            remoteMtime: msg.mtime,
            remoteDeviceId: msg.deviceId,
            myRole: this.role
        });

        if (outcome.action === 'adopt-remote') {
            if (msg.isBinary) {
                const buf = Buffer.from(msg.content, 'base64');
                await this.storage.writeBinary(msg.path, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), msg.mtime);
            } else {
                await this.storage.write(msg.path, msg.content, msg.mtime);
                this.baseContents.set(msg.path, msg.content);
            }
        } else if (outcome.action === 'write-merged' && typeof outcome.contentToSave === 'string') {
            await this.storage.write(msg.path, outcome.contentToSave, Math.max(localMtime, msg.mtime) + 1);
            this.baseContents.set(msg.path, outcome.contentToSave);
        } else if (outcome.action === 'create-conflict-file' && outcome.conflictFilePath) {
            if (msg.isBinary) {
                const buf = Buffer.from(msg.content, 'base64');
                await this.storage.writeBinary(outcome.conflictFilePath, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), msg.mtime);
            } else {
                await this.storage.write(outcome.conflictFilePath, msg.content, msg.mtime);
            }
        }

        const mergedVV = VersionVectorManager.merge(localVV, remoteVV);
        mergedVV[this.deviceId] = (mergedVV[this.deviceId] || 0) + 1;
        this.fileVersions.set(msg.path, mergedVV);
    }

    public async destroy() {
        if (this.unsubscribeTransport) this.unsubscribeTransport();
        if (this.unsubscribeStorage) this.unsubscribeStorage();
    }
}
