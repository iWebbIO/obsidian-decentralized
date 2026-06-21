import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, TAbstractFile, Modal, Platform, requestUrl, debounce, setIcon, MarkdownView } from 'obsidian';
import Peer, { DataConnection, PeerJSOption } from 'peerjs';
import DiffMatchPatch from 'diff-match-patch';
import * as QRCode from 'qrcode';
import { Html5Qrcode } from 'html5-qrcode';
// @ts-ignore
import * as pako from 'pako';

// --- Constants ---
const DISCOVERY_PORT = 41234;
const DISCOVERY_MULTICAST_ADDRESS = '224.0.0.114';
const COMPANION_RECONNECT_INTERVAL_MS = 10000;
const TARGET_CHUNK_TIME_MS = 3000;
const MIN_CHUNK_SIZE = 64 * 1024;
const MAX_CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_BANDWIDTH_SAMPLES = 10;
const MAX_QUEUE_DEPTH = 50;
const LOCK_EXPIRATION_MS = 30000;
const MAX_HASH_CACHE_SIZE = 10000;

// Phase Timeouts
const REQUESTING_TIMEOUT = 30000;
const PLANNING_TIMEOUT = 60000;
const BATCH_TIMEOUT = 120000;
const COMPLETING_TIMEOUT = 30000;

enum SyncPhase { IDLE = 'IDLE', REQUESTING = 'REQUESTING', PLANNING = 'PLANNING', TRANSFERRING = 'TRANSFERRING', COMPLETING = 'COMPLETING', ABORTING = 'ABORTING' }
enum SyncErrorCategory { CONNECTION_ERROR = 'CONNECTION_ERROR', TIMEOUT_ERROR = 'TIMEOUT_ERROR', INTEGRITY_ERROR = 'INTEGRITY_ERROR', PROTOCOL_ERROR = 'PROTOCOL_ERROR', VAULT_ERROR = 'VAULT_ERROR' }

class SyncError extends Error {
    constructor(public category: SyncErrorCategory, message: string, public recoverable: boolean, public suggestedAction: string) {
        super(message);
        this.name = 'SyncError';
    }
}

export interface SyncState {
    isSyncing: boolean;
    currentPhase: SyncPhase;
    peerId: string | null;
    pendingPulls: Set<string>;
    allowedPulls: Set<string>;
    activeBatches: Map<string, BatchState>;
    phaseStartTime: number;
    phaseTimeoutHandle: number | null;
    missedPings: number;
    filesTotal: number;
    filesTransferred: number;
    bytesTotal: number;
    bytesTransferred: number;
}

// --- Type Definitions ---
type PeerInfo = { deviceId: string; friendlyName: string; ip: string | null; port?: number; mode?: 'peerjs' | 'direct-ip'; };
type DiscoveryBeacon = { type: 'obsidian-decentralized-beacon'; peerInfo: PeerInfo; };
type FileManifestEntry = { path: string; mtime: number; size: number; type: 'file' | 'deleted'; hash?: string; versionVector?: VersionVector };
type FolderManifestEntry = { path: string; type: 'folder' };
type VaultManifest = (FileManifestEntry | FolderManifestEntry)[];

type DeviceRole = 'primary' | 'secondary';
type VersionVector = { [deviceId: string]: number };

type BasePayload = { transferId: string; messageId?: string; };
type HandshakePayload = { type: 'handshake'; peerInfo: PeerInfo; pin?: string; };
type RoleAnnouncementPayload = { type: 'role-announcement'; role: DeviceRole; deviceId: string; };
type ClusterGossipPayload = { type: 'cluster-gossip'; peers: PeerInfo[]; };
type CompanionPairPayload = { type: 'companion-pair'; peerInfo: PeerInfo; };
type AckPayload = { type: 'ack', transferId: string };
type NackPayload = { type: 'nack', transferId: string, reason: 'integrity-failure' | 'write-error' };
type FileUpdatePayload = BasePayload & { type: 'file-update'; path: string; content: string | ArrayBuffer; mtime: number; encoding: 'utf8' | 'binary' | 'base64'; fileHash?: string; compressed?: boolean; versionVector?: VersionVector; };
type FileDeltaPayload = BasePayload & { type: 'file-delta'; path: string; mtime: number; patches: string; baseHash: string; versionVector?: VersionVector; };
type FileDeletePayload = BasePayload & { type: 'file-delete'; path: string; };
type FileRenamePayload = BasePayload & { type: 'file-rename'; oldPath: string; newPath: string; versionVector?: VersionVector; };
type FolderCreatePayload = BasePayload & { type: 'folder-create', path: string; };
type FolderDeletePayload = BasePayload & { type: 'folder-delete', path: string; };
type FolderRenamePayload = BasePayload & { type: 'folder-rename', oldPath: string, newPath: string; };

// Full Sync Pull-based Payloads
type FullSyncRequestPayload = { type: 'request-full-sync', manifest: VaultManifest };
type SyncPlanPayload = { type: 'sync-plan', filesReceiverWillSend: string[], filesInitiatorMustSend: string[], filesReceiverMustDelete: string[], filesInitiatorMustDelete: string[], fileSizes: Record<string, number> };
type RequestBatchPayload = { type: 'request-batch', paths: string[], batchId: string };
type BatchCompletePayload = { type: 'batch-complete', batchId: string, receivedPaths: string[], failedPaths: string[] };
type FullSyncCompletePayload = { type: 'full-sync-complete' };
type InitiatorSyncDonePayload = { type: 'initiator-sync-done' };
type RequestFilePayload = { type: 'request-file', path: string };

type FileChunkStartPayload = { type: 'file-chunk-start', path: string, mtime: number, totalChunks: number, transferId: string, fileHash: string, compressed?: boolean, versionVector?: VersionVector };
type FileChunkDataPayload = { type: 'file-chunk-data', transferId: string, index: number, data: ArrayBuffer };
type PingPayload = { type: 'ping' };
type PongPayload = { type: 'pong' };
type SyncPingPayload = { type: 'sync-ping' };
type SyncPongPayload = { type: 'sync-pong' };
type ClusterForgetPayload = { type: 'cluster-forget'; targetDeviceId: string; };
type ClusterKickPayload = { type: 'cluster-kick'; targetDeviceId: string; };
type ClusterRenamePayload = { type: 'cluster-rename'; targetDeviceId: string; newName: string; };

// Locking & Realtime Payloads
type LockRequestPayload = { type: 'lock-request', path: string, requestId: string };
type LockGrantPayload = { type: 'lock-grant', path: string, requestId: string, grantedUntil: number };
type LockDenyPayload = { type: 'lock-deny', path: string, requestId: string, reason: string };
type LockReleasePayload = { type: 'lock-release', path: string };
type EditorActivatePayload = { type: 'editor-active', path: string };
type EditorDeltaPayload = { type: 'editor-delta', path: string, patches: string };

type SyncAckPayload = { type: 'sync-ack', messageId: string };

// Merkle Tree Payloads
type MerkleRootPayload = { type: 'merkle-root', rootHash: string };
type MerkleNodeRequestPayload = { type: 'merkle-node-request', path: string };
type MerkleNodeResponsePayload = { type: 'merkle-node-response', path: string, children: Record<string, string> };

interface MerkleNode {
    hash: string;
    children?: Record<string, MerkleNode>;
}

interface TransferStatus {
    id: string;
    path: string;
    direction: 'upload' | 'download';
    peerId: string;
    totalChunks: number;
    processedChunks: number;
    startTime: number;
    lastUpdate: number;
    status: 'active' | 'paused';
    chunkSize?: number;
    compressed?: boolean;
}

interface FailedSync {
    path: string;
    peerId: string | null;
    timestamp: number;
    type: 'file-update' | 'file-delete' | 'file-delta';
    reason?: string;
    retryCount: number;
}

export interface SyncStatusState {
    text: string;
    icon: string;
    spin?: boolean;
    state: 'loading' | 'success' | 'error' | 'neutral';
}

type SyncTask = 
    | { taskType: 'send-file', path: string, mtime: number, forceFull: boolean, batchId?: string }
    | { taskType: 'send-folder-create', path: string, batchId?: string }
    | { taskType: 'send-delete', path: string }
    | { taskType: 'send-rename', oldPath: string, newPath: string };

interface BatchState {
    peerId: string;
    batchId: string;
    totalCount: number;
    sentCount: number;
    succeededPaths: string[];
    failedPaths: string[];
}

type SyncData =
    | HandshakePayload | RoleAnnouncementPayload | ClusterGossipPayload | CompanionPairPayload | AckPayload | NackPayload
    | FileUpdatePayload | FileDeltaPayload | FileDeletePayload | FileRenamePayload
    | FolderCreatePayload | FolderDeletePayload | FolderRenamePayload
    | FullSyncRequestPayload | SyncPlanPayload | RequestBatchPayload | BatchCompletePayload | FullSyncCompletePayload | InitiatorSyncDonePayload | RequestFilePayload
    | FileChunkStartPayload | FileChunkDataPayload | PingPayload | PongPayload | SyncPingPayload | SyncPongPayload
    | ClusterForgetPayload | ClusterKickPayload | ClusterRenamePayload
    | LockRequestPayload | LockGrantPayload | LockDenyPayload | LockReleasePayload
    | EditorActivatePayload | EditorDeltaPayload | SyncAckPayload
    | MerkleRootPayload | MerkleNodeRequestPayload | MerkleNodeResponsePayload;

// Interfaces
interface PeerServerConfig { host: string; port: number; path: string; secure: boolean; }
interface DirectIpConfig { host: string; port: number; pin: string; }
interface ObsidianDecentralizedSettings {
    syncMode: 'auto' | 'manual' | 'advanced';
    showToasts: boolean;
    deviceId: string;
    friendlyName: string;
    companionPeerId?: string;
    useCustomPeerServer: boolean;
    customPeerServerConfig: PeerServerConfig;
    verboseLogging: boolean;
    connectionMode: 'peerjs' | 'direct-ip';
    directIpHostAddress: string;
    directIpHostPort: number;
    syncAllFileTypes: boolean;
    syncObsidianConfig: boolean;
    conflictResolutionStrategy: 'create-conflict-file' | 'last-write-wins' | 'role-based';
    includedFolders: string;
    excludedFolders: string;
    hideNativeSyncStatus: boolean;
    maximumConcurrentTransfers: number | null;
    chunkSize: number | null;
    debounceDelay: number;
    mtimeTolerance: number;
    knownPeers: PeerInfo[];
    requirePinForAllConnections: boolean;
    idleTimeoutMs: number;
    tombstoneRetentionDays: number;
    enableCompression: boolean;
    enableDeltaSync: boolean;
    deltaSyncThreshold: number;
    
    // Two-Device Mode Settings
    enableTwoDeviceOptimizations: boolean;
    enableEncryption: boolean;
    enableRealtimeSync: boolean;
    peerKeys: Record<string, string>; // peerId -> base64 PSK
}

export interface TwoDeviceState {
    fileVersions: Record<string, VersionVector>; // path -> { deviceId: version }
    merkleTreeRoot: MerkleNode | null;
}

const DEFAULT_SETTINGS: ObsidianDecentralizedSettings = {
    syncMode: 'auto',
    showToasts: false,
    deviceId: '',
    friendlyName: 'My New Device',
    companionPeerId: undefined,
    useCustomPeerServer: false,
    customPeerServerConfig: { host: 'localhost', port: 9000, path: '/myapp', secure: false },
    verboseLogging: false,
    connectionMode: 'peerjs',
    directIpHostAddress: '192.168.1.100',
    directIpHostPort: 41235,
    syncAllFileTypes: true,
    syncObsidianConfig: false,
    conflictResolutionStrategy: 'create-conflict-file',
    includedFolders: '',
    excludedFolders: '',
    hideNativeSyncStatus: false,
    maximumConcurrentTransfers: null,
    chunkSize: null,
    debounceDelay: 2000,
    mtimeTolerance: 1500,
    knownPeers: [],
    requirePinForAllConnections: false,
    idleTimeoutMs: 30000,
    tombstoneRetentionDays: 30,
    enableCompression: true,
    enableDeltaSync: true,
    deltaSyncThreshold: 50,
    
    enableTwoDeviceOptimizations: true,
    enableEncryption: true,
    enableRealtimeSync: true,
    peerKeys: {}
};

interface ILANDiscovery {
    on(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    startBroadcasting(peerInfo: PeerInfo): void;
    stopBroadcasting(): void;
    startListening(): void;
    stop(): void;
}

// --- Helper Functions ---
function compressText(content: string): ArrayBuffer {
    return pako.deflate(content).buffer;
}

function decompressText(data: ArrayBuffer): string {
    return pako.inflate(new Uint8Array(data), { to: 'string' });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

function formatBytes(bytes: number, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

class DummyLANDiscovery implements ILANDiscovery {
    on(event: string, listener: (...args: any[]) => void): this { return this; }
    off(event: string, listener: (...args: any[]) => void): this { return this; }
    startBroadcasting(peerInfo: PeerInfo): void { }
    stopBroadcasting(): void { }
    startListening(): void { }
    stop(): void { }
}

class DesktopLANDiscovery implements ILANDiscovery {
    private socket: any | null = null;
    private broadcastInterval: number | null = null;
    private discoveredPeers: Map<string, PeerInfo> = new Map();
    private peerTimeouts: Map<string, number> = new Map();
    private discoveryTimeoutMs: number = 5000;
    private _emitter: any;
    private myDeviceId: string | null = null;

    constructor() {
        const { EventEmitter } = require('events');
        this._emitter = new EventEmitter();
    }

    public on(event: string, listener: (...args: any[]) => void): this {
        this._emitter.on(event, listener);
        return this;
    }

    public off(event: string, listener: (...args: any[]) => void): this {
        this._emitter.removeListener(event, listener);
        return this;
    }

    private emit(event: string, ...args: any[]): boolean {
        return this._emitter.emit(event, ...args);
    }

    private createSocket() {
        if (this.socket) return;

        const dgram = require('dgram');
        this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        this.socket.on('error', (err: Error) => {
            console.error('LAN Discovery Socket Error:', err);
            this.stop();
            new Notice('LAN discovery failed. Your firewall might be blocking it.', 10000);
        });

        this.socket.on('listening', () => {
            try {
                this.socket?.setMulticastTTL(128);

                const os = require('os');
                const interfaces = os.networkInterfaces();
                let membershipAdded = false;

                for (const name in interfaces) {
                    const ifaceList = interfaces[name];
                    if (!ifaceList) continue;
                    for (const net of ifaceList) {
                        if (net.family === 'IPv4' && !net.internal) {
                            try {
                                this.socket?.addMembership(DISCOVERY_MULTICAST_ADDRESS, net.address);
                                membershipAdded = true;
                            } catch (e) { /* Ignore specific interface errors */ }
                        }
                    }
                }

                if (!membershipAdded) this.socket?.addMembership(DISCOVERY_MULTICAST_ADDRESS);

                console.log(`LAN Discovery listening on ${DISCOVERY_MULTICAST_ADDRESS}:${DISCOVERY_PORT}`);
            } catch (e) {
                console.error("Error setting up multicast:", e);
                new Notice("Could not set up multicast. LAN discovery might not work.");
            }
        });

        this.socket.on('message', (msg: Buffer, rinfo: any) => {
            try {
                const data: DiscoveryBeacon = JSON.parse(msg.toString());
                if (data.type === 'obsidian-decentralized-beacon' && data.peerInfo?.deviceId) {
                    const peerId = data.peerInfo.deviceId;
                    if (this.myDeviceId && peerId === this.myDeviceId) return;

                    if (this.peerTimeouts.has(peerId)) {
                        clearTimeout(this.peerTimeouts.get(peerId)!);
                    }

                    const isNew = !this.discoveredPeers.has(peerId);
                    data.peerInfo.ip = rinfo.address;
                    this.discoveredPeers.set(peerId, data.peerInfo);
                    if (isNew) {
                        this.emit('discover', data.peerInfo);
                    }

                    const timeout = window.setTimeout(() => {
                        this.discoveredPeers.delete(peerId);
                        this.peerTimeouts.delete(peerId);
                        this.emit('lose', data.peerInfo);
                    }, this.discoveryTimeoutMs);
                    this.peerTimeouts.set(peerId, timeout);
                }
            } catch (e) { /* ignore parse errors */ }
        });

        this.socket.bind(DISCOVERY_PORT, '0.0.0.0');
    }

    public startBroadcasting(peerInfo: PeerInfo) {
        this.myDeviceId = peerInfo.deviceId;
        this.stopBroadcasting();
        this.createSocket();

        const beaconMessage = JSON.stringify({
            type: 'obsidian-decentralized-beacon',
            peerInfo
        });

        const sendBeacon = () => {
            this.socket?.send(beaconMessage, 0, beaconMessage.length, DISCOVERY_PORT, DISCOVERY_MULTICAST_ADDRESS, (err: Error | null) => {
                if (err) console.error("Beacon send error:", err);
            });
        };

        this.broadcastInterval = window.setInterval(sendBeacon, 2000);
    }

    public stopBroadcasting() {
        if (this.broadcastInterval) {
            clearInterval(this.broadcastInterval);
            this.broadcastInterval = null;
        }
    }

    public startListening() {
        this.createSocket();
    }

    public stop() {
        this.stopBroadcasting();
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        this.discoveredPeers.clear();
        this.peerTimeouts.forEach(timeout => clearTimeout(timeout));
        this.peerTimeouts.clear();
        console.log('LAN Discovery stopped.');
    }
}

class DirectIpServer {
    private server: any | null = null;
    private clients: Map<string, { lastSeen: number, queue: any[], bufferedAmount: number }> = new Map();
    private pin: string;
    private readonly MAX_QUEUE_SIZE = 2000;

    constructor(private plugin: ObsidianDecentralizedPlugin, port: number, pin: string) {
        if (Platform.isMobile) {
            this.plugin.showNotice("Offline Host mode is only available on Desktop.", 'important');
            return;
        }
        this.pin = pin;
        this.start(port);
    }

    private start(port: number) {
        const http = require('http');
        this.server = http.createServer(this.handleRequest.bind(this));
        this.server.on('error', (err: Error) => {
            this.plugin.showNotice(`Offline server error: ${err.message}`, 'error');
            this.plugin.log("Offline Server Error:", err);
            this.server = null;
        });
        this.server.listen(port, () => {
            this.plugin.log(`Offline server listening on port ${port}`);
        });
    }

    getClients(): string[] {
        const now = Date.now();
        for (const [id, client] of this.clients.entries()) {
            if (now - client.lastSeen > 10000) {
                this.clients.delete(id);
            }
        }
        return Array.from(this.clients.keys());
    }

    sendTo(peerId: string, data: any) {
        const client = this.clients.get(peerId);
        if (client) {
            if (client.queue.length >= this.MAX_QUEUE_SIZE) {
                const evicted = client.queue.splice(0, client.queue.length - this.MAX_QUEUE_SIZE + 1);
                const evictedSize = evicted.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
                client.bufferedAmount = Math.max(0, client.bufferedAmount - evictedSize);
            }
            client.queue.push(data);
            client.bufferedAmount += JSON.stringify(data).length;
        }
    }

    hasClient(peerId: string): boolean {
        this.getClients();
        return this.clients.has(peerId);
    }

    getBufferedAmount(peerId: string): number {
        return this.clients.get(peerId)?.bufferedAmount || 0;
    }

    private handleRequest(req: any, res: any) {
        const CORS_HEADERS = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Device-Id, X-Pin'
        };
        if (req.method === 'OPTIONS') {
            res.writeHead(204, CORS_HEADERS);
            res.end();
            return;
        }

        const pin = req.headers['x-pin'];
        const deviceId = req.headers['x-device-id'] as string || 'unknown';

        if (pin !== this.pin) {
            res.writeHead(403, CORS_HEADERS);
            res.end(JSON.stringify({ error: 'Invalid PIN' }));
            return;
        }

        if (deviceId !== 'unknown') {
            if (!this.clients.has(deviceId)) {
                this.clients.set(deviceId, { lastSeen: Date.now(), queue: [], bufferedAmount: 0 });
            } else {
                this.clients.get(deviceId)!.lastSeen = Date.now();
            }
        }

        if (req.url === '/poll' && req.method === 'GET') {
            res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
            let messagesToSend: any[] = [];
            
            if (deviceId !== 'unknown' && this.clients.has(deviceId)) {
                const client = this.clients.get(deviceId)!;
                messagesToSend = client.queue.splice(0, 200);
                client.bufferedAmount = 0;
            }

            const messages = messagesToSend.map(msg => {
                if (msg.type === 'file-update' && msg.encoding === 'binary' && msg.content instanceof ArrayBuffer) {
                    return { ...msg, content: arrayBufferToBase64(msg.content), encoding: 'base64' };
                }
                if (msg.type === 'file-chunk-data' && msg.data instanceof ArrayBuffer) {
                    return { ...msg, data: arrayBufferToBase64(msg.data) };
                }
                return msg;
            });
            res.end(JSON.stringify(messages));
        } else if (req.url === '/push' && req.method === 'POST') {
            let body = '';
            let totalSize = 0;
            const MAX_BODY_SIZE = 50 * 1024 * 1024;
            let destroyed = false;

            req.on('data', (chunk: any) => {
                if (destroyed) return;
                totalSize += chunk.length;
                if (totalSize > MAX_BODY_SIZE) {
                    destroyed = true;
                    res.writeHead(413, CORS_HEADERS);
                    res.end(JSON.stringify({ error: 'Payload too large' }));
                    req.destroy();
                    return;
                }
                body += chunk.toString();
            });
            req.on('end', () => {
                if (destroyed) return;
                try {
                    let data: any = JSON.parse(body);
                    if (data.type === 'file-update' && data.encoding === 'base64' && typeof data.content === 'string') {
                         data = { ...data, content: base64ToArrayBuffer(data.content), encoding: 'binary' };
                    }
                    if (data.type === 'file-chunk-data' && typeof (data as any).data === 'string') {
                        (data as any).data = base64ToArrayBuffer((data as any).data);
                    }

                    const mockConn = {
                        send: (msg: any) => this.sendTo(deviceId, msg),
                        peer: deviceId !== 'unknown' ? deviceId : 'direct-ip-client',
                        open: true,
                    } as any;

                    this.plugin.handleRawIncomingData(data, mockConn);
                    res.writeHead(200, CORS_HEADERS);
                    res.end(JSON.stringify({ status: 'ok' }));
                } catch (e) {
                    res.writeHead(400, CORS_HEADERS);
                    res.end(JSON.stringify({ error: 'Invalid data format' }));
                }
            });
        } else {
            res.writeHead(404, CORS_HEADERS);
            res.end();
        }
    }

    send(data: any) {
        for (const client of this.clients.values()) {
            if (client.queue.length >= this.MAX_QUEUE_SIZE) {
                const evicted = client.queue.splice(0, client.queue.length - this.MAX_QUEUE_SIZE + 1);
                const evictedSize = evicted.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
                client.bufferedAmount = Math.max(0, client.bufferedAmount - evictedSize);
            }
            client.queue.push(data);
            client.bufferedAmount += JSON.stringify(data).length;
        }
    }

    stop() {
        this.server?.close();
        this.server = null;
        this.plugin.log("Offline Server stopped.");
    }
}

class DirectIpClient {
    public isOpen: boolean = false;
    private pollTimeout: number | null = null;
    private baseUrl: string;
    private headers: Record<string, string>;
    private pendingBytes: number = 0;
    private pollInterval: number = 1000;
    private consecutiveEmptyPolls: number = 0;

    constructor(private plugin: ObsidianDecentralizedPlugin, config: DirectIpConfig) {
        this.baseUrl = `http://${config.host}:${config.port}`;
        this.headers = {
            'Content-Type': 'application/json',
            'X-Device-Id': plugin.settings.deviceId,
            'X-Pin': config.pin,
        };
        this.startPolling();
        this.plugin.showNotice(`Connected to Offline Host at ${config.host}`, 'important', 3000);
    }
    
    getBufferedAmount(): number {
        return this.pendingBytes;
    }

    private async poll() {
        let hasMessages = false;
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/poll`,
                method: 'GET',
                headers: this.headers,
            });
            if (response.status === 200) {
                this.isOpen = true;
                const messages: any[] = response.json;
                if (messages && messages.length > 0) hasMessages = true;
                for (let msg of messages) {
                    if (msg.type === 'file-update' && msg.encoding === 'base64' && typeof msg.content === 'string') {
                        msg = { ...msg, content: base64ToArrayBuffer(msg.content), encoding: 'binary' } as FileUpdatePayload;
                    }
                    if (msg.type === 'file-chunk-data' && typeof (msg as any).data === 'string') {
                        (msg as any).data = base64ToArrayBuffer((msg as any).data);
                    }

                    const mockConn = {
                        send: (data: any) => this.send(data),
                        peer: 'direct-ip-host',
                        open: true
                    } as any;

                    this.plugin.handleRawIncomingData(msg, mockConn);
                }
            }
        } catch (e) {
            this.isOpen = false;
            this.plugin.log('Offline Poll Error:', e);
            this.plugin.updateStatus({ text: 'Host Unreachable', icon: 'server-off', state: 'error' });
        }
        
        if (hasMessages) {
            this.consecutiveEmptyPolls = 0;
            this.pollInterval = 100;
        } else {
            this.consecutiveEmptyPolls++;
            if (this.consecutiveEmptyPolls > 3) {
                this.pollInterval = Math.min(2000, Math.floor(this.pollInterval * 1.5));
            }
        }
        
        this.pollTimeout = window.setTimeout(() => this.poll(), Math.max(100, this.pollInterval));
    }

    async send(data: any) {
        let payloadToSend = data;
        
        if (data.type === 'file-update' && data.encoding === 'binary' && data.content instanceof ArrayBuffer) {
            payloadToSend = { ...data, content: arrayBufferToBase64(data.content), encoding: 'base64' };
        }
        if (data.type === 'file-chunk-data' && data.data instanceof ArrayBuffer) {
            payloadToSend = { ...data, data: arrayBufferToBase64(data.data) } as any;
        }

        const bodyStr = JSON.stringify(payloadToSend);
        this.pendingBytes += bodyStr.length;

        try {
            await requestUrl({
                url: `${this.baseUrl}/push`,
                method: 'POST',
                headers: this.headers,
                body: bodyStr,
            });
        } catch (e) {
            this.plugin.showNotice('Failed to send data to host.', 'error');
            this.plugin.log('Offline Push Error:', e);
            this.plugin.updateStatus({ text: 'Host Unreachable', icon: 'server-off', state: 'error' });
        } finally {
            this.pendingBytes = Math.max(0, this.pendingBytes - bodyStr.length);
        }
    }

    startPolling() {
        if (this.pollTimeout) clearTimeout(this.pollTimeout);
        this.poll();
    }

    stop() {
        this.isOpen = false;
        if (this.pollTimeout) clearTimeout(this.pollTimeout);
        this.pollTimeout = null;
        this.plugin.showNotice("Disconnected from Offline Host.", 'important', 3000);
    }
}


export default class ObsidianDecentralizedPlugin extends Plugin {
    settings: ObsidianDecentralizedSettings;
    peer: Peer | null = null;
    connections: Map<string, DataConnection> = new Map();
    clusterPeers: Map<string, PeerInfo> = new Map();
    lanDiscovery: ILANDiscovery;
    private fileLocks: Map<string, Promise<void>> = new Map();

    public syncState: SyncState = {
        isSyncing: false,
        currentPhase: SyncPhase.IDLE,
        peerId: null,
        pendingPulls: new Set(),
        allowedPulls: new Set(),
        activeBatches: new Map(),
        phaseStartTime: 0,
        phaseTimeoutHandle: null,
        missedPings: 0,
        filesTotal: 0,
        filesTransferred: 0,
        bytesTotal: 0,
        bytesTransferred: 0
    };
    private pendingSyncAcks: Map<string, { resolve: () => void, reject: (e: Error) => void }> = new Map();
    private lastSuccessfulMessageTime: Map<string, number> = new Map();

    private ignoreEvents: Map<string, number> = new Map();
    private statusBar: HTMLElement;
    private conflictCenter: ConflictCenter;
    public activeTransfers: Map<string, TransferStatus> = new Map();
    public joinPin: string | null = null;
    private clusterConnectionInterval: number | null = null;
    public pendingConnections: Set<string> = new Set();
    private pendingFileChunks: Map<string, { path: string, mtime: number, chunks: ArrayBuffer[], total: number, receivedCount: number, lastUpdated: number, fileHash: string, compressed?: boolean, versionVector?: VersionVector }> = new Map();
    
    // Timeouts and Keep-alives
    private syncIdleTimeout: number | null = null;
    private syncKeepAliveInterval: number | null = null;

    private syncQueue: { peerId: string | null, task?: SyncTask, data?: any, retries: number, priority: number }[] = [];
    private activeQueueTransfers: number = 0;
    private pendingAcks: Map<string, { resolve: () => void, reject: (e: Error) => void, peerId: string }> = new Map();
    private lastStatusUpdate: number = 0;
    private currentConcurrency = 8;
    private currentChunkSize = 512 * 1024;
    private targetChunkSize = 512 * 1024;
    private successfulTransfersSinceLastIncrease = 0;
    private peerInitRetryTimeout: number | null = null;
    private peerInitAttempts = 0;
    private debouncedHandleFileChange: (file: TAbstractFile) => void;
    public directIpServer: DirectIpServer | null = null;
    public directIpClient: DirectIpClient | null = null;
    private lastHeard: Map<string, number> = new Map();
    private statePath: string;
    public manualPingStart: Map<string, number> = new Map();
    private debouncedSaveState: () => void;
    public failedSyncs: FailedSync[] = [];
    private syncedHashes: Map<string, { hash: string, timestamp: number }> = new Map();

    // Bandwidth measurement & delta sync states
    private recentTransferSamples: { bytes: number, durationMs: number }[] = [];
    private currentBandwidthEstimate: number = 0;
    private lastSentContent: Map<string, { content: string, timestamp: number }> = new Map();

    // Two-Device Mode State
    public currentRole: DeviceRole | null = null;
    public twoDeviceState: TwoDeviceState = { fileVersions: {}, merkleTreeRoot: null };
    public tombstones: Record<string, number> = {};
    public currentSyncIsTwoDeviceMode: boolean | null = null;
    private syncDrainCallback: (() => void) | null = null;
    
    // Pull-based Sync State
    private pullRetries: Map<string, number> = new Map();
    private peerFileSizes: Record<string, number> = {};
    private localSyncComplete: Map<string, boolean> = new Map();
    private peerSyncComplete: Map<string, boolean> = new Map();
    
    // File Locking State
    public heldLocks: Map<string, { peerId: string, expiresAt: number }> = new Map();
    public remoteLocks: Map<string, { peerId: string, expiresAt: number }> = new Map();
    private pendingLockRequests: Map<string, { resolve: (granted: boolean) => void, timeout: number }> = new Map();
    
    // Real-time Editor Sync State
    public activeEditorLocks: Map<string, string> = new Map();
    private isApplyingRemoteEdit: boolean = false;
    private debouncedEditorChange: (editor: any, info: any) => void;

    async onload() {
        if (Platform.isMobile) {
            this.lanDiscovery = new DummyLANDiscovery();
        } else {
            this.lanDiscovery = new DesktopLANDiscovery();
        }

        this.statePath = `${this.manifest.dir}/state.json`;
        this.debouncedSaveState = debounce(this.saveState.bind(this), 1000);
        this.debouncedEditorChange = debounce(this.handleEditorChangeDebounced.bind(this), 200);

        await this.loadSettings();
        this.applyHideNativeSync();
        this.injectStatusBarStyles();
        this.statusBar = this.addStatusBarItem();
        this.addSettingTab(new ObsidianDecentralizedSettingTab(this.app, this));
        this.conflictCenter = new ConflictCenter(this.app, this);
        this.conflictCenter.registerRibbon();
        this.addRibbonIcon('users', 'Connect to a Peer', () => new ConnectionModal(this.app, this).open());
        this.addRibbonIcon('refresh-cw', 'Force Full Sync with Peer', () => {
            if (this.getConnectionMode() === 'direct-ip') {
                this.showNotice("Full Sync is not yet supported in Offline mode.", 'info');
                return;
            }
            if (this.connections.size === 0) { this.showNotice("No peers connected.", 'info'); return; }
            new SelectPeerModal(this.app, this.connections, this.clusterPeers, (peerId: string) => this.requestFullSyncFromPeer(peerId)).open();
        });

        this.debouncedHandleFileChange = debounce(this.handleFileChange.bind(this), this.settings.debounceDelay);
        this.registerEvent(this.app.vault.on('create', (file) => this.handleEvent(file)));
        this.registerEvent(this.app.vault.on('modify', (file) => this.handleEvent(file)));
        this.registerEvent(this.app.vault.on('delete', (file) => this.handleEvent(file)));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.handleRenameEvent(file, oldPath)));
        this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => this.handleEditorChange(editor, info)));

        this.initializeConnectionManager();
        this.startHeartbeat();
        this.registerInterval(window.setInterval(() => this.cleanupPendingChunks(), 60000));
        this.registerInterval(window.setInterval(() => this.retryFailedSyncs(), 60000));
        this.registerInterval(window.setInterval(() => this.cleanupLocks(), 5000));
        
        await this.loadState();
        this.pruneTombstones();
    }

    onunload() {
        this.peer?.destroy();
        this.lanDiscovery.stop();
        this.directIpServer?.stop();
        this.directIpClient?.stop();
        if (this.syncIdleTimeout) clearTimeout(this.syncIdleTimeout);
        if (this.syncKeepAliveInterval) clearInterval(this.syncKeepAliveInterval);
        if (this.peerInitRetryTimeout) clearTimeout(this.peerInitRetryTimeout);
        this.activeTransfers.clear();
        this.debouncedSaveState();
    }

    // --- Core Two-Device Infrastructure ---
    isTwoDeviceMode(): boolean {
        return this.settings.enableTwoDeviceOptimizations && this.connections.size === 1;
    }

    get twoDevicePeerId(): string | null {
        return this.isTwoDeviceMode() ? Array.from(this.connections.keys())[0] : null;
    }

    getMyRole(peerId: string): DeviceRole {
        return this.settings.deviceId < peerId ? 'primary' : 'secondary';
    }

    // --- Version Vectors ---
    incrementVersion(path: string) {
        if (!this.twoDeviceState.fileVersions[path]) this.twoDeviceState.fileVersions[path] = {};
        this.twoDeviceState.fileVersions[path][this.settings.deviceId] = (this.twoDeviceState.fileVersions[path][this.settings.deviceId] || 0) + 1;
        this.debouncedSaveState();
    }

    mergeVersions(local: VersionVector, remote: VersionVector): VersionVector {
        const merged: VersionVector = {};
        const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
        for (const k of keys) {
            merged[k] = Math.max(local[k] || 0, remote[k] || 0);
        }
        return merged;
    }

    isNewerThan(v1: VersionVector, v2: VersionVector): boolean {
        let hasGreater = false;
        const keys = new Set([...Object.keys(v1), ...Object.keys(v2)]);
        for (const k of keys) {
            const val1 = v1[k] || 0;
            const val2 = v2[k] || 0;
            if (val1 < val2) return false;
            if (val1 > val2) hasGreater = true;
        }
        return hasGreater;
    }

    // --- Merkle Tree Vault Diffing ---
    async buildMerkleTree(): Promise<MerkleNode> {
        const tree: MerkleNode = { hash: '', children: {} };
        const allFiles = this.app.vault.getAllLoadedFiles();
        
        for (const file of allFiles) {
            if (file instanceof TFile && this.isPathSyncable(file.path)) {
                let hash = this.syncedHashes.get(file.path)?.hash;
                if (!hash) {
                    const content = this.isBinary(file.extension) ? await this.app.vault.readBinary(file) : await this.app.vault.read(file);
                    hash = await this.getHash(content);
                    this.updateHashCache(file.path, hash);
                }
                
                const parts = file.path.split('/');
                let current = tree;
                for (let i = 0; i < parts.length; i++) {
                    const part = parts[i];
                    if (!current.children) current.children = {};
                    if (!current.children[part]) current.children[part] = { hash: '' };
                    current = current.children[part];
                    if (i === parts.length - 1) {
                        current.hash = hash;
                    }
                }
            }
        }

        const computeHashes = async (node: MerkleNode): Promise<string> => {
            if (!node.children || Object.keys(node.children).length === 0) return node.hash;
            const childKeys = Object.keys(node.children).sort();
            let combined = '';
            for (const k of childKeys) {
                combined += await computeHashes(node.children[k]);
            }
            node.hash = await this.getHash(combined);
            return node.hash;
        };

        await computeHashes(tree);
        this.twoDeviceState.merkleTreeRoot = tree;
        this.debouncedSaveState();
        return tree;
    }

    // --- State Management ---
    async loadState() {
        if (await this.app.vault.adapter.exists(this.statePath)) {
            try {
                const stateStr = await this.app.vault.adapter.read(this.statePath);
                const state = JSON.parse(stateStr);
                if (state.activeTransfers) {
                    for (const t of state.activeTransfers) {
                        this.activeTransfers.set(t.id, { ...t, status: 'paused' });
                    }
                    this.updateStatus();
                }
                if (state.failedSyncs) {
                    this.failedSyncs = state.failedSyncs;
                }
                if (state.tombstones) {
                    this.tombstones = state.tombstones;
                }
                if (state.twoDeviceState) {
                    this.twoDeviceState = state.twoDeviceState;
                    if (!this.twoDeviceState.fileVersions) this.twoDeviceState.fileVersions = {};
                }
                if (state.syncedHashes) {
                    const entries = Object.entries(state.syncedHashes);
                    for (const [p, d] of entries) {
                        this.syncedHashes.set(p, d as any);
                    }
                }
            } catch (e) {
                console.error("Failed to load state", e);
            }
        }
    }

    async saveState() {
        const state = {
            activeTransfers: Array.from(this.activeTransfers.values()),
            failedSyncs: this.failedSyncs,
            twoDeviceState: this.twoDeviceState,
            tombstones: this.tombstones,
            syncedHashes: Object.fromEntries(this.syncedHashes)
        };
        await this.app.vault.adapter.write(this.statePath, JSON.stringify(state, null, 2));
    }
    
    updateHashCache(path: string, hash: string) {
        this.syncedHashes.set(path, { hash, timestamp: Date.now() });
        if (this.syncedHashes.size > MAX_HASH_CACHE_SIZE) {
            let oldestPath = '';
            let oldestTime = Infinity;
            for (const [p, data] of this.syncedHashes.entries()) {
                if (data.timestamp < oldestTime) {
                    oldestTime = data.timestamp;
                    oldestPath = p;
                }
            }
            if (oldestPath) this.syncedHashes.delete(oldestPath);
        }
        this.debouncedSaveState();
    }

    pruneTombstones() {
        const retentionMs = (this.settings.tombstoneRetentionDays || 30) * 24 * 60 * 60 * 1000;
        const now = Date.now();
        let pruned = false;
        for (const [path, timestamp] of Object.entries(this.tombstones)) {
            if (now - timestamp > retentionMs) {
                delete this.tombstones[path];
                pruned = true;
            }
        }
        if (pruned) this.debouncedSaveState();
    }

    async loadSettings() { 
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); 
        if (!this.settings.deviceId) {
            this.settings.deviceId = `device-${Array.from(window.crypto.getRandomValues(new Uint8Array(4))).map(b => b.toString(16).padStart(2, '0')).join('')}`;
            await this.saveData(this.settings);
        }
        if (!this.settings.peerKeys) this.settings.peerKeys = {};
        this.applyHideNativeSync(); 
        if (this.settings.knownPeers) {
            this.settings.knownPeers.forEach(p => this.clusterPeers.set(p.deviceId, p));
        }
    }
    async saveSettings() { await this.saveData(this.settings); }
    async saveKnownPeers() { this.settings.knownPeers = Array.from(this.clusterPeers.values()); await this.saveSettings(); }

    public updateDebounceDelay() {
        this.debouncedHandleFileChange = debounce(this.handleFileChange.bind(this), this.settings.debounceDelay);
    }

    applyHideNativeSync() {
        if (this.settings.hideNativeSyncStatus) {
            document.body.classList.add('od-hide-native-sync');
        } else {
            document.body.classList.remove('od-hide-native-sync');
        }
    }

    public log(...args: any[]) { if (this.settings.verboseLogging) { console.log("Obsidian Decentralized:", ...args); } }

    private async runLocked(path: string, callback: () => Promise<void>) {
        const existingLock = this.fileLocks.get(path) || Promise.resolve();
        const newLock = existingLock.then(async () => {
            await callback();
        }).catch(err => {
            this.log(`Lock error for ${path}:`, err);
        });
        this.fileLocks.set(path, newLock);
        return newLock;
    }

    public showNotice(message: string, level: 'info' | 'verbose' | 'error' | 'important' | 'warning' = 'info', timeout?: number) {
        if (level === 'error') {
            new Notice(`[Error] ${message}`, timeout || 10000);
            return;
        }
        if (level === 'warning') {
            new Notice(`[Warning] ${message}`, timeout || 8000);
            return;
        }
        if (level === 'important') {
            new Notice(message, timeout);
            return;
        }
        if (!this.settings.showToasts) {
            return;
        }
        if (level === 'verbose' && !this.settings.verboseLogging) {
            return;
        }
        new Notice(message, timeout);
    }

    public getConflictStrategy() { 
        if (this.isTwoDeviceMode() && this.settings.enableTwoDeviceOptimizations) return 'role-based';
        return this.settings.syncMode === 'auto' ? 'create-conflict-file' : this.settings.conflictResolutionStrategy; 
    }
    public shouldSyncAllFileTypes() { return this.settings.syncMode === 'auto' ? true : this.settings.syncAllFileTypes; }
    public shouldSyncObsidianConfig() { return this.settings.syncMode === 'auto' ? true : this.settings.syncObsidianConfig; }
    public getConnectionMode() { return this.settings.syncMode === 'auto' ? 'peerjs' : this.settings.connectionMode; }
    private hasPeers(): boolean {
        if (this.getConnectionMode() === 'direct-ip') {
            return !!this.directIpClient || !!this.directIpServer;
        }
        return this.connections.size > 0;
    }

    private generateTransferId(path: string): string { return `${path}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
    
    // --- File System Events ---
    private handleEvent(file: TAbstractFile) { 
        if (this.shouldIgnoreEvent(file.path)) return; 
        if (!this.isPathSyncable(file.path)) return; 
        if (!this.hasPeers()) return; 
        
        if (this.isTwoDeviceMode() && this.remoteLocks.has(file.path)) {
            if (Date.now() < this.remoteLocks.get(file.path)!.expiresAt) {
                this.showNotice(`File ${file.name} is locked by peer. Sync delayed.`, 'warning');
            } else {
                this.remoteLocks.delete(file.path);
            }
        }
        
        if (!this.app.vault.getAbstractFileByPath(file.path)) { 
            this.handleFileDelete(file); 
            return; 
        } 
        this.debouncedHandleFileChange(file); 
    }
    
    private async handleFileChange(file: TAbstractFile) { 
        await this.runLocked(file.path, async () => { 
            this.log(`Processing debounced change for: ${file.path}`); 
            
            if (this.isTwoDeviceMode() && !this.heldLocks.has(file.path) && file instanceof TFile && !this.isBinary(file.extension)) {
                await this.requestLock(file.path);
            }

            if (file instanceof TFile) { 
                if (this.isTwoDeviceMode()) this.incrementVersion(file.path);
                this.syncedHashes.delete(file.path);
                await this.sendFileUpdate(file); 
            } else if (file instanceof TFolder) { 
                this.addToQueueTask(null, { taskType: 'send-folder-create', path: file.path });
            } 
        }); 
    }
    
    private async handleFileDelete(file: TAbstractFile) { 
        await this.runLocked(file.path, async () => { 
            if (this.shouldIgnoreEvent(file.path)) return; 
            if (!this.isPathSyncable(file.path)) return; 
            this.log(`Processing delete: ${file.path}`); 
            this.syncedHashes.delete(file.path);
            if (file instanceof TFile) { 
                if (this.isTwoDeviceMode()) this.incrementVersion(file.path); 
                this.tombstones[file.path] = Date.now(); 
                this.debouncedSaveState(); 
                this.addToQueueTask(null, { taskType: 'send-delete', path: file.path }); 
            } else if (file instanceof TFolder) { 
                this.broadcastData({ type: 'folder-delete', path: file.path, transferId: this.generateTransferId(file.path) }); 
            } 
        }); 
    }
    
    private async handleRenameEvent(file: TAbstractFile, oldPath: string) { 
        await this.runLocked(oldPath, async () => { 
            await this.runLocked(file.path, async () => { 
                if (this.shouldIgnoreEvent(oldPath) || this.shouldIgnoreEvent(file.path)) return; 
                if (!this.isPathSyncable(file.path) && !this.isPathSyncable(oldPath)) return; 
                if (!this.hasPeers()) return; 
                this.log(`Processing rename: ${oldPath} -> ${file.path}`); 
                this.ignoreNextEventForPath(file.path); 
                
                const cached = this.syncedHashes.get(oldPath);
                if (cached) {
                    this.syncedHashes.set(file.path, cached);
                    this.syncedHashes.delete(oldPath);
                    this.debouncedSaveState();
                }
                
                if (file instanceof TFile) { 
                    if (this.isTwoDeviceMode()) { this.incrementVersion(oldPath); this.incrementVersion(file.path); } 
                    this.addToQueueTask(null, { taskType: 'send-rename', oldPath, newPath: file.path }); 
                } else if (file instanceof TFolder) { 
                    this.broadcastData({ type: 'folder-rename', oldPath, newPath: file.path, transferId: this.generateTransferId(file.path) }); 
                } 
            }); 
        }); 
    }

    // --- Real-time Editor Sync ---
    private handleEditorChange(editor: any, info: any) {
        if (!this.isTwoDeviceMode() || !this.settings.enableRealtimeSync) return;
        
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) return;
        const path = view.file.path;

        if (this.isApplyingRemoteEdit || this.shouldIgnoreEvent(path)) return;

        if (!this.heldLocks.has(path)) {
            this.requestLock(path);
            this.sendData(this.twoDevicePeerId!, { type: 'editor-active', path });
        }

        this.debouncedEditorChange(editor, view.file);
    }

    private async handleEditorChangeDebounced(editor: any, file: TFile) {
        if (!this.isTwoDeviceMode() || !this.settings.enableRealtimeSync) return;
        const path = file.path;
        
        const currentText = editor.getValue();
        const cached = this.lastSentContent.get(path);
        
        if (cached) {
            const dmp = new DiffMatchPatch();
            const patches = dmp.patch_make(cached.content, currentText);
            if (patches.length > 0) {
                const patchText = dmp.patch_toText(patches);
                const payload: EditorDeltaPayload = { type: 'editor-delta', path, patches: patchText };
                this.sendData(this.twoDevicePeerId!, payload);
            }
        }
        this.lastSentContent.set(path, { content: currentText, timestamp: Date.now() });
    }

    // --- PSK Encryption ---
    async generatePSK(): Promise<string> {
        const key = await window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
        const exported = await window.crypto.subtle.exportKey('raw', key);
        return arrayBufferToBase64(exported);
    }

    async encryptPayload(data: any, pskBase64: string): Promise<any> {
        try {
            const keyData = base64ToArrayBuffer(pskBase64);
            const key = await window.crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['encrypt']);
            const iv = window.crypto.getRandomValues(new Uint8Array(12));
            const encoded = new TextEncoder().encode(JSON.stringify(data));
            const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
            
            return {
                type: 'encrypted',
                iv: arrayBufferToBase64(iv.buffer),
                data: arrayBufferToBase64(encrypted)
            };
        } catch (e) {
            this.log("Encryption failed, falling back to plaintext", e);
            return data;
        }
    }

    async decryptPayload(encryptedPayload: any, pskBase64: string): Promise<any> {
        try {
            const keyData = base64ToArrayBuffer(pskBase64);
            const key = await window.crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['decrypt']);
            const iv = base64ToArrayBuffer(encryptedPayload.iv);
            const data = base64ToArrayBuffer(encryptedPayload.data);
            
            const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, data);
            const decoded = new TextDecoder().decode(decrypted);
            return JSON.parse(decoded);
        } catch (e) {
            this.log("Decryption failed", e);
            throw new Error("Decryption failed");
        }
    }

    // --- Communication Layer ---
    broadcastData(data: SyncData) { this.addToQueue(null, data); }
    sendData(peerId: string, data: SyncData) { this.addToQueue(peerId, data); }
    
    private computePriority(data: SyncData): number {
        if (data.type === 'editor-delta' || data.type === 'editor-active' || data.type.startsWith('lock-')) return 1000000; 
        if (data.type === 'folder-create' || data.type === 'folder-delete' || data.type === 'folder-rename') return 100000;
        if (data.type === 'file-delete' || data.type === 'file-rename' || data.type === 'file-delta') return 50000;
        if (data.type === 'file-update') {
            const size = data.content instanceof ArrayBuffer ? data.content.byteLength : (typeof data.content === 'string' ? data.content.length : 0);
            return Math.max(0, 10000 - size);
        }
        return -1;
    }
    
    private computePriorityTask(task: SyncTask): number {
        if (task.taskType === 'send-folder-create' || task.taskType === 'send-delete' || task.taskType === 'send-rename') return 100000;
        return 50000;
    }

    private addToQueue(peerId: string | null, data: SyncData) { 
        const priority = this.computePriority(data);
        const item = { peerId, data, retries: 0, priority };
        let low = 0, high = this.syncQueue.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (this.syncQueue[mid].priority < priority) {
                high = mid;
            } else {
                low = mid + 1;
            }
        }
        this.syncQueue.splice(low, 0, item);
        this.processQueue(); 
    }
    
    private addToQueueTask(peerId: string | null, task: SyncTask) { 
        const priority = this.computePriorityTask(task);
        const item = { peerId, task, retries: 0, priority };
        let low = 0, high = this.syncQueue.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (this.syncQueue[mid].priority < priority) high = mid;
            else low = mid + 1;
        }
        this.syncQueue.splice(low, 0, item);
        this.processQueue(); 
    }

    public getQueuePressure(): number {
        return Math.min(1, (this.syncQueue.length + this.activeQueueTransfers) / MAX_QUEUE_DEPTH);
    }

    public transitionToPhase(newPhase: SyncPhase) {
        this.log(`Sync phase transition: ${this.syncState.currentPhase} -> ${newPhase}`);
        this.syncState.currentPhase = newPhase;
        this.syncState.phaseStartTime = Date.now();
        if (this.syncState.phaseTimeoutHandle) { clearTimeout(this.syncState.phaseTimeoutHandle); this.syncState.phaseTimeoutHandle = null; }
        
        let timeoutMs = 0;
        if (newPhase === SyncPhase.REQUESTING) timeoutMs = REQUESTING_TIMEOUT;
        else if (newPhase === SyncPhase.PLANNING) timeoutMs = PLANNING_TIMEOUT;
        else if (newPhase === SyncPhase.TRANSFERRING) timeoutMs = BATCH_TIMEOUT;
        else if (newPhase === SyncPhase.COMPLETING) timeoutMs = COMPLETING_TIMEOUT;

        if (timeoutMs > 0) {
            this.syncState.phaseTimeoutHandle = window.setTimeout(() => {
                this.abortSync(new SyncError(SyncErrorCategory.TIMEOUT_ERROR, `Sync timed out during ${newPhase}.`, false, "The peer may be busy or have a slow connection. Try again later."));
            }, timeoutMs);
        }
        this.updateStatus();
    }

    public isConnectionHealthy(peerId: string): boolean {
        const conn = this.connections.get(peerId);
        if (!conn || !conn.open) return false;
        const lastSuccess = this.lastSuccessfulMessageTime.get(peerId);
        if (lastSuccess && (Date.now() - lastSuccess > 35000)) return false;
        return true;
    }

    public async sendSyncMessage(peerId: string, data: any, retryCount = 0): Promise<void> {
        if (!this.isConnectionHealthy(peerId)) {
            throw new SyncError(SyncErrorCategory.CONNECTION_ERROR, `Connection to ${peerId} is unhealthy.`, true, "Check network connection.");
        }
        const messageId = this.generateTransferId(data.type);
        const payload = { ...data, messageId };
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(async () => {
                this.pendingSyncAcks.delete(messageId);
                if (retryCount < 3) {
                    this.log(`Timeout sending ${data.type}, retrying (${retryCount + 1}/3)...`);
                    try {
                        await this.sendSyncMessage(peerId, data, retryCount + 1);
                        resolve();
                    } catch (e) { reject(e); }
                } else {
                    reject(new SyncError(SyncErrorCategory.TIMEOUT_ERROR, `Failed to deliver ${data.type} after 3 retries.`, false, "Check peer connection."));
                }
            }, 30000);
            
            this.pendingSyncAcks.set(messageId, { resolve: () => { clearTimeout(timeout); resolve(); }, reject: (e) => { clearTimeout(timeout); reject(e); } });
            this.sendData(peerId, payload as any);
        });
    }

    public abortSync(error?: SyncError) {
        if (!this.syncState.isSyncing) return;
        this.transitionToPhase(SyncPhase.ABORTING);
        this.syncState.isSyncing = false;
        this.currentSyncIsTwoDeviceMode = null;
        this.syncDrainCallback = null;
        this.syncQueue = [];
        this.activeTransfers.clear();
        this.syncState.pendingPulls.clear();
        this.syncState.allowedPulls.clear();
        this.syncState.activeBatches.clear();
        this.localSyncComplete.clear();
        this.peerSyncComplete.clear();
        this.pullRetries.clear();
        this.syncState.peerId = null;
        if (this.syncIdleTimeout) { clearTimeout(this.syncIdleTimeout); this.syncIdleTimeout = null; }
        if (this.syncKeepAliveInterval) { clearInterval(this.syncKeepAliveInterval); this.syncKeepAliveInterval = null; }
        if (this.syncState.phaseTimeoutHandle) { clearTimeout(this.syncState.phaseTimeoutHandle); this.syncState.phaseTimeoutHandle = null; }
        
        const errorMessage = error ? error.message : "Sync aborted manually.";
        this.pendingAcks.forEach(ack => ack.reject(new Error(errorMessage)));
        this.pendingAcks.clear();
        this.pendingSyncAcks.forEach(ack => ack.reject(new Error(errorMessage)));
        this.pendingSyncAcks.clear();
        
        if (error) {
            this.showNotice(`Sync failed: ${error.message}\nAction: ${error.suggestedAction}`, 'error', 10000);
            this.log(`Sync aborted [${error.category}]: ${error.message}`);
        } else {
            this.showNotice(`Sync aborted.`, 'warning', 5000);
            this.log(`Sync aborted manually.`);
        }
        
        this.syncState.currentPhase = SyncPhase.IDLE;
        this.updateStatus();
    }

    public getConcurrencyLimit() { 
        if (this.settings.maximumConcurrentTransfers) return this.settings.maximumConcurrentTransfers;
        return this.currentConcurrency; 
    }
    
    public getChunkSize() { 
        if (this.settings.chunkSize) return this.settings.chunkSize;
        if (this.getConnectionMode() === 'direct-ip') return 2 * 1024 * 1024; // 2MB for direct-ip
        return this.currentChunkSize; 
    }

    private recordTransferSample(bytes: number, durationMs: number) {
        if (durationMs <= 0 || bytes <= 0) return;
        this.recentTransferSamples.push({ bytes, durationMs });
        if (this.recentTransferSamples.length > MAX_BANDWIDTH_SAMPLES) {
            this.recentTransferSamples.shift();
        }
        
        let totalBytes = 0;
        let totalMs = 0;
        for (const sample of this.recentTransferSamples) {
            totalBytes += sample.bytes;
            totalMs += sample.durationMs;
        }
        
        this.currentBandwidthEstimate = (totalBytes / totalMs) * 1000;
        this.adaptChunkSize();
    }

    private adaptChunkSize() {
        if (this.currentBandwidthEstimate > 0) {
            const targetSize = Math.floor(this.currentBandwidthEstimate * (TARGET_CHUNK_TIME_MS / 1000));
            this.targetChunkSize = Math.max(MIN_CHUNK_SIZE, Math.min(MAX_CHUNK_SIZE, targetSize));
        }
    }

    private reportTransferResult(success: boolean) {
        if (success) {
            this.successfulTransfersSinceLastIncrease++;
            if (this.successfulTransfersSinceLastIncrease >= this.currentConcurrency) {
                if (this.currentConcurrency < 32) {
                    this.currentConcurrency++;
                    this.log(`Network stable. Increasing concurrency to ${this.currentConcurrency}`);
                }
                if (this.currentChunkSize < this.targetChunkSize && this.getConnectionMode() !== 'direct-ip') {
                    this.currentChunkSize = Math.min(this.targetChunkSize, Math.floor(this.currentChunkSize * 1.5));
                    this.log(`Network stable. Increasing chunk size to ${this.currentChunkSize}`);
                }
                this.successfulTransfersSinceLastIncrease = 0;
            }
        } else {
            const newLimit = Math.max(1, Math.floor(this.currentConcurrency * 0.7));
            if (newLimit < this.currentConcurrency) {
                this.currentConcurrency = newLimit;
                this.log(`Network issues detected. Decreasing concurrency to ${this.currentConcurrency}`);
            }
            if (this.getConnectionMode() !== 'direct-ip') {
                const newChunkSize = Math.max(MIN_CHUNK_SIZE, Math.floor(this.currentChunkSize * 0.75));
                if (newChunkSize < this.currentChunkSize) {
                    this.currentChunkSize = newChunkSize;
                    this.log(`Network issues. Decreasing chunk size to ${this.currentChunkSize}`);
                }
            }
            this.successfulTransfersSinceLastIncrease = 0;
        }
    }

    resetIdleTimeout() {
        if (this.syncIdleTimeout) clearTimeout(this.syncIdleTimeout);
        if (this.syncState.isSyncing) {
            this.syncIdleTimeout = window.setTimeout(() => {
                this.abortSync(new SyncError(SyncErrorCategory.TIMEOUT_ERROR, "Sync idle timeout reached. Connection may have dropped.", false, "Check network connection."));
            }, this.settings.idleTimeoutMs || 30000);
        }
    }

    private processQueue() {
        this.updateStatus();
        while (this.activeQueueTransfers < this.getConcurrencyLimit() && this.syncQueue.length > 0) {
            const item = this.syncQueue.shift();
            if (item) {
                this.activeQueueTransfers++;
                this.processQueueItem(item).finally(() => {
                    if (this.activeQueueTransfers > 0) this.activeQueueTransfers--;
                    this.processQueue();
                });
            }
        }
        if (this.activeQueueTransfers === 0 && this.syncQueue.length === 0 && this.syncDrainCallback) {
            this.syncDrainCallback();
            this.syncDrainCallback = null;
        }
    }

    private async processQueueItem(item: { peerId: string | null, task?: SyncTask, data?: any, retries: number, priority: number }) {
        let transferId: string | undefined;
        let isPaused = false;
        let success = false;
        const startTime = Date.now();

        try {
            let { peerId } = item;
            
            if (item.task) {
                const task = item.task;
                if (task.taskType === 'send-file') {
                    const file = this.app.vault.getAbstractFileByPath(task.path);
                    if (file instanceof TFile) {
                        const now = Date.now();
                        for (const [p, cacheData] of this.lastSentContent.entries()) {
                            if (now - cacheData.timestamp > 10 * 60 * 1000) this.lastSentContent.delete(p);
                        }
                        
                        let content: string | ArrayBuffer = this.isBinary(file.extension) ? await this.app.vault.readBinary(file) : await this.app.vault.read(file);
                        let encoding: 'utf8' | 'binary' | 'base64' = this.isBinary(file.extension) ? 'binary' : 'utf8';
                        let hash = '';
                        try { hash = await this.getHash(content); } catch(e) {}
                        
                        if (!task.forceFull && this.syncedHashes.get(file.path)?.hash === hash) {
                            this.log(`Ignoring echo event for ${file.path}`);
                            success = true;
                            return;
                        }
                        if (hash) this.updateHashCache(file.path, hash);
                        
                        let isCompressedText = false;
                        let vv = this.isTwoDeviceMode() ? this.twoDeviceState.fileVersions[file.path] : undefined;
                        
                        if (!this.isBinary(file.extension)) {
                            if (this.settings.enableDeltaSync && !task.forceFull) {
                                const cached = this.lastSentContent.get(file.path);
                                const newText = content as string;
                                if (cached) {
                                    const dmp = new DiffMatchPatch();
                                    const patches = dmp.patch_make(cached.content, newText);
                                    const patchText = dmp.patch_toText(patches);
                                    if (patchText.length < newText.length * (this.settings.deltaSyncThreshold / 100)) {
                                        const baseHash = await this.getHash(cached.content);
                                        item.data = {
                                            type: 'file-delta',
                                            path: file.path,
                                            mtime: file.stat.mtime,
                                            patches: patchText,
                                            baseHash,
                                            versionVector: vv,
                                            transferId: this.generateTransferId(file.path)
                                        };
                                        this.lastSentContent.set(file.path, { content: newText, timestamp: Date.now() });
                                    }
                                }
                                if (!item.data) this.lastSentContent.set(file.path, { content: newText, timestamp: Date.now() });
                            }
                            
                            if (!item.data && this.settings.enableCompression) {
                                content = compressText(content as string);
                                encoding = 'binary';
                                isCompressedText = true;
                            }
                        }
                        
                        if (!item.data) {
                            if (typeof content === 'string' && content.length > this.getChunkSize()) {
                                content = new TextEncoder().encode(content).buffer;
                                encoding = 'binary';
                            }
                            item.data = { type: 'file-update', path: file.path, content, mtime: file.stat.mtime, encoding, transferId: this.generateTransferId(file.path), fileHash: hash, compressed: isCompressedText, versionVector: vv };
                        }
                    } else {
                        success = true;
                        return;
                    }
                } else if (task.taskType === 'send-delete') {
                    item.data = { type: 'file-delete', path: task.path, transferId: this.generateTransferId(task.path) };
                } else if (task.taskType === 'send-folder-create') {
                    item.data = { type: 'folder-create', path: task.path, transferId: this.generateTransferId(task.path) };
                } else if (task.taskType === 'send-rename') {
                    let vv = this.isTwoDeviceMode() ? this.twoDeviceState.fileVersions[task.newPath] : undefined;
                    item.data = { type: 'file-rename', oldPath: task.oldPath, newPath: task.newPath, transferId: this.generateTransferId(task.newPath), versionVector: vv };
                }
            }
            
            const data = item.data;
            if (!data) return;
            transferId = data.transferId;

            if (!peerId && (data.type === 'file-update' || data.type === 'file-delta')) {
                let connectedPeers: string[] = [];
                if (this.getConnectionMode() === 'direct-ip') {
                    if (this.directIpServer) connectedPeers = this.directIpServer.getClients();
                    else if (this.directIpClient && this.directIpClient.isOpen) connectedPeers = ['direct-ip-host'];
                } else {
                    connectedPeers = Array.from(this.connections.keys());
                }

                if (connectedPeers.length === 0) {
                    success = true;
                    return;
                }
                
                peerId = connectedPeers[0];
                
                for (let i = 1; i < connectedPeers.length; i++) {
                    const newData = { ...data, transferId: this.generateTransferId(data.path) };
                    this.addToQueue(connectedPeers[i], newData);
                }
            }

            const isChunkedTransfer = data.type === 'file-update' && data.content instanceof ArrayBuffer && data.content.byteLength > this.getChunkSize();

            if (isChunkedTransfer) {
                const fileData = data as FileUpdatePayload;
                if (!transferId) throw new Error("Transfer ID missing for chunked transfer");
                
                if (peerId) {
                    const ackPromise = new Promise<void>((resolve, reject) => {
                        const timeout = setTimeout(() => reject(new Error(`Transfer ${transferId} timed out`)), 300000);
                        this.pendingAcks.set(transferId!, {
                            resolve: () => { clearTimeout(timeout); resolve(); },
                            reject: (e) => { clearTimeout(timeout); reject(e); },
                            peerId: peerId!
                        });
                    });

                    await this.sendFileInChunks(peerId, fileData.path, fileData.mtime, fileData.content as ArrayBuffer, transferId!, 0, fileData.compressed, fileData.versionVector);
                    await ackPromise;
                    this.log(`Chunked transfer ${transferId} for ${fileData.path} completed successfully.`);
                    
                    // Dereference to allow GC
                    fileData.content = null as any;
                    item.data = null as any;
                }
            } else {
                let finalPayload = data;
                if (this.settings.enableEncryption && peerId && this.settings.peerKeys[peerId]) {
                    finalPayload = await this.encryptPayload(data, this.settings.peerKeys[peerId]);
                }

                if ((data.type === 'file-update' || data.type === 'file-delta') && peerId) {
                    const ackPromise = new Promise<void>((resolve, reject) => {
                        const timeout = setTimeout(() => reject(new Error(`Transfer ${transferId} timed out`)), 60000);
                        this.pendingAcks.set(transferId!, {
                            resolve: () => { clearTimeout(timeout); resolve(); },
                            reject: (e) => { clearTimeout(timeout); reject(e); },
                            peerId: peerId!
                        });
                    });

                    if (this.getConnectionMode() === 'direct-ip') {
                        if (this.directIpClient) this.directIpClient.send(finalPayload);
                        else if (this.directIpServer) this.directIpServer.sendTo(peerId, finalPayload);
                    } else {
                        const conn = this.connections.get(peerId);
                        if (conn?.open) conn.send(finalPayload);
                        else throw new Error("Connection closed");
                    }
                    await ackPromise;
                    
                    if (data.type === 'file-update') {
                        (data as FileUpdatePayload).content = null as any;
                        item.data = null as any;
                    }
                } else 
                if (this.getConnectionMode() === 'direct-ip') {
                    if (this.directIpClient) this.directIpClient.send(finalPayload);
                    else if (this.directIpServer) this.directIpServer.send(finalPayload);
                } else {
                    const peersToSend = peerId ? [peerId] : Array.from(this.connections.keys());
                    peersToSend.forEach(async pId => {
                        let pPayload = data;
                        if (this.settings.enableEncryption && this.settings.peerKeys[pId]) {
                            pPayload = await this.encryptPayload(data, this.settings.peerKeys[pId]);
                        }
                        const conn = this.connections.get(pId);
                        if (conn?.open) { conn.send(pPayload); }
                    });
                }
            }
            success = true;
            this.resetIdleTimeout();
            
            let bytesTransferred = 0;
            if (data.type === 'file-update') {
                bytesTransferred = data.content instanceof ArrayBuffer ? data.content.byteLength : (typeof data.content === 'string' ? data.content.length : 0);
            } else if (data.type === 'file-delta') {
                bytesTransferred = (data as FileDeltaPayload).patches.length;
            }
            if (bytesTransferred > 0) {
                this.recordTransferSample(bytesTransferred, Date.now() - startTime);
            }

        } catch (e) {
            if (e.message === 'Paused') {
                this.log(`Transfer ${transferId} paused due to connection loss.`);
                isPaused = true;
                return;
            }
            if (e instanceof Error && e.message.includes('IntegrityError')) {
                this.log(`Integrity failure for transfer ${transferId}.`);
                if (item.data && item.data.type === 'file-delta') {
                    const file = this.app.vault.getAbstractFileByPath(item.data.path);
                    if (file instanceof TFile) {
                        this.sendFileUpdate(file, item.peerId || undefined, true);
                    }
                    return;
                } else {
                    this.log(`Re-queueing.`);
                }
            } else {
                console.error(`Error processing queue item ${transferId}:`, e);
            }
            
            if (item && item.retries < 3) {
                this.log(`Retrying transfer ${transferId} (Attempt ${item.retries + 1}/3)`);
                item.retries++;
                const priority = item.priority;
                let low = 0, high = this.syncQueue.length;
                while (low < high) {
                    const mid = (low + high) >>> 1;
                    if (this.syncQueue[mid].priority < priority) high = mid;
                    else low = mid + 1;
                }
                this.syncQueue.splice(low, 0, item);
                await new Promise(resolve => setTimeout(resolve, 1000));
            } else if (item) {
                const taskPath = item.task ? (item.task.taskType === 'send-rename' ? item.task.newPath : item.task.path) : undefined;
                const path = item.data?.path || taskPath || 'an item';
                this.showNotice(`File transfer failed permanently for ${path}.`, 'error', 8000);
                if (this.syncState.isSyncing) this.abortSync(new SyncError(SyncErrorCategory.CONNECTION_ERROR, "Transfer failed permanently.", false, "Check peer connection."));
                
                if (item.data && (item.data.type === 'file-update' || item.data.type === 'file-delete' || item.data.type === 'file-delta')) {
                    const existing = this.failedSyncs.find(f => f.path === item.data.path && f.peerId === item.peerId && f.type === item.data.type);
                    if (!existing) {
                        this.failedSyncs.push({
                            path: item.data.path,
                            peerId: item.peerId,
                            timestamp: Date.now(),
                            type: item.data.type as any,
                            reason: e instanceof Error ? e.message : String(e),
                            retryCount: 0
                        });
                    } else {
                        existing.timestamp = Date.now();
                        existing.reason = e instanceof Error ? e.message : String(e);
                    }
                    this.debouncedSaveState();
                }
                // Dereference
                if (item.data && item.data.type === 'file-update') item.data.content = null;
                item.data = null;
            }
        } finally {
            let isFinal = false;
            if (success) {
                isFinal = true;
            } else if (!isPaused && (!item || item.retries >= 3)) {
                isFinal = true;
            }

            if (transferId && !isPaused) {
                this.reportTransferResult(success);
                
                if (success) {
                    const taskPath = item.task ? (item.task.taskType === 'send-rename' ? item.task.newPath : item.task.path) : undefined;
                    const path = item.data?.path || taskPath;
                    if (path) {
                        for (let i = this.failedSyncs.length - 1; i >= 0; i--) {
                            const f = this.failedSyncs[i];
                            if (f.path === path && f.peerId === item.peerId) {
                                if (item.data && (item.data.type === 'file-update' || item.data.type === 'file-delta') && 
                                    (f.type === 'file-update' || f.type === 'file-delta')) {
                                    this.failedSyncs.splice(i, 1);
                                } else if (item.data && item.data.type === f.type) {
                                    this.failedSyncs.splice(i, 1);
                                }
                            }
                        }
                    }
                }

                if (this.pendingAcks.has(transferId)) {
                    this.pendingAcks.get(transferId)!.resolve();
                    this.pendingAcks.delete(transferId);
                }
                this.activeTransfers.delete(transferId);
                this.debouncedSaveState();
            }

            if (isFinal) {
                const taskPath = item.task ? (item.task.taskType === 'send-rename' ? item.task.newPath : item.task.path) : undefined;
                const path = item.data?.path || taskPath;
                if (item.task && (item.task as any).batchId) {
                    this.recordBatchTaskCompletion((item.task as any).batchId, path, success);
                }
            }

            this.updateStatus();
        }
    }

    async retryFailedSyncs() {
        if (this.failedSyncs.length === 0) return;
        if (!this.hasPeers()) return;

        const now = Date.now();
        let changed = false;

        for (let i = this.failedSyncs.length - 1; i >= 0; i--) {
            const fail = this.failedSyncs[i];
            const backoffMs = 30000 * Math.pow(2, fail.retryCount || 0);

            if (now - fail.timestamp > backoffMs) {
                if ((fail.retryCount || 0) >= 5) {
                    this.failedSyncs.splice(i, 1);
                    changed = true;
                    continue;
                }

                fail.retryCount = (fail.retryCount || 0) + 1;
                fail.timestamp = now;
                changed = true;

                this.log(`Retrying failed sync: ${fail.path} (Attempt ${fail.retryCount})`);
                
                if (fail.type === 'file-update' || fail.type === 'file-delta') {
                    const file = this.app.vault.getAbstractFileByPath(fail.path);
                    if (file instanceof TFile) {
                        this.sendFileUpdate(file, fail.peerId || undefined, true);
                    } else {
                        this.failedSyncs.splice(i, 1);
                    }
                } else if (fail.type === 'file-delete') {
                     if (!this.app.vault.getAbstractFileByPath(fail.path)) {
                         this.addToQueueTask(fail.peerId || null, { taskType: 'send-delete', path: fail.path });
                     } else {
                         this.failedSyncs.splice(i, 1);
                     }
                }
            }
        }
        if (changed) this.debouncedSaveState();
    }

    public reinitializeConnectionManager() {
        if (this.peerInitRetryTimeout) clearTimeout(this.peerInitRetryTimeout);
        this.peer?.destroy();
        this.directIpClient?.stop();
        this.directIpServer?.stop();
        this.directIpClient = null;
        this.directIpServer = null;
        this.connections.clear();
        this.activeTransfers.clear();
        this.initializeConnectionManager();
    }

    initializeConnectionManager(onOpen?: (id: string) => void) {
        if (this.peerInitRetryTimeout) clearTimeout(this.peerInitRetryTimeout);
        
        if (!Platform.isMobile) {
            this.lanDiscovery.startBroadcasting(this.getMyPeerInfo());
            this.lanDiscovery.startListening();
        }

        if (this.getConnectionMode() === 'peerjs') {
            this.initializePeer(onOpen);
        } else {
            this.updateStatus();
        }
    }

    initializePeer(onOpen?: (id: string) => void) {
        if (this.peer && !this.peer.destroyed) { if (onOpen && !this.peer.disconnected) { onOpen(this.peer.id); } return; }
        if (this.peerInitRetryTimeout) clearTimeout(this.peerInitRetryTimeout);
        this.peer?.destroy();
        this.updateStatus({ text: 'Connecting...', icon: 'plug', spin: true, state: 'loading' });

        let peerOptions: PeerJSOption = {};
        if (this.settings.useCustomPeerServer) { peerOptions = { ...this.settings.customPeerServerConfig }; }

        this.log(`Attempting to connect to PeerJS server (Attempt: ${this.peerInitAttempts + 1})...`);
        try {
            this.peer = new Peer(this.settings.deviceId, peerOptions);
        } catch (e) {
            this.handlePeerError(e);
            return;
        }

        const connectionTimeout = setTimeout(() => { this.log('PeerJS connection timed out.'); this.handlePeerError(new Error("Connection timed out")); }, 15000);

        this.peer.on('open', (id) => {
            clearTimeout(connectionTimeout);
            this.peerInitAttempts = 0;
            this.log(`PeerJS connection open. ID: ${id}`);
            this.showNotice(`Decentralized Sync network is online.`, 'verbose', 3000);
            this.updateStatus();
            this.tryToConnectToClusterPeers();
            if (!Platform.isMobile) {
                this.lanDiscovery.startBroadcasting(this.getMyPeerInfo());
            }
            onOpen?.(id);
        });

        this.peer.on('connection', (conn) => { this.log("Incoming PeerJS connection from:", conn.peer); this.setupConnection(conn); });
        this.peer.on('error', (err) => { clearTimeout(connectionTimeout); this.handlePeerError(err); });
        this.peer.on('disconnected', () => { this.showNotice('Sync network disconnected. Attempting to reconnect...', 'important'); this.updateStatus({ text: 'Reconnecting...', icon: 'plug', spin: true, state: 'loading' }); });
        this.peer.on('close', () => { this.showNotice('Sync connection closed permanently.', 'important'); this.handlePeerError(new Error("Peer closed.")); });
    }

    private handlePeerError(err: any) {
        console.error("PeerJS Error:", err);
        
        if (err.type === 'peer-unavailable') {
            this.log("A requested peer is currently offline or unavailable.");
            return;
        }

        this.peer?.destroy();
        this.peer = null;
        this.connections.forEach(conn => conn.close());
        this.connections.clear();
        this.activeTransfers.clear();
    
        let userMessage = 'Connection Failed';
        switch(err.type) {
            case 'network': userMessage = 'Network Error. Check internet connection.'; break;
            case 'server-error': userMessage = 'Server Error. Try again later.'; break;
            case 'disconnected': userMessage = 'Disconnected from server.'; break;
        }
        this.updateStatus({ text: `Error: ${userMessage}`, icon: 'alert-triangle', state: 'error' });
    
        this.peerInitAttempts++;
        const backoff = Math.min(30000, this.peerInitAttempts * 2000);
        this.showNotice(`Sync connection failed. Retrying in ${backoff / 1000}s...`, 'info');
    
        if (this.peerInitRetryTimeout) clearTimeout(this.peerInitRetryTimeout);
        this.peerInitRetryTimeout = window.setTimeout(() => {
            this.updateStatus({ text: 'Retrying connection...', icon: 'refresh-cw', spin: true, state: 'loading' });
            this.initializePeer();
        }, backoff);
    }

    setupConnection(conn: DataConnection, pin?: string) {
        this.pendingConnections.add(conn.peer);
        conn.on('open', () => {
            this.pendingConnections.delete(conn.peer);
            this.log("DataConnection open with:", conn.peer);
            conn.send({ type: 'handshake', peerInfo: this.getMyPeerInfo(), pin });
            
            if (this.isTwoDeviceMode()) {
                this.currentRole = this.getMyRole(conn.peer);
                conn.send({ type: 'role-announcement', role: this.currentRole, deviceId: this.settings.deviceId });
            }
            
            this.resumeTransfers(conn.peer);
        });
        conn.on('data', async (raw: any) => {
            this.handleRawIncomingData(raw, conn);
        });
        conn.on('close', () => {
            this.pendingConnections.delete(conn.peer);
            const peerId = conn.peer;
            this.log("DataConnection closed with:", peerId);
            this.connections.delete(peerId);
            this.lastHeard.delete(peerId);
            this.manualPingStart.delete(peerId);
            
            // Clear remote locks from this peer
            for (const [path, lock] of this.remoteLocks.entries()) {
                if (lock.peerId === peerId) this.remoteLocks.delete(path);
            }

            for (const [id, transfer] of this.activeTransfers.entries()) {
                if (transfer.peerId === peerId && transfer.direction === 'download') {
                    this.activeTransfers.delete(id);
                }
            }
            this.updateStatus();

            if (this.pendingAcks.size > 0) {
                for (const [id, ack] of this.pendingAcks.entries()) {
                    if (ack.peerId === peerId) {
                        ack.reject(new Error("Connection closed"));
                        this.pendingAcks.delete(id);
                    }
                }
            }
            this.log(`Peer disconnected: ${peerId}`);
            if (peerId === this.settings.companionPeerId) {
                this.showNotice(`Paired Device disconnected. Will try to reconnect automatically.`, 'important');
            }
            this.log("Connection closed, ensuring connection attempts continue.");
            this.tryToConnectToClusterPeers();
        });
        conn.on('error', (err) => { 
            this.pendingConnections.delete(conn.peer);
            console.error(`Connection error with ${conn.peer}:`, err); 
            this.showNotice(`Connection error with a peer.`, 'error'); 
        });
    }

    async handleRawIncomingData(raw: any, conn: DataConnection) {
        let data = raw;
        if (raw && raw.type === 'encrypted') {
            if (this.settings.peerKeys[conn.peer]) {
                try {
                    data = await this.decryptPayload(raw, this.settings.peerKeys[conn.peer]);
                } catch(e) {
                    this.log("Decryption failed, ignoring message", e);
                    return;
                }
            } else {
                this.log("Received encrypted message but no PSK found for peer", conn.peer);
                return;
            }
        }
        this.processIncomingData(data, conn);
    }
    
    async resumeTransfers(peerId: string) {
        const transfersToResume = Array.from(this.activeTransfers.values())
            .filter(t => t.peerId === peerId && t.status === 'paused' && t.direction === 'upload');

        for (const t of transfersToResume) {
            this.log(`Resuming transfer ${t.id} to ${peerId}`);
            t.status = 'active';
            this.updateStatus();
            
            const file = this.app.vault.getAbstractFileByPath(t.path);
            if (file instanceof TFile) {
                let content: ArrayBuffer;
                if (t.compressed) {
                    const textContent = await this.app.vault.read(file);
                    content = compressText(textContent);
                } else {
                    content = await this.app.vault.readBinary(file);
                }
                
                const ackPromise = new Promise<void>((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error(`Transfer ${t.id} timed out`)), 60000);
                    this.pendingAcks.set(t.id, {
                        resolve: () => { clearTimeout(timeout); resolve(); },
                        reject: (e) => { clearTimeout(timeout); reject(e); },
                        peerId: peerId
                    });
                });

                try {
                    const vv = this.twoDeviceState.fileVersions[t.path];
                    await this.sendFileInChunks(t.peerId, t.path, file.stat.mtime, content, t.id, t.processedChunks, t.compressed, vv);
                    await ackPromise;
                    this.log(`Resumed transfer ${t.id} completed.`);
                    this.activeTransfers.delete(t.id);
                    this.debouncedSaveState();
                } catch (e) {
                    if (e.message === 'Paused') this.log(`Transfer ${t.id} paused again.`);
                    else this.log(`Resumed transfer ${t.id} failed:`, e);
                } finally {
                    if (this.pendingAcks.has(t.id)) {
                        this.pendingAcks.get(t.id)!.resolve();
                        this.pendingAcks.delete(t.id);
                    }
                }
            } else {
                this.activeTransfers.delete(t.id);
                this.debouncedSaveState();
            }
        }
    }

    startHeartbeat() {
        this.registerInterval(window.setInterval(() => {
            const now = Date.now();
            this.connections.forEach((conn, peerId) => {
                if (conn.open) {
                    // Send directly to bypass the sync queue
                    conn.send({ type: 'ping' });
                    const last = this.lastHeard.get(peerId);
                    if (last && now - last > 20000) { // Increased timeout to 20 seconds
                        this.log(`Peer ${peerId} timed out (Heartbeat).`);
                        conn.close();
                    }
                }
            });
        }, 5000)); // Check every 5 seconds
    }
    
    startSyncKeepAlive() {
        if (this.syncKeepAliveInterval) clearInterval(this.syncKeepAliveInterval);
        this.syncState.missedPings = 0;
        this.syncKeepAliveInterval = window.setInterval(() => {
            if (this.syncState.isSyncing && this.syncState.peerId) {
                if (this.syncState.missedPings >= 2) {
                    this.abortSync(new SyncError(SyncErrorCategory.CONNECTION_ERROR, "Peer stopped responding to pings.", false, "Check peer network connection."));
                    return;
                }
                this.syncState.missedPings++;
                const conn = this.connections.get(this.syncState.peerId);
                if (conn && conn.open) conn.send({ type: 'sync-ping' });
            } else {
                if (this.syncKeepAliveInterval) { clearInterval(this.syncKeepAliveInterval); this.syncKeepAliveInterval = null; }
            }
        }, 10000);
    }

    async processIncomingData(data: any, conn: DataConnection | null) {
        if (!data || !data.type) return; this.log("Received data:", data.type, "from", conn?.peer);
        if (conn?.peer) {
            this.lastHeard.set(conn.peer, Date.now());
            this.lastSuccessfulMessageTime.set(conn.peer, Date.now());
        }

        if (data.messageId && data.type !== 'sync-ack' && conn) {
            conn.send({ type: 'sync-ack', messageId: data.messageId });
        }
        if (data.type === 'sync-ack') {
            const ack = this.pendingSyncAcks.get(data.messageId);
            if (ack) { ack.resolve(); this.pendingSyncAcks.delete(data.messageId); }
            return;
        }
        
        try {
            switch (data.type) {
                case 'handshake': this.handleHandshake(data, conn!); break;
                case 'role-announcement': 
                    if (this.isTwoDeviceMode()) {
                        this.log(`Role announcement from ${data.deviceId}: ${data.role}`);
                        // Validation: my role should be opposite
                        if (data.role === this.currentRole) {
                            this.log(`Role conflict detected! Re-evaluating.`);
                            this.currentRole = this.getMyRole(data.deviceId);
                        }
                    }
                    break;
                case 'cluster-gossip': this.handleClusterGossip(data); break;
                case 'companion-pair': this.handleCompanionPair(data); break;
                case 'ack':
                    if (this.pendingAcks.has(data.transferId)) {
                        this.log(`Ack received for ${data.transferId}.`);
                        this.pendingAcks.get(data.transferId)!.resolve();
                        this.pendingAcks.delete(data.transferId);
                        this.resetIdleTimeout();
                    }
                    break;
                case 'nack':
                    if (this.pendingAcks.has(data.transferId)) {
                        this.log(`Nack received for ${data.transferId} (Reason: ${data.reason}).`);
                        this.pendingAcks.get(data.transferId)!.reject(new Error(`IntegrityError: ${data.reason}`));
                        this.pendingAcks.delete(data.transferId);
                        this.resetIdleTimeout();
                    }
                    break;
                case 'file-update': 
                    this.applyFileUpdate(data).then(() => {
                        if (conn && data.transferId) conn.send({ type: 'ack', transferId: data.transferId });
                        this.resetIdleTimeout();
                    }).catch(e => {
                        this.log(`Failed to apply file update: ${data.path}`, e);
                        if (conn && data.transferId) {
                            const reason = (e instanceof Error && e.message.includes('IntegrityError')) ? 'integrity-failure' : 'write-error';
                            conn.send({ type: 'nack', transferId: data.transferId, reason });
                        }
                    }); 
                    break;
                case 'file-delta':
                    this.applyFileDelta(data).then(() => {
                        if (conn && data.transferId) conn.send({ type: 'ack', transferId: data.transferId });
                        this.resetIdleTimeout();
                    }).catch(e => {
                        this.log(`Failed to apply delta: ${data.path}`, e);
                        if (conn && data.transferId) {
                            const reason = (e instanceof Error && e.message.includes('IntegrityError')) ? 'integrity-failure' : 'write-error';
                            conn.send({ type: 'nack', transferId: data.transferId, reason });
                        }
                    });
                    break;
                case 'file-delete': this.applyFileDelete(data); break;
                case 'file-rename': this.applyFileRename(data); break;
                case 'folder-create': this.applyFolderCreate(data); break;
                case 'folder-delete': this.applyFolderDelete(data); break;
                case 'folder-rename': this.applyFolderRename(data); break;
                
                // Pull-based Sync
                case 'request-full-sync': await this.handleFullSyncRequest(data, conn!); break;
                case 'sync-plan': await this.handleSyncPlan(data, conn!); break;
                case 'request-batch': await this.handleRequestBatch(data, conn!); break;
                case 'batch-complete': this.handleBatchComplete(data, conn!); break;
                
                case 'full-sync-complete': 
                    this.peerSyncComplete.set(conn!.peer, true);
                    this.checkFullSyncCompletion(conn!.peer);
                    break;
                case 'request-file': this.handleRequestFile(data, conn!); break;
                case 'file-chunk-start': this.handleFileChunkStart(data, conn); break;
                case 'file-chunk-data': await this.handleFileChunkData(data, conn!); break;
                
                case 'ping': conn?.send({ type: 'pong' }); break;
                case 'pong': 
                    if (this.manualPingStart.has(conn!.peer)) {
                        const start = this.manualPingStart.get(conn!.peer)!;
                        const rtt = Date.now() - start;
                        this.manualPingStart.delete(conn!.peer);
                        this.showNotice(`Ping to ${this.clusterPeers.get(conn!.peer)?.friendlyName || conn!.peer}: ${rtt}ms`, 'important');
                    }
                    break;
                case 'sync-ping': conn?.send({ type: 'sync-pong' }); this.resetIdleTimeout(); break;
                case 'sync-pong': this.syncState.missedPings = 0; this.resetIdleTimeout(); break;
                    
                case 'cluster-forget': this.handleClusterForget(data); break;
                case 'cluster-kick': this.handleClusterKick(data); break;
                case 'cluster-rename': this.handleClusterRename(data); break;
                
                // Locking
                case 'lock-request': this.handleLockRequest(data, conn!); break;
                case 'lock-grant': this.handleLockGrant(data); break;
                case 'lock-deny': this.handleLockDeny(data); break;
                case 'lock-release': this.handleLockRelease(data, conn!); break;
                
                // Editor Sync
                case 'editor-active': this.handleEditorActive(data, conn!); break;
                case 'editor-delta': this.handleEditorDelta(data); break;
                
                // Merkle
                case 'merkle-root': await this.handleMerkleRoot(data, conn!); break;
                case 'merkle-node-request': await this.handleMerkleNodeRequest(data, conn!); break;
                case 'merkle-node-response': await this.handleMerkleNodeResponse(data, conn!); break;
            }
        } catch (e) {
            this.log(`Error processing incoming data (type: ${data.type}):`, e);
            if (this.syncState.isSyncing && (data.type === 'request-full-sync' || data.type === 'sync-plan' || data.type === 'request-batch')) {
                this.abortSync(new SyncError(SyncErrorCategory.PROTOCOL_ERROR, `Sync protocol error: ${e instanceof Error ? e.message : String(e)}`, false, "Check logs."));
            }
        }
    }

    handleHandshake(data: HandshakePayload, conn: DataConnection) {
        if (this.joinPin && data.pin !== this.joinPin) { 
            this.showNotice(`Incorrect PIN from ${data.peerInfo.friendlyName}. Connection rejected.`, 'error', 10000); 
            conn.close(); 
            return; 
        }
        if (this.joinPin && !this.settings.requirePinForAllConnections) { 
            this.joinPin = null; 
        } 
        this.showNotice(`Connected to ${data.peerInfo.friendlyName}`, 'important', 4000);
        this.lastHeard.set(conn.peer, Date.now());
        this.connections.set(conn.peer, conn); this.clusterPeers.set(conn.peer, data.peerInfo); this.updateStatus();
        this.saveKnownPeers();
        const existingPeers = Array.from(this.clusterPeers.values());
        this.sendData(conn.peer, { type: 'cluster-gossip', peers: existingPeers });
        this.broadcastData({ type: 'cluster-gossip', peers: [this.getMyPeerInfo(), data.peerInfo] });
        
        if (this.isTwoDeviceMode()) {
            this.currentRole = this.getMyRole(conn.peer);
            this.sendData(conn.peer, { type: 'role-announcement', role: this.currentRole, deviceId: this.settings.deviceId });
        }
    }

    handleClusterGossip(data: ClusterGossipPayload) {
        if (this.getConnectionMode() !== 'peerjs') return;
        let hasNew = false;
        data.peers.forEach(peerInfo => {
            if (peerInfo.deviceId === this.settings.deviceId || this.connections.has(peerInfo.deviceId)) return;
            if (!this.clusterPeers.has(peerInfo.deviceId)) {
                this.clusterPeers.set(peerInfo.deviceId, peerInfo);
                hasNew = true;
            }
        });
        if (hasNew) {
            this.saveKnownPeers();
            this.updateStatus();
            this.tryToConnectToClusterPeers();
        }
    }

    async handleCompanionPair(data: CompanionPairPayload) {
        this.settings.companionPeerId = data.peerInfo.deviceId; await this.saveSettings();
        this.showNotice(`Paired with ${data.peerInfo.friendlyName} as a primary sync partner.`, 'important', 4000);
        this.tryToConnectToClusterPeers();
    }

    tryToConnectToClusterPeers() {
        if (this.getConnectionMode() !== 'peerjs') return;
        
        const attemptConnection = () => {
            if (!this.peer || this.peer.disconnected) return;
            
            const connectToPeer = (peerId: string) => {
                if (peerId === this.settings.deviceId) return;
                if (this.connections.has(peerId) || this.pendingConnections.has(peerId)) return;
                
                this.log(`Attempting to connect to cluster peer ${peerId}`); 
                this.pendingConnections.add(peerId);
                const conn = this.peer!.connect(peerId, { reliable: true }); 
                if (conn) {
                    this.setupConnection(conn);
                    setTimeout(() => {
                        if (this.pendingConnections.has(peerId)) {
                            this.pendingConnections.delete(peerId);
                            this.log(`Pending connection to ${peerId} timed out. Removing from pending set.`);
                        }
                    }, 15000);
                } else {
                    this.pendingConnections.delete(peerId);
                }
            };

            const companionId = this.settings.companionPeerId;
            if (companionId) connectToPeer(companionId);

            for (const peerId of this.clusterPeers.keys()) {
                if (peerId !== companionId) connectToPeer(peerId);
            }
        };
        
        attemptConnection();
        if (!this.clusterConnectionInterval) {
            this.clusterConnectionInterval = window.setInterval(attemptConnection, COMPANION_RECONNECT_INTERVAL_MS); 
            this.registerInterval(this.clusterConnectionInterval);
        }
    }

    handleClusterForget(data: ClusterForgetPayload) {
        this.log(`Received instruction to forget device: ${data.targetDeviceId}`);
        this.pendingConnections.delete(data.targetDeviceId);
        if (this.connections.has(data.targetDeviceId)) {
            this.connections.get(data.targetDeviceId)?.close();
        }
        this.clusterPeers.delete(data.targetDeviceId);
        this.saveKnownPeers();
        this.updateStatus();
    }

    handleClusterKick(data: ClusterKickPayload) {
        if (data.targetDeviceId === this.settings.deviceId) {
            this.showNotice("You have been kicked from the cluster.", 'error');
        } else if (this.connections.has(data.targetDeviceId)) {
            this.log(`Kicking device: ${data.targetDeviceId}`);
            this.connections.get(data.targetDeviceId)?.close();
        }
    }

    handleClusterRename(data: ClusterRenamePayload) {
        if (data.targetDeviceId === this.settings.deviceId) {
            this.settings.friendlyName = data.newName;
            this.saveSettings();
            this.showNotice(`Your device was renamed to ${data.newName} by the cluster.`, 'info');
        }
        const peer = this.clusterPeers.get(data.targetDeviceId);
        if (peer) {
            peer.friendlyName = data.newName;
            this.saveKnownPeers();
            this.updateStatus();
        }
    }

    public async forgetCompanion() {
        const companionId = this.settings.companionPeerId;
        if (companionId) { 
            const conn = this.connections.get(companionId); 
            conn?.close(); 
            this.pendingConnections.delete(companionId);
        }
        this.settings.companionPeerId = undefined; await this.saveSettings(); 
        this.showNotice('Paired Device link forgotten.', 'important', 3000);
    }

    private async getHash(buffer: ArrayBuffer | string): Promise<string> {
        const data = typeof buffer === 'string' ? new TextEncoder().encode(buffer) : buffer;
        const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // --- Locking Handlers ---
    async requestLock(path: string): Promise<boolean> {
        if (!this.isTwoDeviceMode() || !this.twoDevicePeerId) return true;
        const requestId = this.generateTransferId(path);
        
        return new Promise((resolve) => {
            const timeout = window.setTimeout(() => {
                this.pendingLockRequests.delete(requestId);
                resolve(false);
            }, 5000);
            
            this.pendingLockRequests.set(requestId, { resolve, timeout });
            this.sendData(this.twoDevicePeerId!, { type: 'lock-request', path, requestId });
        });
    }

    handleLockRequest(data: LockRequestPayload, conn: DataConnection) {
        const path = data.path;
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const isEditing = view && view.file && view.file.path === path;
        
        if (isEditing || this.heldLocks.has(path)) {
            this.sendData(conn.peer, { type: 'lock-deny', path, requestId: data.requestId, reason: 'File is actively being edited' });
        } else {
            const expiresAt = Date.now() + LOCK_EXPIRATION_MS;
            this.remoteLocks.set(path, { peerId: conn.peer, expiresAt });
            this.sendData(conn.peer, { type: 'lock-grant', path, requestId: data.requestId, grantedUntil: expiresAt });
        }
    }

    handleLockGrant(data: LockGrantPayload) {
        if (this.pendingLockRequests.has(data.requestId)) {
            const req = this.pendingLockRequests.get(data.requestId)!;
            clearTimeout(req.timeout);
            this.heldLocks.set(data.path, { peerId: this.twoDevicePeerId!, expiresAt: data.grantedUntil });
            req.resolve(true);
            this.pendingLockRequests.delete(data.requestId);
        }
    }

    handleLockDeny(data: LockDenyPayload) {
        if (this.pendingLockRequests.has(data.requestId)) {
            const req = this.pendingLockRequests.get(data.requestId)!;
            clearTimeout(req.timeout);
            req.resolve(false);
            this.pendingLockRequests.delete(data.requestId);
            this.showNotice(`Lock denied for ${data.path}: ${data.reason}`, 'warning');
        }
    }

    handleLockRelease(data: LockReleasePayload, conn: DataConnection) {
        if (this.remoteLocks.has(data.path) && this.remoteLocks.get(data.path)!.peerId === conn.peer) {
            this.remoteLocks.delete(data.path);
        }
    }
    
    cleanupLocks() {
        const now = Date.now();
        for (const [path, lock] of this.heldLocks.entries()) {
            if (now > lock.expiresAt) {
                this.heldLocks.delete(path);
                if (this.twoDevicePeerId) this.sendData(this.twoDevicePeerId, { type: 'lock-release', path });
            }
        }
        for (const [path, lock] of this.remoteLocks.entries()) {
            if (now > lock.expiresAt) {
                this.remoteLocks.delete(path);
            }
        }
    }

    // --- Editor Sync Handlers ---
    handleEditorActive(data: EditorActivatePayload, conn: DataConnection) {
        this.activeEditorLocks.set(data.path, conn.peer);
        this.showNotice(`Peer is actively editing ${data.path}`, 'info', 3000);
    }

    handleEditorDelta(data: EditorDeltaPayload) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view && view.file && view.file.path === data.path) {
            const cm = (view as any).editor?.cm;
            if (cm) {
                this.isApplyingRemoteEdit = true;
                this.ignoreNextEventForPath(data.path);
                
                const currentText = view.editor.getValue();
                const dmp = new DiffMatchPatch();
                const patches = dmp.patch_fromText(data.patches);
                const [newText, results] = dmp.patch_apply(patches, currentText);
                
                if (results.every((r: boolean) => r === true)) {
                    const diff = dmp.diff_main(currentText, newText);
                            dmp.diff_cleanupSemantic(diff);
                            let offset = 0;
                            const changes: Array<{ from: number, to?: number, insert?: string }> = [];
                            for (const [op, text] of diff) {
                                if (op === 0) { offset += text.length; } 
                                else if (op === -1) { changes.push({ from: offset, to: offset + text.length }); } 
                                else if (op === 1) { changes.push({ from: offset, insert: text }); offset += text.length; }
                            }
                    
                    const tx: any = { changes };
                    const syncAnnotation = (window as any).CM_Annotation ? (window as any).CM_Annotation.define() : null;
                    if (syncAnnotation) tx.annotations = syncAnnotation.of('remote-sync');
                    
                    cm.dispatch(tx);
                    
                    this.lastSentContent.set(data.path, { content: newText, timestamp: Date.now() });
                }
                
                setTimeout(() => this.isApplyingRemoteEdit = false, 50);
            }
        }
    }

    async sendFileUpdate(file: TFile, peerId?: string, forceFull: boolean = false) {
        if (!this.isPathSyncable(file.path)) return;
        const isBinaryFile = this.isBinary(file.extension);
        if (isBinaryFile && !this.shouldSyncAllFileTypes()) { this.log(`Skipping binary file because 'syncAllFileTypes' is disabled: ${file.path}`); return; }
        if (!isBinaryFile && !this.shouldSyncAllFileTypes()) { const textWhitelist = ['md', 'css', 'js', 'json']; if (!textWhitelist.includes(file.extension)) { this.log(`Skipping non-whitelisted text file: ${file.path}`); return; } }
        this.log(`Queueing file update for ${peerId || 'broadcast'}: ${file.path}`);
        
        this.addToQueueTask(peerId || null, { taskType: 'send-file', path: file.path, mtime: file.stat.mtime, forceFull });
    }

    async sendFileInChunks(peerId: string, path: string, mtime: number, fileContent: ArrayBuffer, transferId: string, startIndex = 0, compressed?: boolean, versionVector?: VersionVector) {
        const isDirectIp = this.getConnectionMode() === 'direct-ip';
        let conn: DataConnection | undefined;

        if (!isDirectIp) {
            conn = this.connections.get(peerId);
            if (!conn?.open) {
                this.log(`No open connection to ${peerId} to send chunks. Aborting transfer.`);
                this.pendingAcks.get(transferId)?.reject(new Error("Connection closed"));
                return;
            }
        }
        
        const chunkSize = this.getChunkSize();
        const existingTransfer = this.activeTransfers.get(transferId);
        this.activeTransfers.set(transferId, existingTransfer || {
            id: transferId,
            path,
            direction: 'upload',
            peerId,
            totalChunks: Math.ceil(fileContent.byteLength / chunkSize),
            processedChunks: startIndex,
            startTime: Date.now(),
            lastUpdate: Date.now(),
            status: 'active',
            chunkSize: chunkSize,
            compressed: compressed
        });
        this.updateStatus();
        this.debouncedSaveState();

        const totalChunks = Math.ceil(fileContent.byteLength / chunkSize);
        this.log(`Sending file in ${totalChunks} chunks to ${peerId}: ${path} (ID: ${transferId})`);
        
        let chunkHash = '';
        try { chunkHash = await this.getHash(fileContent); } catch(e) {}

        const YIELD_THRESHOLD_MS = 100;
        let lastYieldTime = Date.now();
        
        if (startIndex === 0) {
            const startPayload: FileChunkStartPayload = { type: 'file-chunk-start', path, mtime, totalChunks, transferId, fileHash: chunkHash, compressed, versionVector };
            if (isDirectIp) {
                let encPayload: any = startPayload;
                if (this.settings.enableEncryption && this.settings.peerKeys[peerId]) encPayload = await this.encryptPayload(startPayload, this.settings.peerKeys[peerId]);
                if (this.directIpClient) this.directIpClient.send(encPayload);
                else if (this.directIpServer) this.directIpServer.sendTo(peerId, encPayload);
            }
            else {
                let encPayload: any = startPayload;
                if (this.settings.enableEncryption && this.settings.peerKeys[peerId]) encPayload = await this.encryptPayload(startPayload, this.settings.peerKeys[peerId]);
                conn!.send(encPayload);
            }
            this.resetIdleTimeout();
        }
        
        for (let i = startIndex; i < totalChunks; i++) {
            if (!this.activeTransfers.has(transferId)) {
                throw new Error("Transfer cancelled or timed out");
            }
            if (isDirectIp) {
                const clientConnected = this.directIpClient && this.directIpClient.isOpen;
                const serverHasPeer = this.directIpServer && this.directIpServer.hasClient(peerId);
                if (!clientConnected && !serverHasPeer) {
                    this.log(`Direct IP Connection closed mid-transfer. Pausing.`);
                    const t = this.activeTransfers.get(transferId);
                    if (t) { t.status = 'paused'; t.lastUpdate = Date.now(); }
                    this.updateStatus();
                    this.debouncedSaveState();
                    throw new Error("Paused");
                }
            } else if (!conn!.open) {
                this.log(`Connection to ${peerId} closed mid-transfer. Pausing.`);
                const t = this.activeTransfers.get(transferId);
                if (t) { t.status = 'paused'; t.lastUpdate = Date.now(); }
                this.updateStatus();
                this.debouncedSaveState();
                throw new Error("Paused");
            }
            try {
                const start = i * chunkSize; const end = start + chunkSize; const chunk = fileContent.slice(start, end);
                const chunkPayload: FileChunkDataPayload = { type: 'file-chunk-data', transferId, index: i, data: chunk };
                
                let encPayload: any = chunkPayload;
                if (this.settings.enableEncryption && this.settings.peerKeys[peerId]) encPayload = await this.encryptPayload(chunkPayload, this.settings.peerKeys[peerId]);

                if (isDirectIp) {
                    if (this.directIpClient) this.directIpClient.send(encPayload);
                    else if (this.directIpServer) this.directIpServer.sendTo(peerId, encPayload);

                    const getBuffer = () => this.directIpClient ? this.directIpClient.getBufferedAmount() : this.directIpServer!.getBufferedAmount(peerId);
                    if (getBuffer() > 1024 * 1024 * 16) {
                        await new Promise<void>(resolve => {
                            const check = () => {
                                if (getBuffer() <= 1024 * 1024 * 8) resolve();
                                else setTimeout(check, 5);
                            };
                            check();
                        });
                    }
                }
                else {
                    conn!.send(encPayload);
                    
                    if ((conn! as any).dataChannel && (conn! as any).dataChannel.bufferedAmount > 1024 * 1024 * 16) {
                        await new Promise<void>(resolve => {
                            const check = () => {
                                if (!(conn! as any).dataChannel || (conn! as any).dataChannel.bufferedAmount <= 1024 * 1024 * 8) {
                                    resolve();
                                } else {
                                    setTimeout(check, 5);
                                }
                            };
                            check();
                        });
                    }
                }

                const transfer = this.activeTransfers.get(transferId);
                if (transfer) {
                    transfer.processedChunks = i + 1;
                    transfer.lastUpdate = Date.now();
                }
                
                const now = Date.now();
                if (now - lastYieldTime > YIELD_THRESHOLD_MS) {
                    this.updateStatus();
                    await new Promise(resolve => setTimeout(resolve, 0));
                    lastYieldTime = Date.now();
                }
                
                if (i % 100 === 0) this.debouncedSaveState();
                this.resetIdleTimeout();
            } catch (e) {
                this.log(`Error sending chunk ${i} for ${path}. Aborting.`, e);
                throw e;
            }
        }
        this.log(`Finished sending all chunks for ${path} to ${peerId}. Waiting for ack.`);
    }

    handleFileChunkStart(payload: FileChunkStartPayload, conn: DataConnection | null) { 
        this.pendingFileChunks.set(payload.transferId, { path: payload.path, mtime: payload.mtime, chunks: new Array(payload.totalChunks), total: payload.totalChunks, receivedCount: 0, lastUpdated: Date.now(), fileHash: payload.fileHash || '', compressed: payload.compressed, versionVector: payload.versionVector }); 
        this.activeTransfers.set(payload.transferId, {
            id: payload.transferId,
            path: payload.path,
            direction: 'download',
            peerId: conn?.peer || 'Direct-IP',
            totalChunks: payload.totalChunks,
            processedChunks: 0,
            startTime: Date.now(),
            lastUpdate: Date.now(),
            status: 'active'
        });
        this.resetIdleTimeout();
        this.log(`Receiving chunked file: ${payload.path}, ID: ${payload.transferId}`); 
    }

    async handleFileChunkData(payload: FileChunkDataPayload, conn: DataConnection) {
        const transfer = this.pendingFileChunks.get(payload.transferId); if (!transfer) { this.log("Received chunk for unknown transfer:", payload.transferId); return; }
        if (payload.index < 0 || payload.index >= transfer.total) {
            this.log(`Received invalid chunk index ${payload.index} for transfer ${payload.transferId}`);
            return;
        }
        if (!transfer.chunks[payload.index]) {
            transfer.chunks[payload.index] = payload.data;
            transfer.receivedCount++;
        }
        transfer.lastUpdated = Date.now();
        const active = this.activeTransfers.get(payload.transferId);
        if (active) { active.processedChunks = transfer.receivedCount; active.lastUpdate = Date.now(); }
        this.resetIdleTimeout();
        
        if (transfer.receivedCount === transfer.total) {
            this.log(`All chunks received for ${transfer.path}. Reassembling...`);
            this.pendingFileChunks.delete(payload.transferId);
            this.activeTransfers.delete(payload.transferId);
            
            const totalSize = transfer.chunks.reduce((sum, chunk) => sum + (chunk ? chunk.byteLength : 0), 0); 
            const reassembled = new Uint8Array(totalSize); 
            let offset = 0;
            for (let i = 0; i < transfer.chunks.length; i++) { 
                const chunk = transfer.chunks[i];
                if (chunk) { 
                    reassembled.set(new Uint8Array(chunk), offset); 
                    offset += chunk.byteLength; 
                }
                transfer.chunks[i] = null as any; 
            }
            
            try {
                const computedHash = await this.getHash(reassembled.buffer);
                if (transfer.fileHash && computedHash && transfer.fileHash !== computedHash) {
                    this.log(`Integrity check failed for chunked transfer ${transfer.path}. Rejecting.`);
                    conn.send({ type: 'nack', transferId: payload.transferId, reason: 'integrity-failure' });
                    return;
                }

                await this.applyFileUpdate({ type: 'file-update', path: transfer.path, content: reassembled.buffer, mtime: transfer.mtime, encoding: 'binary', transferId: payload.transferId, compressed: transfer.compressed, versionVector: transfer.versionVector });
                conn.send({ type: 'ack', transferId: payload.transferId }); this.log(`Reassembly complete for ${transfer.path}, sent ack.`);
            } catch (e) {
                this.log(`Failed to apply chunked file update: ${transfer.path}`, e);
                if (e instanceof Error && e.message.includes('IntegrityError')) {
                    conn.send({ type: 'nack', transferId: payload.transferId, reason: 'integrity-failure' });
                } else {
                    conn.send({ type: 'nack', transferId: payload.transferId, reason: 'write-error' });
                }
            }
        }
    }

    cleanupPendingChunks() {
        const now = Date.now();
        let statusChanged = false;

        for (const [id, transfer] of this.pendingFileChunks.entries()) {
            if (now - transfer.lastUpdated > 60000 * 5) { 
                this.log(`Cleaning up stale chunk transfer: ${id}`);
                this.pendingFileChunks.delete(id);
            }
        }
        for (const [id, transfer] of this.activeTransfers.entries()) {
            if (transfer.status === 'paused') continue;
            if (now - transfer.lastUpdate > 60000) { 
                this.log(`Cleaning up stale active transfer: ${id}`);
                this.activeTransfers.delete(id);
                statusChanged = true;
            }
        }
        
        this.pruneTombstones();
        if (statusChanged) this.updateStatus();
    }

    async applyFileDelta(data: FileDeltaPayload) {
        await this.runLocked(data.path, async () => {
            const existingFile = this.app.vault.getAbstractFileByPath(data.path);
            if (!(existingFile instanceof TFile)) {
                throw new Error("IntegrityError: File not found for delta sync");
            }
            
            if (this.isTwoDeviceMode() && data.versionVector) {
                const localVV = this.twoDeviceState.fileVersions[data.path] || {};
                if (this.isNewerThan(localVV, data.versionVector) && !this.isNewerThan(data.versionVector, localVV)) {
                    return;
                }
            } else if (data.mtime <= existingFile.stat.mtime + this.settings.mtimeTolerance && data.mtime >= existingFile.stat.mtime - this.settings.mtimeTolerance) {
                return;
            }

            const localContent = await this.app.vault.read(existingFile);
            const localHash = await this.getHash(localContent);
            
            if (localHash !== data.baseHash) {
                throw new Error("IntegrityError: Base hash mismatch for delta sync");
            }
            
            const dmp = new DiffMatchPatch();
            const patches = dmp.patch_fromText(data.patches);
            const [newContent, results] = dmp.patch_apply(patches, localContent);
            
            const success = results.every((r: boolean) => r === true);
            if (!success) {
                throw new Error("IntegrityError: Patch apply failed");
            }
            
            this.ignoreNextEventForPath(data.path);
            await this.app.vault.modify(existingFile, newContent, { mtime: data.mtime });
            
            if (this.isTwoDeviceMode() && data.versionVector) {
                this.twoDeviceState.fileVersions[data.path] = data.versionVector;
            }
            
            const newHash = await this.getHash(newContent);
            this.updateHashCache(data.path, newHash);
        });
    }

    async applyFileUpdate(data: FileUpdatePayload) {
        if (!this.isPathSyncable(data.path)) return;

        if (data.compressed && data.content instanceof ArrayBuffer) {
            data.content = decompressText(data.content);
            data.encoding = 'utf8';
        }

        let computedHash = '';
        try {
            computedHash = await this.getHash(data.content);
        } catch(e) {}

        if (data.fileHash && computedHash && data.fileHash !== computedHash) {
            throw new Error('IntegrityError: fileHash mismatch');
        }

        await this.runLocked(data.path, async () => {
            if (computedHash) {
                this.updateHashCache(data.path, computedHash);
            }

            const existingFile = this.app.vault.getAbstractFileByPath(data.path);
            if (!existingFile) {
                await this.handleNewFileCreation(data);
                if (this.isTwoDeviceMode() && data.versionVector) {
                    this.twoDeviceState.fileVersions[data.path] = data.versionVector;
                }
            } else if (existingFile instanceof TFile) {
                await this.handleFileModification(data, existingFile);
            } else {
                this.log(`Received file update for a path that is a folder: ${data.path}. Ignoring.`);
            }
        });
    }

    private async handleNewFileCreation(data: FileUpdatePayload) {
        this.log(`Creating new file: ${data.path}`);
        this.ignoreNextEventForPath(data.path);
        try {
            const folderPath = data.path.substring(0, data.path.lastIndexOf('/'));
            if (folderPath) {
                await this.ensureFolderExists(folderPath);
            }
            if (data.encoding === 'binary' || data.encoding === 'base64') {
                await this.app.vault.createBinary(data.path, data.content as ArrayBuffer);
            } else {
                await this.app.vault.create(data.path, data.content as string);
            }
        } catch (e) {
            if (e instanceof Error && e.message.includes("File already exists")) {
                this.log(`File ${data.path} already exists, falling back to modification.`);
                const file = this.app.vault.getAbstractFileByPath(data.path);
                if (file instanceof TFile) await this.handleFileModification(data, file);
            } else {
                console.error("File creation error:", e);
                this.showNotice(`Failed to create file: ${data.path}`, 'error');
                throw e;
            }
        }
    }

    private async ensureFolderExists(path: string) {
        const folders = path.split('/');
        let currentPath = '';
        for (const folder of folders) {
            currentPath = currentPath === '' ? folder : `${currentPath}/${folder}`;
            if (!this.app.vault.getAbstractFileByPath(currentPath)) {
                try {
                    await this.app.vault.createFolder(currentPath);
                } catch (e) { /* Ignore if created concurrently */ }
            }
        }
    }

    private async handleFileModification(data: FileUpdatePayload, existingFile: TFile) {
        try {
            const localContent = (data.encoding === 'binary' || data.encoding === 'base64')
                ? await this.app.vault.readBinary(existingFile)
                : await this.app.vault.cachedRead(existingFile);

            const contentIsSame = (data.encoding === 'binary' || data.encoding === 'base64')
                ? await this.areArrayBuffersEqual(localContent as ArrayBuffer, data.content as ArrayBuffer)
                : localContent === data.content;

            if (contentIsSame) {
                this.log(`Ignoring update (content is identical): ${data.path}`);
                if (this.isTwoDeviceMode() && data.versionVector) {
                    this.twoDeviceState.fileVersions[data.path] = this.mergeVersions(this.twoDeviceState.fileVersions[data.path] || {}, data.versionVector);
                }
                return;
            }

            if (this.isTwoDeviceMode() && data.versionVector) {
                const localVV = this.twoDeviceState.fileVersions[data.path] || {};
                const remoteVV = data.versionVector;
                const isRemoteNewer = this.isNewerThan(remoteVV, localVV);
                const isLocalNewer = this.isNewerThan(localVV, remoteVV);

                if (isRemoteNewer && !isLocalNewer) {
                    this.log(`Applying update (remote vector dominates): ${data.path}`);
                    this.ignoreNextEventForPath(data.path);
                    if (data.encoding === 'binary' || data.encoding === 'base64') {
                        await this.app.vault.modifyBinary(existingFile, data.content as ArrayBuffer, { mtime: data.mtime });
                    } else {
                        await this.app.vault.modify(existingFile, data.content as string, { mtime: data.mtime });
                    }
                    this.twoDeviceState.fileVersions[data.path] = remoteVV;
                    return;
                } else if (isLocalNewer && !isRemoteNewer) {
                    this.log(`Ignoring update (local vector dominates): ${data.path}`);
                    return;
                } else {
                    await this.resolveConflict(data, existingFile, localContent);
                    return;
                }
            }

            if (data.mtime > existingFile.stat.mtime + this.settings.mtimeTolerance) {
                this.log(`Applying update (remote is newer): ${data.path}`);
                this.ignoreNextEventForPath(data.path);
                if (data.encoding === 'binary' || data.encoding === 'base64') {
                    await this.app.vault.modifyBinary(existingFile, data.content as ArrayBuffer, { mtime: data.mtime });
                } else {
                    await this.app.vault.modify(existingFile, data.content as string, { mtime: data.mtime });
                }
                return;
            }

            if (data.mtime < existingFile.stat.mtime - this.settings.mtimeTolerance) {
                this.log(`Ignoring update (local is newer): ${data.path}`);
                return;
            }

            if (existingFile.stat.mtime > data.mtime + this.settings.mtimeTolerance) {
                this.log(`File ${data.path} changed locally during processing. Aborting update.`);
                return;
            }

            await this.resolveConflict(data, existingFile, localContent);
        } catch (e) {
            if (e instanceof Error && (e.message.includes("File not found") || e.message.includes("no such file"))) {
                this.log(`File ${data.path} not found during modification, falling back to creation.`);
                await this.handleNewFileCreation(data);
            } else {
                console.error(`Error modifying file ${data.path}:`, e);
                throw e;
            }
        }
    }

    private async resolveConflict(data: FileUpdatePayload, existingFile: TFile, localContent: string | ArrayBuffer) {
        this.showNotice(`Conflict detected for: ${data.path}`, 'important', 10000);
        const strategy = this.getConflictStrategy();
        this.log(`Conflict detected for: ${data.path}. Strategy: ${strategy}`);

        switch (strategy) {
            case 'role-based':
                if (this.currentRole === 'primary') {
                    this.log(`Conflict resolved by 'role-based' (Primary wins - keeping local): ${data.path}`);
                    const localVV = this.twoDeviceState.fileVersions[data.path] || {};
                    const merged = this.mergeVersions(localVV, data.versionVector || {});
                    merged[this.settings.deviceId] = (merged[this.settings.deviceId] || 0) + 1;
                    this.twoDeviceState.fileVersions[data.path] = merged;
                    this.debouncedSaveState();
                    
                    if (this.twoDevicePeerId) {
                        this.sendFileUpdate(existingFile, this.twoDevicePeerId, true);
                    }
                } else {
                    this.log(`Conflict resolved by 'role-based' (Secondary yields - adopting remote): ${data.path}`);
                    this.ignoreNextEventForPath(existingFile.path);
                    if (data.encoding === 'binary' || data.encoding === 'base64') {
                        await this.app.vault.modifyBinary(existingFile, data.content as ArrayBuffer, { mtime: data.mtime });
                    } else {
                        await this.app.vault.modify(existingFile, data.content as string, { mtime: data.mtime });
                    }
                    this.twoDeviceState.fileVersions[data.path] = data.versionVector || {};
                }
                break;

            case 'last-write-wins':
                if (data.mtime > existingFile.stat.mtime) {
                    this.log(`Conflict resolved by 'last-write-wins' (remote wins): ${data.path}`);
                    this.ignoreNextEventForPath(existingFile.path);
                    if (data.encoding === 'binary' || data.encoding === 'base64') {
                        await this.app.vault.modifyBinary(existingFile, data.content as ArrayBuffer, { mtime: data.mtime });
                    } else {
                        await this.app.vault.modify(existingFile, data.content as string, { mtime: data.mtime });
                    }
                } else {
                    this.log(`Conflict resolved by 'last-write-wins' (local wins): ${data.path}`);
                }
                break;

            case 'create-conflict-file':
            default:
                this.log(`Creating conflict file for: ${data.path}`);
                await this.createConflictFile(data);
                break;
        }
    }

    async createConflictFile(data: FileUpdatePayload) { const conflictPath = this.getConflictPath(data.path); this.ignoreNextEventForPath(conflictPath); if (data.encoding === 'binary' || data.encoding === 'base64') { await this.app.vault.createBinary(conflictPath, data.content as ArrayBuffer); } else { await this.app.vault.create(conflictPath, data.content as string); } this.conflictCenter.addConflict(data.path, conflictPath); }
    async applyFileDelete(data: FileDeletePayload) { if (!this.isPathSyncable(data.path)) return; this.tombstones[data.path] = Date.now(); this.debouncedSaveState(); this.syncedHashes.delete(data.path); const existingFile = this.app.vault.getAbstractFileByPath(data.path); if (existingFile) { try { this.log(`Deleting file: ${data.path}`); this.ignoreNextEventForPath(data.path); await this.app.vault.delete(existingFile); } catch (e) { console.error(`Error deleting file: ${data.path}`, e); this.showNotice(`Failed to delete file: ${data.path}`, 'error'); } } }
    async applyFileRename(data: FileRenamePayload) { 
        if (!this.isPathSyncable(data.oldPath) && !this.isPathSyncable(data.newPath)) return; 
        const fileToRename = this.app.vault.getAbstractFileByPath(data.oldPath); 
        if (fileToRename instanceof TFile) { 
            try { 
                this.log(`Renaming file: ${data.oldPath} -> ${data.newPath}`); 
                this.ignoreNextEventForPath(data.newPath); 
                const cached = this.syncedHashes.get(data.oldPath); 
                if (cached) { 
                    this.syncedHashes.set(data.newPath, cached); 
                    this.syncedHashes.delete(data.oldPath); 
                } 
                if (data.versionVector) {
                    this.twoDeviceState.fileVersions[data.newPath] = data.versionVector;
                    delete this.twoDeviceState.fileVersions[data.oldPath];
                }
                this.debouncedSaveState(); 
                await this.app.vault.rename(fileToRename, data.newPath); 
            } catch (e) { 
                console.error(`Error renaming file: ${data.oldPath} -> ${data.newPath}`, e); 
                this.showNotice(`Failed to rename file: ${data.oldPath}`, 'error'); 
            } 
        } else {
            const newFile = this.app.vault.getAbstractFileByPath(data.newPath);
            if (newFile instanceof TFile && data.versionVector) {
                this.twoDeviceState.fileVersions[data.newPath] = data.versionVector;
                delete this.twoDeviceState.fileVersions[data.oldPath];
                this.debouncedSaveState();
            }
        }
    }
    async applyFolderCreate(data: FolderCreatePayload) { if (!this.isPathSyncable(data.path)) return; if (this.app.vault.getAbstractFileByPath(data.path)) return; this.log(`Creating folder: ${data.path}`); this.ignoreNextEventForPath(data.path); try { await this.app.vault.createFolder(data.path); } catch (e) { console.error(`Failed to create folder ${data.path}`, e); } }
    async applyFolderDelete(data: FolderDeletePayload) { if (!this.isPathSyncable(data.path)) return; const folder = this.app.vault.getAbstractFileByPath(data.path); if (folder instanceof TFolder) { this.log(`Deleting folder: ${data.path}`); this.ignoreNextEventForPath(data.path, 5000); try { await this.app.vault.delete(folder, true); } catch (e) { console.error(`Failed to delete folder ${data.path}`, e); } } }
    async applyFolderRename(data: FolderRenamePayload) { if (!this.isPathSyncable(data.oldPath) && !this.isPathSyncable(data.newPath)) return; const folder = this.app.vault.getAbstractFileByPath(data.oldPath); if (folder instanceof TFolder) { this.log(`Renaming folder: ${data.oldPath} -> ${data.newPath}`); this.ignoreNextEventForPath(data.oldPath); this.ignoreNextEventForPath(data.newPath); try { await this.app.vault.rename(folder, data.newPath); } catch (e) { console.error(`Failed to rename folder ${data.oldPath}`, e); } } }

    async requestFullSyncFromPeer(peerId: string) { 
        if (this.syncState.isSyncing) { this.showNotice("A sync is already in progress.", 'info'); return; } 
        const conn = this.connections.get(peerId); 
        if (!conn) { this.showNotice("Peer not found.", 'error'); return; } 
        this.showNotice(`Starting full sync with ${this.clusterPeers.get(peerId)?.friendlyName}...`, 'info'); 
        this.syncState.isSyncing = true; 
        this.syncState.peerId = peerId;
        this.syncState.filesTotal = 0;
        this.syncState.filesTransferred = 0;
        this.syncState.bytesTotal = 0;
        this.syncState.bytesTransferred = 0;
        this.currentSyncIsTwoDeviceMode = this.isTwoDeviceMode();
        this.localSyncComplete.set(peerId, false);
        this.peerSyncComplete.set(peerId, false);
        this.transitionToPhase(SyncPhase.REQUESTING);
        this.startSyncKeepAlive();
        this.resetIdleTimeout();
        
        try {
            const localManifest = await this.buildVaultManifest(); 
            this.log(`Sending sync request with ${localManifest.length} items.`); 
            await this.sendSyncMessage(peerId, { type: 'request-full-sync', manifest: localManifest }); 
        } catch (e) {
            this.abortSync(e instanceof SyncError ? e : new SyncError(SyncErrorCategory.PROTOCOL_ERROR, String(e), false, "Check network connection."));
        }
    }
    
    // --- Merkle Handlers ---
    async handleMerkleRoot(data: MerkleRootPayload, conn: DataConnection) {
        if (!this.syncState.isSyncing) { 
            this.syncState.isSyncing = true; 
            this.syncState.peerId = conn.peer;
            this.currentSyncIsTwoDeviceMode = true;
            this.transitionToPhase(SyncPhase.REQUESTING);
            this.startSyncKeepAlive();
        }
        this.resetIdleTimeout();
        const tree = await this.buildMerkleTree();
        if (tree.hash === data.rootHash) {
            this.log("Merkle roots match! Skipping full sync.");
            this.handleFullSyncComplete();
        } else {
            this.log(`Merkle roots differ. Initiating tree traversal.`);
            this.sendData(conn.peer, { type: 'merkle-node-request', path: '' });
        }
    }
    
    async handleMerkleNodeRequest(data: MerkleNodeRequestPayload, conn: DataConnection) {
        this.resetIdleTimeout();
        const tree = this.twoDeviceState.merkleTreeRoot;
        if (!tree) return;
        
        let targetNode = tree;
        if (data.path !== '') {
            const parts = data.path.split('/');
            for (const p of parts) {
                if (targetNode.children && targetNode.children[p]) {
                    targetNode = targetNode.children[p];
                } else {
                    return; // Node not found
                }
            }
        }
        
        const childHashes: Record<string, string> = {};
        if (targetNode.children) {
            for (const [key, node] of Object.entries(targetNode.children)) {
                childHashes[key] = node.hash;
            }
        }
        this.sendData(conn.peer, { type: 'merkle-node-response', path: data.path, children: childHashes });
    }
    
    async handleMerkleNodeResponse(data: MerkleNodeResponsePayload, conn: DataConnection) {
        this.resetIdleTimeout();
        const tree = this.twoDeviceState.merkleTreeRoot;
        if (!tree) return;
        
        let targetNode = tree;
        if (data.path !== '') {
            const parts = data.path.split('/');
            for (const p of parts) {
                if (targetNode.children && targetNode.children[p]) targetNode = targetNode.children[p];
            }
        }
        
        const myChildren = targetNode.children || {};
        const remoteChildren = data.children;
        
        const allKeys = new Set([...Object.keys(myChildren), ...Object.keys(remoteChildren)]);
        
        for (const key of allKeys) {
            const myHash = myChildren[key]?.hash;
            const remoteHash = remoteChildren[key];
            const fullPath = data.path ? `${data.path}/${key}` : key;
            
            if (myHash !== remoteHash) {
                const file = this.app.vault.getAbstractFileByPath(fullPath);
                if (file instanceof TFolder || (!file && !fullPath.includes('.'))) {
                    this.sendData(conn.peer, { type: 'merkle-node-request', path: fullPath });
                } else {
                    if (!myHash && remoteHash) {
                        this.sendData(conn.peer, { type: 'request-file', path: fullPath });
                    } else if (file instanceof TFile) {
                        this.sendFileUpdate(file, conn.peer);
                    }
                }
            }
        }
    }

    async handleFullSyncRequest(data: FullSyncRequestPayload, conn: DataConnection) { 
        if (this.syncState.isSyncing && this.syncState.currentPhase !== SyncPhase.IDLE) { 
            this.log(`Received a sync request from ${conn.peer}, but a sync is already in progress in phase ${this.syncState.currentPhase}. Ignoring.`); 
            return; 
        } 
        try {
            if (!data.manifest) throw new SyncError(SyncErrorCategory.PROTOCOL_ERROR, "Received invalid sync request (missing manifest).", false, "Update plugin on both devices.");
            this.showNotice(`Peer ${this.clusterPeers.get(conn.peer)?.friendlyName} requested a full sync. Comparing vaults...`, 'info'); 
            this.syncState.isSyncing = true; 
            this.syncState.peerId = conn.peer;
            this.syncState.filesTotal = 0;
            this.syncState.filesTransferred = 0;
            this.syncState.bytesTotal = 0;
            this.syncState.bytesTransferred = 0;
            this.currentSyncIsTwoDeviceMode = this.isTwoDeviceMode();
            this.localSyncComplete.set(conn.peer, false);
            this.peerSyncComplete.set(conn.peer, false);
            this.transitionToPhase(SyncPhase.PLANNING);
            this.startSyncKeepAlive();
            this.resetIdleTimeout();
        
            const remoteManifest = data.manifest; 
            const localManifest = await this.buildVaultManifest(); 
            const remoteIndex = new Map(remoteManifest.map(item => [item.path, item])); 
            const localIndex = new Map(localManifest.map(item => [item.path, item])); 
            
            const filesReceiverWillSend: string[] = []; 
            const filesInitiatorMustSend: string[] = []; 
            const filesReceiverMustDelete: string[] = [];
            const filesInitiatorMustDelete: string[] = [];
            const fileSizes: Record<string, number> = {};
            
            const allPaths = new Set([...localIndex.keys(), ...remoteIndex.keys()]);
            
            let peerPotentiallyStale = false;
            const retentionMs = (this.settings.tombstoneRetentionDays || 30) * 24 * 60 * 60 * 1000;
            const now = Date.now();
            
            for (const path of allPaths) {
                const localItem = localIndex.get(path);
                const remoteItem = remoteIndex.get(path);
                
                if (localItem && !remoteItem) {
                    if (localItem.type === 'file') {
                        filesReceiverWillSend.push(path);
                        fileSizes[path] = localItem.size;
                    }
                } else if (!localItem && remoteItem) {
                    if (remoteItem.type === 'file') {
                        if (now - remoteItem.mtime > retentionMs) peerPotentiallyStale = true;
                        filesInitiatorMustSend.push(path);
                        this.peerFileSizes[path] = remoteItem.size;
                    }
                } else if (localItem && remoteItem) {
                    if (localItem.type === 'file' && remoteItem.type === 'file') {
                        let conflictResolved = false;
                        if (this.currentSyncIsTwoDeviceMode && localItem.versionVector && remoteItem.versionVector) {
                            const isLocalNewer = this.isNewerThan(localItem.versionVector, remoteItem.versionVector);
                            const isRemoteNewer = this.isNewerThan(remoteItem.versionVector, localItem.versionVector);
                            if (isLocalNewer && !isRemoteNewer) {
                                filesReceiverWillSend.push(path);
                                fileSizes[path] = localItem.size;
                                conflictResolved = true;
                            }
                            else if (isRemoteNewer && !isLocalNewer) {
                                filesInitiatorMustSend.push(path);
                                this.peerFileSizes[path] = remoteItem.size;
                                conflictResolved = true;
                            }
                            else if (!isLocalNewer && !isRemoteNewer) {
                                if (localItem.hash && remoteItem.hash && localItem.hash === remoteItem.hash) {
                                    conflictResolved = true;
                                } else {
                                    const role = this.getMyRole(conn.peer);
                                    if (role === 'primary') {
                                        filesReceiverWillSend.push(path);
                                        fileSizes[path] = localItem.size;
                                    } else {
                                        filesInitiatorMustSend.push(path);
                                        this.peerFileSizes[path] = remoteItem.size;
                                    }
                                    conflictResolved = true;
                                }
                            }
                        } 
                        
                        if (!conflictResolved) {
                            if (localItem.size !== remoteItem.size) {
                                if (localItem.mtime > remoteItem.mtime) { filesReceiverWillSend.push(path); fileSizes[path] = localItem.size; }
                                else { filesInitiatorMustSend.push(path); this.peerFileSizes[path] = remoteItem.size; }
                            } else if (Math.abs(localItem.mtime - remoteItem.mtime) > this.settings.mtimeTolerance) {
                                let lHash = localItem.hash;
                                if (!lHash) {
                                    const file = this.app.vault.getAbstractFileByPath(path);
                                    if (file instanceof TFile) {
                                        const content = this.isBinary(file.extension) ? await this.app.vault.readBinary(file) : await this.app.vault.read(file);
                                        lHash = await this.getHash(content);
                                        this.updateHashCache(path, lHash);
                                    }
                                }
                                if (remoteItem.hash && lHash === remoteItem.hash) {
                                    // Match
                                } else {
                                    if (localItem.mtime > remoteItem.mtime) { filesReceiverWillSend.push(path); fileSizes[path] = localItem.size; }
                                    else { filesInitiatorMustSend.push(path); this.peerFileSizes[path] = remoteItem.size; }
                                }
                            }
                        }
                    } else if (localItem.type === 'deleted' && remoteItem.type === 'file') {
                        if (localItem.mtime > remoteItem.mtime) filesInitiatorMustDelete.push(path);
                        else { filesInitiatorMustSend.push(path); this.peerFileSizes[path] = remoteItem.size; }
                    } else if (localItem.type === 'file' && remoteItem.type === 'deleted') {
                        if (remoteItem.mtime > localItem.mtime) filesReceiverMustDelete.push(path);
                        else { filesReceiverWillSend.push(path); fileSizes[path] = localItem.size; }
                    }
                }
            }
            
            if (peerPotentiallyStale) {
                this.showNotice("Warning: Peer has files older than your tombstone retention period. This might resurrect deleted files.", 'warning', 15000);
            }
            
            this.log(`Sync plan: They pull ${filesReceiverWillSend.length}, I pull ${filesInitiatorMustSend.length}, They delete ${filesInitiatorMustDelete.length}, I delete ${filesReceiverMustDelete.length}`); 
            this.syncState.filesTotal = filesReceiverWillSend.length + filesInitiatorMustSend.length;
            
            if (filesReceiverWillSend.length === 0 && filesInitiatorMustSend.length === 0 && filesReceiverMustDelete.length === 0 && filesInitiatorMustDelete.length === 0) {
                this.log("Vaults are completely identical. No sync needed.");
                await this.sendSyncMessage(conn.peer, { type: 'sync-plan', filesReceiverWillSend, filesInitiatorMustSend, filesReceiverMustDelete, filesInitiatorMustDelete, fileSizes }); 
                this.transitionToPhase(SyncPhase.COMPLETING);
                this.handleFullSyncComplete();
                return;
            }

            await this.sendSyncMessage(conn.peer, { type: 'sync-plan', filesReceiverWillSend, filesInitiatorMustSend, filesReceiverMustDelete, filesInitiatorMustDelete, fileSizes }); 
            
            for (const path of filesReceiverMustDelete) {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file) {
                    this.ignoreNextEventForPath(path);
                    await this.app.vault.delete(file);
                    this.syncedHashes.delete(path);
                }
            }
            
            this.syncState.allowedPulls = new Set(filesReceiverWillSend);
            this.syncState.pendingPulls = new Set(filesInitiatorMustSend);
            this.requestNextBatch(conn.peer);
            
        } catch (e) {
            this.abortSync(e instanceof SyncError ? e : new SyncError(SyncErrorCategory.PROTOCOL_ERROR, String(e), false, "Check logs for error details."));
        }
    }
    
    async handleSyncPlan(data: SyncPlanPayload, conn: DataConnection) {
        if (!this.syncState.isSyncing || this.syncState.peerId !== conn.peer) return;
        if (this.syncState.currentPhase !== SyncPhase.PLANNING) {
            this.log(`Received sync plan but current phase is ${this.syncState.currentPhase}. Ignoring.`);
            return;
        }
        this.resetIdleTimeout();
        try {
            if (!data.filesReceiverWillSend || !data.filesInitiatorMustSend) throw new SyncError(SyncErrorCategory.PROTOCOL_ERROR, "Invalid sync plan received.", false, "Update plugin.");
            
            this.showNotice("Received sync plan. Exchanging files...", 'verbose'); 
            this.log(`Sync plan: I must pull ${data.filesReceiverWillSend.length}, They pull ${data.filesInitiatorMustSend.length}`); 
            this.syncState.filesTotal = data.filesReceiverWillSend.length + data.filesInitiatorMustSend.length;
            
            for (const path of data.filesInitiatorMustDelete || []) {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file) {
                    this.ignoreNextEventForPath(path);
                    await this.app.vault.delete(file);
                    this.syncedHashes.delete(path);
                }
            }
            
            for (const [path, size] of Object.entries(data.fileSizes)) {
                this.peerFileSizes[path] = size;
                if (data.filesReceiverWillSend.includes(path)) this.syncState.bytesTotal += size;
            }
            
            this.syncState.allowedPulls = new Set(data.filesInitiatorMustSend);
            this.syncState.pendingPulls = new Set(data.filesReceiverWillSend);
            
            if (this.syncState.pendingPulls.size === 0 && this.syncState.allowedPulls.size === 0) {
                this.transitionToPhase(SyncPhase.COMPLETING);
                this.handleFullSyncComplete();
            } else {
                this.requestNextBatch(conn.peer);
            }
        } catch (e) {
            this.log('Error processing sync plan:', e);
            this.abortSync(e instanceof SyncError ? e : new SyncError(SyncErrorCategory.PROTOCOL_ERROR, String(e), false, "Check logs for details."));
        }
    }
    
    private recordBatchTaskCompletion(batchId: string | undefined, path: string | undefined, success: boolean) {
        if (!batchId || !path) return;
        const batch = this.syncState.activeBatches.get(batchId);
        if (!batch) return;
        
        batch.sentCount++;
        if (success) {
            batch.succeededPaths.push(path);
        } else {
            batch.failedPaths.push(path);
        }
        
        if (batch.sentCount >= batch.totalCount) {
            this.sendSyncMessage(batch.peerId, { type: 'batch-complete', batchId: batch.batchId, receivedPaths: batch.succeededPaths, failedPaths: batch.failedPaths })
                .catch(e => this.abortSync(e));
            this.syncState.activeBatches.delete(batchId);
            this.checkFullSyncCompletion(batch.peerId);
        }
    }

    async handleRequestBatch(data: RequestBatchPayload, conn: DataConnection) {
        if (!this.syncState.isSyncing || this.syncState.peerId !== conn.peer) return;
        if (this.syncState.currentPhase !== SyncPhase.TRANSFERRING && this.syncState.currentPhase !== SyncPhase.PLANNING) return;
        this.transitionToPhase(SyncPhase.TRANSFERRING); // Reset timeout
        this.resetIdleTimeout();
        
        try {
            if (!data.paths || !data.batchId) throw new SyncError(SyncErrorCategory.PROTOCOL_ERROR, "Invalid batch request.", false, "Update plugin.");
            
            const allowed = this.syncState.allowedPulls;
            const batchId = data.batchId;
            const batchState: BatchState = {
                peerId: conn.peer,
                batchId,
                totalCount: data.paths.length,
                sentCount: 0,
                succeededPaths: [],
                failedPaths: []
            };
            this.syncState.activeBatches.set(batchId, batchState);
            
            for (const path of data.paths) {
                if (allowed.has(path)) {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                    this.addToQueueTask(conn.peer, { taskType: 'send-file', path, mtime: file.stat.mtime, forceFull: true, batchId });
                    allowed.delete(path);
                } else if (file instanceof TFolder) {
                    this.addToQueueTask(conn.peer, { taskType: 'send-folder-create', path, batchId });
                    allowed.delete(path);
                } else {
                    this.log(`Failed to read ${path} for batch, marking failed.`);
                    this.recordBatchTaskCompletion(batchId, path, false);
                }
            } else {
                this.log(`Peer requested unauthorized path ${path}. Marking failed.`);
                this.recordBatchTaskCompletion(batchId, path, false);
            }
        }
        
        if (data.paths.length === 0) {
            this.sendSyncMessage(conn.peer, { type: 'batch-complete', batchId, receivedPaths: [], failedPaths: [] }).catch(e => this.abortSync(e));
            this.syncState.activeBatches.delete(batchId);
            this.checkFullSyncCompletion(conn.peer);
        }
        } catch (e) {
            this.abortSync(e instanceof SyncError ? e : new SyncError(SyncErrorCategory.PROTOCOL_ERROR, String(e), false, "Check logs."));
        }
    }
    
    handleBatchComplete(data: BatchCompletePayload, conn: DataConnection) {
        if (!this.syncState.isSyncing || this.syncState.peerId !== conn.peer) return;
        if (this.syncState.currentPhase !== SyncPhase.TRANSFERRING) return;
        this.transitionToPhase(SyncPhase.TRANSFERRING); // Reset timeout
        this.resetIdleTimeout();
        
        try {
            if (!data.receivedPaths || !data.failedPaths) throw new SyncError(SyncErrorCategory.PROTOCOL_ERROR, "Invalid batch complete payload.", false, "Update plugin.");
            const pending = this.syncState.pendingPulls;
            
            for (const path of data.receivedPaths) {
                pending.delete(path);
                this.syncState.filesTransferred++;
                this.syncState.bytesTransferred += this.peerFileSizes[path] || 0;
            this.pullRetries.delete(path);
        }
        
        for (const path of data.failedPaths) {
            const retries = this.pullRetries.get(path) || 0;
            if (retries < 3) {
                this.pullRetries.set(path, retries + 1);
            } else {
                pending.delete(path);
                this.pullRetries.delete(path);
                this.log(`Failed to pull ${path} after 3 attempts. Giving up on this file.`);
            }
        }
        
        this.requestNextBatch(conn.peer);
        } catch (e) {
            this.abortSync(e instanceof SyncError ? e : new SyncError(SyncErrorCategory.PROTOCOL_ERROR, String(e), false, "Check logs."));
        }
    }
    
    requestNextBatch(peerId: string) {
        if (this.syncState.currentPhase !== SyncPhase.TRANSFERRING && this.syncState.currentPhase !== SyncPhase.PLANNING) return;
        const pending = this.syncState.pendingPulls;
        if (!pending || pending.size === 0) {
            this.transitionToPhase(SyncPhase.COMPLETING);
            this.checkFullSyncCompletion(peerId);
            return;
        }
        this.transitionToPhase(SyncPhase.TRANSFERRING);
        
        const paths: string[] = [];
        let totalSize = 0;
        
        const sortedPending = Array.from(pending).sort((a, b) => (this.peerFileSizes[a] || 0) - (this.peerFileSizes[b] || 0));
        
        for (const path of sortedPending) {
            const size = this.peerFileSizes[path] || 0;
            if (paths.length >= 10 || (totalSize + size > 50 * 1024 * 1024 && paths.length > 0)) {
                break;
            }
            paths.push(path);
            totalSize += size;
        }
        
        this.log(`Requesting batch of ${paths.length} files (${formatBytes(totalSize)}).`);
        const batchId = this.generateTransferId('batch');
        this.sendSyncMessage(peerId, { type: 'request-batch', paths, batchId }).catch(e => this.abortSync(e));
        this.resetIdleTimeout();
    }
    
    checkFullSyncCompletion(peerId: string) {
        const pending = this.syncState.pendingPulls;
        const allowed = this.syncState.allowedPulls;
        
        if ((!pending || pending.size === 0) && (!allowed || allowed.size === 0)) {
            if (!this.localSyncComplete.get(peerId)) {
                this.localSyncComplete.set(peerId, true);
                this.sendSyncMessage(peerId, { type: 'full-sync-complete' }).catch(e => this.abortSync(e));
            }
            if (this.localSyncComplete.get(peerId) && this.peerSyncComplete.get(peerId)) {
                this.handleFullSyncComplete();
            }
        }
    }

    handleFullSyncComplete() { 
        if (!this.syncState.isSyncing) return; 
        if (this.syncIdleTimeout) { clearTimeout(this.syncIdleTimeout); this.syncIdleTimeout = null; } 
        if (this.syncKeepAliveInterval) { clearInterval(this.syncKeepAliveInterval); this.syncKeepAliveInterval = null; }
        if (this.syncState.phaseTimeoutHandle) { clearTimeout(this.syncState.phaseTimeoutHandle); this.syncState.phaseTimeoutHandle = null; }
        this.syncState.isSyncing = false; 
        this.syncState.currentPhase = SyncPhase.IDLE;
        this.currentSyncIsTwoDeviceMode = null;
        this.syncState.pendingPulls.clear();
        this.syncState.allowedPulls.clear();
        this.pullRetries.clear();
        this.syncState.activeBatches.clear();
        this.localSyncComplete.clear();
        this.peerSyncComplete.clear();
        this.syncState.peerId = null;
        this.peerFileSizes = {};
        this.processQueue(); 
        this.updateStatus(); 
        this.showNotice(`Sync complete. Transferred ${this.syncState.filesTransferred} files.`, 'important'); 
    }

    handleRequestFile(data: RequestFilePayload, conn: DataConnection) {
        const file = this.app.vault.getAbstractFileByPath(data.path);
        if (file instanceof TFile) {
            this.sendFileUpdate(file, conn.peer);
        }
    }
    
    private async buildVaultManifest(): Promise<VaultManifest> { 
        const manifest: VaultManifest = []; 
        const allFiles = this.app.vault.getAllLoadedFiles(); 

        let count = 0;
        for (const file of allFiles) { 
            if (this.isPathSyncable(file.path)) { 
                if (file instanceof TFolder) { 
                    if (file.path !== '/') manifest.push({ type: 'folder', path: file.path }); 
                } else if (file instanceof TFile) { 
                    let hash = this.syncedHashes.get(file.path)?.hash;
                    let vv = (this.currentSyncIsTwoDeviceMode ?? this.isTwoDeviceMode()) ? this.twoDeviceState.fileVersions[file.path] : undefined;
                    manifest.push({ type: 'file', path: file.path, mtime: file.stat.mtime, size: file.stat.size, hash, versionVector: vv }); 
                    
                    count++;
                    if (count % 50 === 0) {
                        this.updateStatus({ text: `Building manifest (${count}/${allFiles.length})...`, icon: 'loader', spin: true, state: 'loading' });
                        await new Promise(r => setTimeout(r, 0));
                    }
                } 
            } 
        }
        for (const [path, timestamp] of Object.entries(this.tombstones)) {
            manifest.push({ type: 'deleted', path, mtime: timestamp, size: 0 });
        }
        return manifest; 
    }

    private isPathSyncable(path: string): boolean {
        const excluded = this.settings.excludedFolders.split('\n').map(p => p.trim()).filter(Boolean);
        if (excluded.length > 0 && excluded.some(p => path.startsWith(p))) { return false; }

        if (path.startsWith('.obsidian/')) {
            if (this.settings.syncMode === 'auto') {
                const safePaths = ['.obsidian/snippets/', '.obsidian/themes/', '.obsidian/appearance.json'];
                return safePaths.some(safe => path.startsWith(safe));
            } else {
                return this.settings.syncObsidianConfig;
            }
        }

        if (this.settings.syncMode === 'manual' || this.settings.syncMode === 'advanced') {
            const included = this.settings.includedFolders.split('\n').map(p => p.trim()).filter(Boolean);
            if (included.length > 0 && !included.some(p => path.startsWith(p))) { return false; }
        }
        return true;
    }
    public isBinary(extension: string): boolean { const textExtensions = ['md', 'txt', 'json', 'css', 'js', 'html', 'xml', 'csv', 'yaml', 'toml']; return !textExtensions.includes((extension || '').toLowerCase()); }
    private async areArrayBuffersEqual(buf1: ArrayBuffer, buf2: ArrayBuffer): Promise<boolean> { 
        if (buf1.byteLength !== buf2.byteLength) return false; 
        if (buf1.byteLength < 50 * 1024) {
            const view1 = new Uint8Array(buf1); 
            const view2 = new Uint8Array(buf2); 
            for (let i = 0; i < buf1.byteLength; i++) { 
                if (view1[i] !== view2[i]) return false; 
            } 
            return true; 
        }
        const hash1 = await this.getHash(buf1);
        const hash2 = await this.getHash(buf2);
        return hash1 === hash2;
    }
    private shouldIgnoreEvent(path: string): boolean { const ignoreUntil = this.ignoreEvents.get(path); if (ignoreUntil && Date.now() < ignoreUntil) { return true; } this.ignoreEvents.delete(path); return false; }
    public ignoreNextEventForPath(path: string, durationMs = 2000) { this.ignoreEvents.set(path, Date.now() + durationMs); }
    getConflictPath(originalPath: string): string { const extension = originalPath.split('.').pop() || ''; const base = originalPath.substring(0, originalPath.lastIndexOf('.')); const date = new Date().toISOString().split('T')[0]; return `${base} (conflict on ${date}).${extension}`; }
    getLocalIp(): string | null { if (Platform.isMobile) return null; try { const os = require('os'); const interfaces = os.networkInterfaces(); for (const name in interfaces) { for (const net of interfaces[name]!) { if (net.family === 'IPv4' && !net.internal) return net.address; } } } catch (e) { console.warn("Could not get local IP address.", e); } return null; }
    getMyPeerInfo(): PeerInfo {
        const mode = this.getConnectionMode();
        let port: number | undefined;
        if (mode === 'direct-ip' && this.directIpServer) {
            port = this.settings.directIpHostPort;
        }
        return { 
            deviceId: this.peer?.id || this.settings.deviceId, 
            friendlyName: this.settings.friendlyName, 
            ip: this.getLocalIp(),
            mode: mode,
            port: port
        }; 
    }
    public startDirectIpHost() { if (Platform.isMobile) return; this.reinitializeConnectionManager(); const pin = Array.from(window.crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join(''); this.directIpServer = new DirectIpServer(this, this.settings.directIpHostPort, pin); this.updateStatus(); return pin; }
    public async connectToDirectIpHost(config: DirectIpConfig) { this.reinitializeConnectionManager(); this.directIpClient = new DirectIpClient(this, config); this.clusterPeers.set(config.host, { deviceId: config.host, friendlyName: `Host (${config.host})`, ip: config.host }); this.updateStatus(); }
    
    injectStatusBarStyles() {
        const styleId = 'obsidian-decentralized-status-styles';
        const existing = document.getElementById(styleId);
        if (existing) existing.remove();
        const style = document.createElement('style');
        style.id = styleId;
        style.innerHTML = `
            .lucide-spin {
                animation: od-spin 2s linear infinite;
            }
            @keyframes od-spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
            .od-status-icon {
                display: inline-flex;
                align-items: center;
                margin-right: 6px;
            }
            .od-status-icon svg {
                width: 14px;
                height: 14px;
            }
            .od-status-icon {
                display: inline-block;
                vertical-align: middle;
                margin-right: 6px;
            }
            .od-status-container {
                display: flex;
                align-items: center;
                line-height: 1;
            }
            .od-status-container:hover {
                color: var(--text-normal);
            }
            body.od-hide-native-sync .status-bar-item.plugin-sync {
                display: none !important;
            }
            .od-status-container.mod-clickable { cursor: pointer; }
            .od-progress-modal .od-transfer-item { margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid var(--background-modifier-border); }
            .od-progress-modal .od-transfer-meta { display: flex; justify-content: space-between; font-size: 0.85em; color: var(--text-muted); margin-top: 6px; }
            .od-progress-modal progress { width: 100%; height: 6px; border-radius: var(--radius-s); overflow: hidden; border: none; background: var(--background-modifier-border); margin-top: 8px; }
            .od-progress-modal progress::-webkit-progress-bar { background: var(--background-modifier-border); }
            .od-progress-modal progress::-webkit-progress-value { background: var(--interactive-accent); transition: width 0.2s ease; }
            .od-transfer-icon { display: inline-flex; align-items: center; vertical-align: middle; color: var(--text-muted); }
            .od-transfer-icon svg { width: 14px; height: 14px; }
            
            .od-editable-name-container {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                padding: 4px 8px;
                border: 1px solid transparent;
                border-radius: var(--radius-s);
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .od-editable-name-container:hover {
                border-color: var(--background-modifier-border);
                background-color: var(--background-primary-alt);
            }
            .od-editable-name-icon { color: var(--text-muted); opacity: 0.5; display: flex; }
            .od-editable-name-container:hover .od-editable-name-icon { opacity: 1; }
            .od-editable-name-input { margin: 0; height: 28px; background: var(--background-modifier-form-field); border: 1px solid var(--background-modifier-border-focus); border-radius: var(--radius-s); color: var(--text-normal); }
            .od-editable-name-submit { color: var(--interactive-success); cursor: pointer; display: flex; padding: 4px; border-radius: var(--radius-s); transition: background-color 0.15s; }
            .od-editable-name-submit:hover { background-color: var(--background-modifier-hover); }
            .od-setting-item-name-wrapper { display: flex; align-items: center; }
        `;
        document.head.appendChild(style);
    }

    public calculateStatus(): SyncStatusState {
        if (this.syncState.isSyncing) {
            let text = "Syncing...";
            if (this.syncState.currentPhase === SyncPhase.REQUESTING) text = "Requesting Sync...";
            else if (this.syncState.currentPhase === SyncPhase.PLANNING) text = "Comparing Vaults...";
            else if (this.syncState.currentPhase === SyncPhase.TRANSFERRING) text = `Syncing (${this.syncState.filesTransferred}/${this.syncState.filesTotal})...`;
            else if (this.syncState.currentPhase === SyncPhase.COMPLETING) text = "Completing Sync...";
            return { text, icon: "refresh-cw", spin: true, state: 'loading' };
        }
        if (this.activeTransfers.size > 0) {
            const count = Array.from(this.activeTransfers.values()).filter(t => t.status === 'active').length;
            if (count === 0 && this.activeTransfers.size > 0) return { text: "Transfers Paused", icon: "pause-circle", state: 'neutral' };
            return { text: `Syncing ${count} file${count > 1 ? 's' : ''}...`, icon: "arrow-up-down", spin: false, state: 'loading' };
        }
        if (this.activeQueueTransfers > 0 || this.syncQueue.length > 0) {
            const queueSize = this.syncQueue.length + this.activeQueueTransfers;
            return { text: `Syncing (${queueSize} item${queueSize > 1 ? 's' : ''})`, icon: "hourglass", state: 'loading' };
        }
        if (this.getConnectionMode() === 'direct-ip') {
            const isAuto = this.settings.syncMode === 'auto';
            if (this.directIpServer) return { text: isAuto ? "Hosting Offline" : "Host Mode", icon: "server", state: 'success' };
            if (this.directIpClient) return { text: isAuto ? "Connected Offline" : "Client Mode", icon: "smartphone", state: 'success' };
            return { text: isAuto ? "Offline Mode" : "Offline Mode", icon: "network", state: 'neutral' };
        }
        if (!this.peer || this.peer.disconnected) return { text: "Sync Offline", icon: "wifi-off", state: 'error' };
        if (!this.peer.id) return { text: "Connecting...", icon: "plug", spin: true, state: 'loading' };
        if (this.connections.size > 0) {
            if (this.isTwoDeviceMode()) return { text: "Paired Sync Active", icon: "link", state: 'success' };
            return { text: `Connected (${this.connections.size})`, icon: "users", state: 'success' };
        }
        return { text: "Online", icon: "globe", state: 'neutral' };
    }

    updateStatus(customStatus?: SyncStatusState) {
        const now = Date.now();
        const isIdle = this.activeTransfers.size === 0 && this.activeQueueTransfers === 0 && this.syncQueue.length === 0;
        if (!customStatus && !isIdle && now - this.lastStatusUpdate < 200) return;
        this.lastStatusUpdate = now;

        const status = customStatus || this.calculateStatus();
        this.statusBar.empty();
        const container = this.statusBar.createDiv({ cls: 'od-status-container' });

        if (status.state === 'loading') {
            container.addClass('mod-clickable');
            container.onclick = () => new SyncProgressModal(this.app, this).open();
        }

        const iconEl = container.createDiv({ cls: 'od-status-icon' });
        setIcon(iconEl, status.icon);
        if (status.spin) iconEl.addClass('lucide-spin');

        if (status.state === 'error') iconEl.style.color = 'var(--text-error)';
        else if (status.state === 'success') iconEl.style.color = 'var(--text-success)';
        else if (status.state === 'loading') iconEl.style.color = 'var(--interactive-accent)';
        else iconEl.style.color = 'var(--text-muted)';

        container.createSpan({ text: status.text });
    }
}

class ConnectionModal extends Modal {
    private discoveredPeers: Map<string, PeerInfo> = new Map();
    private discoverListener: ((p: PeerInfo) => void) | null = null;
    private loseListener: ((p: PeerInfo) => void) | null = null;
    
    private activeTab: 'quick-pair' | 'advanced' = 'quick-pair';
    private statusState: 'idle' | 'connecting' | 'connected' | 'error' = 'idle';
    private statusMessage: string = 'Not connected';
    private activePsk: string | null = null;

    constructor(app: App, private plugin: ObsidianDecentralizedPlugin) { super(app); }

    async onOpen() {
        this.injectStyles();
        this.contentEl.addClass(Platform.isMobile ? 'od-mobile' : 'od-desktop');
        
        if (this.plugin.connections.size > 0) {
            this.statusState = 'connected';
            this.statusMessage = `Connected to ${this.plugin.connections.size} device(s)`;
        }
        
        this.activePsk = await this.plugin.generatePSK();
        
        this.render();
    }

    onClose() {
        if (this.discoverListener) this.plugin.lanDiscovery.off('discover', this.discoverListener);
        if (this.loseListener) this.plugin.lanDiscovery.off('lose', this.loseListener);
        this.contentEl.empty();
    }

    injectStyles() {
        const styleId = 'obsidian-decentralized-styles';
        const existing = document.getElementById(styleId);
        if (existing) existing.remove();
        const style = document.createElement('style');
        style.id = styleId;
        style.innerHTML = `
            .od-dashboard-header { text-align: center; margin-bottom: 5px; font-weight: 600; color: var(--text-normal); }
            .od-dashboard-subtitle { text-align: center; color: var(--text-muted); font-size: 0.9em; margin-bottom: 20px; }
            .od-id-container { background: var(--background-modifier-form-field); padding: 15px; border-radius: var(--radius-m); user-select: all; font-family: var(--font-monospace); cursor: pointer; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--background-modifier-border); transition: all 0.2s ease; }
            .od-id-container:hover { border-color: var(--interactive-accent); box-shadow: 0 0 0 1px var(--interactive-accent); }
            .od-section-title { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; color: var(--text-muted); margin-top: 15px; margin-bottom: 10px; }
            .od-section-divider { height: 1px; background: var(--background-modifier-border); margin: 25px 0; }
            .od-peer-list { display: flex; flex-direction: column; gap: 8px; }
            .od-peer-item { padding: 12px; background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: var(--radius-m); display: flex; align-items: center; justify-content: space-between; transition: background 0.1s; }
            .od-peer-item:hover { background: var(--background-modifier-hover); }
            .od-peer-item .info { display: flex; flex-direction: column; }
            .od-peer-item .sub-text { font-size: 0.8em; color: var(--text-muted); margin-top: 2px; }
            .od-mode-switch { margin-top: 40px; text-align: center; font-size: 0.85em; color: var(--text-muted); cursor: pointer; text-decoration: none; opacity: 0.7; transition: opacity 0.2s; }
            .od-mode-switch:hover { opacity: 1; text-decoration: underline; }
            .od-input-row { display: flex; gap: 10px; margin-bottom: 5px; }
            .od-input-row input { flex-grow: 1; }
            .od-right-align { display: flex; justify-content: flex-end; }

            .od-id-name { font-weight: bold; margin-bottom: 4px; }
            .od-id-value { font-size: 0.9em; color: var(--text-muted); }
            .od-scanning { color: var(--text-muted); font-style: italic; display: flex; align-items: center; justify-content: center; padding: 20px; }
            .od-peer-name { font-weight: bold; }
            .od-full-width { width: 100%; }
            .od-ip-display { font-size: 1.2em; text-align: center; margin: 10px; }
            .od-pin-display { font-size: 2em; font-weight: bold; text-align: center; margin: 20px; }
            .od-text-muted { color: var(--text-muted); }

            /* Tabs & Banner */
            .od-connection-tabs { display: flex; justify-content: center; gap: 10px; margin-bottom: 20px; border-bottom: 1px solid var(--background-modifier-border); padding-bottom: 10px; }
            .od-tab-btn { background: transparent; border: none; box-shadow: none; color: var(--text-muted); font-weight: 600; cursor: pointer; padding: 6px 16px; border-radius: var(--radius-s); transition: all 0.2s; }
            .od-tab-btn:hover { color: var(--text-normal); background: var(--background-modifier-hover); }
            .od-tab-btn.active { color: var(--text-normal); background: var(--background-modifier-active-hover); }
            
            .od-status-banner { padding: 12px; border-radius: var(--radius-m); margin-bottom: 20px; text-align: center; font-weight: 500; display: flex; align-items: center; justify-content: center; gap: 8px; }
            .od-status-banner.idle { background: var(--background-primary-alt); border: 1px solid var(--background-modifier-border); color: var(--text-muted); }
            .od-status-banner.connecting { background: var(--background-modifier-hover); color: var(--text-normal); }
            .od-status-banner.connected { background: var(--background-modifier-success); color: var(--text-success); border: 1px solid var(--background-modifier-success-hover); }
            .od-status-banner.error { background: var(--background-modifier-error); color: var(--text-error); border: 1px solid var(--background-modifier-error-hover); }

            /* Quick Pair specifics */
            .od-step-header { font-size: 1.1em; font-weight: 600; color: var(--text-normal); margin-top: 20px; margin-bottom: 10px; }
            .od-pairing-code-container { display: flex; align-items: center; justify-content: center; gap: 10px; background: var(--background-modifier-form-field); padding: 15px; border-radius: var(--radius-m); border: 1px solid var(--background-modifier-border); margin: 10px 0; }
            .od-pairing-code-text { font-family: var(--font-monospace); font-size: 1.5em; font-weight: bold; letter-spacing: 0.05em; color: var(--text-normal); user-select: all; }
            .od-instruction-text { text-align: center; color: var(--text-muted); font-size: 0.9em; margin-bottom: 15px; }
            
            .od-qr-section { display: flex; flex-direction: column; align-items: center; margin-top: 15px; padding: 15px; background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: var(--radius-m); }
            .od-qr-section img { width: 150px; height: 150px; border-radius: var(--radius-s); margin-bottom: 10px; }
            .od-qr-label { font-size: 0.9em; color: var(--text-muted); margin-bottom: 8px; font-weight: 600; }
            
            .od-lan-card { padding: 15px; background: var(--background-primary-alt); border: 1px solid var(--background-modifier-border); border-radius: var(--radius-m); cursor: pointer; transition: all 0.2s; text-align: center; display: flex; flex-direction: column; gap: 4px; }
            .od-lan-card:hover { border-color: var(--interactive-accent); background: var(--background-modifier-hover); transform: translateY(-1px); }
            .od-pulsing-indicator { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--interactive-accent); animation: pulse 1.5s infinite; margin-right: 8px; }
            @keyframes pulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.5); } 100% { opacity: 1; transform: scale(1); } }

            /* Responsive & Platform Specifics */
            .od-desktop .od-full-width { width: auto; min-width: 200px; display: block; margin: 10px auto; }
            .od-desktop .od-direct-ip-wrapper { max-width: 400px; margin: 0 auto; }
            .od-desktop .od-direct-ip-wrapper input { margin-bottom: 10px; width: 100%; }
            .od-desktop .od-id-container { max-width: 500px; margin: 0 auto; }
            .od-desktop .od-peer-list { max-width: 600px; margin: 0 auto; }
            .od-desktop .od-section-title { text-align: center; max-width: 600px; margin-left: auto; margin-right: auto; }
            .od-desktop .od-input-row { max-width: 500px; margin: 0 auto 10px auto; }
            
            .od-mobile .od-full-width { width: 100%; margin-top: 10px; }
            .od-mobile .od-input-row { flex-direction: column; }
            .od-mobile .od-input-row button { width: 100%; margin-top: 5px; }
        `;
        document.head.appendChild(style);
    }

    formatPairingCodeForDisplay(deviceId: string): string {
        if (deviceId.startsWith('device-') && deviceId.length === 15) {
            const hex = deviceId.substring(7);
            return `device-${hex.substring(0, 4)}-${hex.substring(4)}`;
        }
        return deviceId;
    }

    normalizePairingCodeInput(input: string): string {
        let cleaned = input.trim().replace(/\s+/g, '');
        if (cleaned.startsWith('device-')) {
            const hexPart = cleaned.substring(7).replace(/-/g, '');
            return `device-${hexPart}`;
        }
        const justHex = cleaned.replace(/-/g, '');
        if (justHex.length === 8 && /^[0-9a-fA-F]{8}$/.test(justHex)) {
            return `device-${justHex.toLowerCase()}`;
        }
        return cleaned;
    }

    render() {
        this.contentEl.empty();
        this.renderStatusBanner();
        this.renderTabNavigation();
        
        if (this.activeTab === 'quick-pair') {
            this.renderQuickPairTab();
        } else {
            this.renderAdvancedTab();
        }
    }

    renderStatusBanner() {
        const banner = this.contentEl.createDiv({ cls: `od-status-banner ${this.statusState}` });
        
        if (this.statusState === 'connecting') {
            const spinner = banner.createSpan();
            setIcon(spinner, 'loader');
            spinner.addClass('lucide-spin');
        } else if (this.statusState === 'connected') {
            const check = banner.createSpan();
            setIcon(check, 'check-circle');
        } else if (this.statusState === 'error') {
            const alert = banner.createSpan();
            setIcon(alert, 'alert-triangle');
        }
        
        banner.createSpan({ text: this.statusMessage });
    }

    renderTabNavigation() {
        const tabsContainer = this.contentEl.createDiv({ cls: 'od-connection-tabs' });
        
        const quickPairBtn = tabsContainer.createEl('button', { text: 'Quick Pair', cls: `od-tab-btn ${this.activeTab === 'quick-pair' ? 'active' : ''}` });
        quickPairBtn.onclick = () => { this.activeTab = 'quick-pair'; this.render(); };
        
        const advancedBtn = tabsContainer.createEl('button', { text: 'Advanced', cls: `od-tab-btn ${this.activeTab === 'advanced' ? 'active' : ''}` });
        advancedBtn.onclick = () => { this.activeTab = 'advanced'; this.render(); };
    }

    async attemptConnection(scannedId: string) {
        if (!scannedId.trim()) return;
        
        const parts = scannedId.split('|');
        const peerId = this.normalizePairingCodeInput(parts[0]);
        const psk = parts[1];
        
        if (psk) {
            this.plugin.settings.peerKeys[peerId] = psk;
            await this.plugin.saveSettings();
        }
        
        this.statusState = 'connecting';
        this.statusMessage = `Connecting to ${peerId}...`;
        this.render();

        const conn = this.plugin.peer?.connect(peerId);
        if (!conn) {
            this.statusState = 'error';
            this.statusMessage = 'Failed to initiate connection. Are you online?';
            this.render();
            return;
        }

        conn.on('open', () => {
            this.statusState = 'connected';
            this.statusMessage = `Connected to ${conn.peer}`;
            this.plugin.setupConnection(conn);
            this.render();
            setTimeout(() => this.close(), 1500);
        });

        conn.on('error', (err) => {
            this.statusState = 'error';
            this.statusMessage = `Connection failed. Try again.`;
            this.render();
        });
    }

    renderQuickPairTab() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Quick Pair', cls: 'od-dashboard-header' });
        contentEl.createDiv({ text: 'Connect devices easily using codes or QR', cls: 'od-dashboard-subtitle' });

        const myInfo = this.plugin.getMyPeerInfo();

        // Step 1: Share Your Code
        contentEl.createDiv({ text: 'Step 1: Share Your Code', cls: 'od-step-header' });
        
        const codeContainer = contentEl.createDiv({ cls: 'od-pairing-code-container' });
        const formattedCode = this.formatPairingCodeForDisplay(myInfo.deviceId);
        codeContainer.createDiv({ text: formattedCode, cls: 'od-pairing-code-text' });
        
        const qrPayload = `${myInfo.deviceId}|${this.activePsk || ''}`;
        
        const copyBtn = codeContainer.createEl('button', { text: 'Copy' });
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(qrPayload);
            copyBtn.setText('Copied!');
            setTimeout(() => copyBtn.setText('Copy'), 2000);
        };
        
        contentEl.createDiv({ text: 'Type this code on your other device to connect', cls: 'od-instruction-text' });
        
        const qrSection = contentEl.createDiv({ cls: 'od-qr-section' });
        qrSection.createDiv({ text: 'Or scan QR code (Includes Encryption Key)', cls: 'od-qr-label' });
        
        const imgEl = qrSection.createEl('img');
        QRCode.toDataURL(qrPayload, { width: 150, margin: 2 }).then(url => {
            imgEl.src = url;
        }).catch(err => {
            qrSection.createEl('p', { text: 'Failed to load QR code.', cls: 'od-text-muted' });
        });
        
        const scanBtn = qrSection.createEl('button', { text: 'Scan QR Code', cls: 'od-full-width' });
        scanBtn.onclick = () => {
            new QRScannerModal(this.app, (scannedId) => {
                this.attemptConnection(scannedId);
            }).open();
        };

        contentEl.createDiv({ cls: 'od-section-divider' });

        // Step 2: Enter Their Code
        contentEl.createDiv({ text: 'Step 2: Enter Their Code', cls: 'od-step-header' });
        
        const inputRow = contentEl.createDiv({ cls: 'od-input-row' });
        const input = inputRow.createEl('input', { type: 'text', placeholder: 'Enter their pairing code or paste full key' });
        
        const connectBtn = inputRow.createEl('button', { text: 'Connect', cls: 'mod-cta' });
        connectBtn.onclick = () => {
            this.attemptConnection(input.value);
        };

        // LAN Discovery
        if (!Platform.isMobile) {
            contentEl.createDiv({ cls: 'od-section-divider' });
            contentEl.createDiv({ text: 'Or connect to nearby devices', cls: 'od-step-header' });
            
            const lanList = contentEl.createDiv({ cls: 'od-peer-list' });
            
            const renderLanList = () => {
                lanList.empty();
                if (this.discoveredPeers.size === 0) {
                    const emptyState = lanList.createDiv({ cls: 'od-scanning' });
                    emptyState.createSpan({ cls: 'od-pulsing-indicator' });
                    emptyState.createSpan({ text: 'Scanning for devices...' });
                } else {
                    this.discoveredPeers.forEach((peer) => {
                        const card = lanList.createDiv({ cls: 'od-lan-card mod-clickable' });
                        card.createDiv({ text: peer.friendlyName, cls: 'od-peer-name' });
                        card.createDiv({ text: Platform.isMobile ? 'Tap to connect' : 'Click to connect', cls: 'od-text-muted' });
                        card.onclick = () => this.attemptConnection(peer.deviceId);
                    });
                }
            };
            
            if (this.discoverListener) this.plugin.lanDiscovery.off('discover', this.discoverListener);
            if (this.loseListener) this.plugin.lanDiscovery.off('lose', this.loseListener);

            this.discoverListener = (p: PeerInfo) => { this.discoveredPeers.set(p.deviceId, p); renderLanList(); };
            this.loseListener = (p: PeerInfo) => { this.discoveredPeers.delete(p.deviceId); renderLanList(); };

            this.plugin.lanDiscovery.on('discover', this.discoverListener);
            this.plugin.lanDiscovery.on('lose', this.loseListener);
            this.plugin.lanDiscovery.startBroadcasting(this.plugin.getMyPeerInfo());
            this.plugin.lanDiscovery.startListening();
            renderLanList();
        }
    }

    renderAdvancedTab() {
        const { contentEl } = this;

        if (this.plugin.settings.connectionMode === 'direct-ip') {
            this.renderDirectIpDashboard();
            return;
        }

        contentEl.createEl('h2', { text: 'Advanced Configuration', cls: 'od-dashboard-header' });
        contentEl.createDiv({ text: 'Manual connection options and settings', cls: 'od-dashboard-subtitle' });

        // Offline Mode Switch
        contentEl.createDiv({ cls: 'od-section-title', text: 'Offline Mode (Direct IP)' });
        contentEl.createEl('p', { text: 'Use Offline Mode when you have no internet access but are on the same local network.', cls: 'od-text-muted', attr: { style: 'font-size: 0.85em;' } });
        
        const footer = contentEl.createDiv({ cls: 'od-mode-switch', attr: { style: 'margin-top: 10px;' } });
        footer.setText("Switch to Offline Mode");
        footer.onclick = async () => {
            this.plugin.settings.connectionMode = 'direct-ip';
            await this.plugin.saveSettings();
            this.plugin.reinitializeConnectionManager();
            this.render();
        };
    }

    renderDirectIpDashboard() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Offline Mode', cls: 'od-dashboard-header' });
        contentEl.createDiv({ text: 'Connect directly over your local network', cls: 'od-dashboard-subtitle' });
        
        const container = contentEl.createDiv({ cls: 'od-direct-ip-wrapper' });

        container.createDiv({ cls: 'od-section-title', text: 'Step 1: Host a Network (Main device)' });
        if (!Platform.isMobile) {
            const hostBtn = container.createEl('button', { text: 'Start Hosting', cls: 'mod-cta od-full-width' });
            hostBtn.onclick = () => {
                const pin = this.plugin.startDirectIpHost();
                if (pin) {
                    contentEl.empty();
                    contentEl.createEl('h2', { text: 'Hosting Active', cls: 'od-dashboard-header' });
                    contentEl.createDiv({ text: `IP: ${this.plugin.getLocalIp()}`, cls: 'od-ip-display' });
                    contentEl.createDiv({ text: `Token: ${pin}`, cls: 'od-pin-display', attr: { style: 'font-size: 1.2em; word-break: break-all;' } });
                    contentEl.createEl('button', { text: 'Done', cls: 'od-full-width', attr: { style: 'margin-top: 20px;' } }).onclick = () => this.close();
                }
            };
        } else {
            container.createDiv({ text: 'Hosting is not available on mobile.', cls: 'od-text-muted' });
        }

        if (!Platform.isMobile) {
            container.createDiv({ cls: 'od-section-title', text: 'Discovered Hosts' });
            const lanList = container.createDiv({ cls: 'od-peer-list' });
            const renderLanList = () => {
                lanList.empty();
                if (this.discoveredPeers.size === 0) {
                    const emptyState = lanList.createDiv({ cls: 'od-scanning' });
                    emptyState.createSpan({ cls: 'od-pulsing-indicator' });
                    emptyState.createSpan({ text: 'Scanning for hosts...' });
                } else {
                    this.discoveredPeers.forEach((peer) => {
                        const item = lanList.createDiv({ cls: 'od-peer-item' });
                        const info = item.createDiv({ cls: 'info' });
                        info.createDiv({ text: peer.friendlyName, cls: 'od-peer-name' });
                        info.createDiv({ text: `${peer.ip || 'Unknown IP'}:${peer.port || '???'}`, cls: 'sub-text' });
                        const btn = item.createEl('button', { text: 'Select' });
                        btn.onclick = async () => {
                            if (peer.ip) ipInput.value = peer.ip;
                            if (peer.port) { this.plugin.settings.directIpHostPort = peer.port; await this.plugin.saveSettings(); }
                            new Notice(`Selected ${peer.friendlyName}`);
                        };
                    });
                }
            };
            
            if (this.discoverListener) this.plugin.lanDiscovery.off('discover', this.discoverListener);
            if (this.loseListener) this.plugin.lanDiscovery.off('lose', this.loseListener);

            this.discoverListener = (p: PeerInfo) => { this.discoveredPeers.set(p.deviceId, p); renderLanList(); };
            this.loseListener = (p: PeerInfo) => { this.discoveredPeers.delete(p.deviceId); renderLanList(); };

            this.plugin.lanDiscovery.on('discover', this.discoverListener);
            this.plugin.lanDiscovery.on('lose', this.loseListener);
            this.plugin.lanDiscovery.startBroadcasting(this.plugin.getMyPeerInfo());
            this.plugin.lanDiscovery.startListening();
            renderLanList();
        }

        container.createDiv({ cls: 'od-section-divider' });

        container.createDiv({ cls: 'od-section-title', text: 'Step 2: Join a Network (Other devices)' });
        const ipInput = container.createEl('input', { type: 'text', placeholder: 'Host IP Address' });
        ipInput.value = this.plugin.settings.directIpHostAddress;
        if (Platform.isMobile) { ipInput.style.width = '100%'; ipInput.style.marginBottom = '10px'; }
        
        const pinInput = container.createEl('input', { type: 'text', placeholder: 'Security Token' });
        if (Platform.isMobile) { pinInput.style.width = '100%'; pinInput.style.marginBottom = '10px'; }

        const connectBtn = container.createEl('button', { text: 'Connect', cls: 'mod-cta od-full-width' });
        connectBtn.onclick = async () => {
            if (ipInput.value && pinInput.value) {
                this.plugin.settings.directIpHostAddress = ipInput.value;
                await this.plugin.saveSettings();
                this.plugin.connectToDirectIpHost({ host: ipInput.value, port: this.plugin.settings.directIpHostPort, pin: pinInput.value });
                this.close();
            }
        };

        const footer = contentEl.createDiv({ cls: 'od-mode-switch' });
        footer.setText("Switch to Standard Mode");
        footer.onclick = async () => {
            this.plugin.settings.connectionMode = 'peerjs';
            await this.plugin.saveSettings();
            this.plugin.reinitializeConnectionManager();
            this.render();
        };
    }
}

class QRScannerModal extends Modal {
    private html5QrCode: Html5Qrcode | null = null;
    constructor(app: App, private onScan: (text: string) => void) { super(app); }
    
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Scan QR Code' });
        const readerId = 'od-qr-reader';
        contentEl.createDiv({ attr: { id: readerId } });
        
        this.html5QrCode = new Html5Qrcode(readerId);
        this.html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 250, height: 250 } }, (decodedText) => {
            this.onScan(decodedText);
            this.close();
        }, () => {}).catch(err => {
            contentEl.createEl('p', { text: 'Error starting camera: ' + err, cls: 'mod-warning' });
        });
    }
    
    onClose() {
        if (this.html5QrCode && this.html5QrCode.isScanning) { this.html5QrCode.stop().then(() => this.html5QrCode?.clear()).catch(console.error); }
        this.contentEl.empty();
    }
}

class SelectPeerModal extends Modal { constructor(app: App, private connections: Map<string, DataConnection>, private clusterPeers: Map<string, PeerInfo>, private onSubmit: (peerId: string) => void) { super(app); } onOpen() { const { contentEl } = this; contentEl.createEl('h2', { text: 'Force Full Sync with Peer' }); contentEl.createEl('p', { text: 'This will perform a two-way sync. Files will be exchanged based on which is newer. This is the safest way to reconcile two vaults.' }).addClass('mod-warning'); let selectedPeer = ''; const peerList = Array.from(this.connections.keys()); if (peerList.length === 0) { contentEl.createEl('p', { text: 'No peers are currently connected.' }); new Setting(contentEl).addButton(btn => btn.setButtonText("OK").onClick(() => this.close())); return; } new Setting(contentEl).setName('Sync with Device').addDropdown(dropdown => { peerList.forEach(peerId => { const peerInfo = this.clusterPeers.get(peerId); dropdown.addOption(peerId, peerInfo?.friendlyName || peerId); }); selectedPeer = dropdown.getValue(); dropdown.onChange(value => selectedPeer = value); }); new Setting(contentEl) .addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close())) .addButton(btn => btn.setButtonText('Start Full Sync').setWarning().onClick(() => { if (selectedPeer) this.onSubmit(selectedPeer); this.close(); })); } onClose() { this.contentEl.empty(); } }
class ConflictCenter { private conflicts: Map<string, string> = new Map(); private ribbonEl: HTMLElement | null = null; constructor(private app: App, private plugin: ObsidianDecentralizedPlugin) { } registerRibbon() { this.ribbonEl = this.plugin.addRibbonIcon('swords', 'Resolve Sync Conflicts', () => this.showConflictList()); this.ribbonEl.style.display = 'none'; } addConflict(originalPath: string, conflictPath: string) { this.conflicts.set(originalPath, conflictPath); this.updateRibbon(); } resolveConflict(originalPath: string) { this.conflicts.delete(originalPath); this.updateRibbon(); } updateRibbon() { if (!this.ribbonEl) return; if (this.conflicts.size > 0) { this.ribbonEl.show(); this.ribbonEl.setAttribute('aria-label', `Resolve ${this.conflicts.size} sync conflicts`); this.ribbonEl.setText(this.conflicts.size.toString()); } else { this.ribbonEl.hide(); } } showConflictList() { new ConflictListModal(this.app, this, this.plugin).open(); } }
class ConflictListModal extends Modal { constructor(app: App, private conflictCenter: ConflictCenter, private plugin: ObsidianDecentralizedPlugin) { super(app); } onOpen() { const { contentEl } = this; contentEl.createEl('h2', { text: 'Sync Conflicts' }); const conflicts: Map<string, string> = (this.conflictCenter as any).conflicts; if (conflicts.size === 0) { contentEl.createEl('p', { text: 'No conflicts to resolve.' }); return; } conflicts.forEach((conflictPath, originalPath) => { new Setting(contentEl).setName(originalPath).setDesc(`Conflict file: ${conflictPath}`) .addButton(btn => btn.setButtonText('Resolve').setCta().onClick(async () => { this.close(); await this.showResolutionModal(originalPath, conflictPath); })); }); } async showResolutionModal(originalPath: string, conflictPath: string) { const originalFile = this.app.vault.getAbstractFileByPath(originalPath) as TFile; const conflictFile = this.app.vault.getAbstractFileByPath(conflictPath) as TFile; if (!originalFile || !conflictFile) { this.plugin.showNotice("One of the conflict files is missing.", 'error'); this.conflictCenter.resolveConflict(originalPath); return; } if (this.plugin.isBinary(originalFile.extension)) { new BinaryConflictResolutionModal(this.app, originalFile.name, async (choice) => { this.plugin.ignoreNextEventForPath(originalPath); if (choice === 'remote') { const remoteData = await this.app.vault.readBinary(conflictFile); await this.app.vault.modifyBinary(originalFile, remoteData); } this.plugin.ignoreNextEventForPath(conflictPath); await this.app.vault.delete(conflictFile); this.conflictCenter.resolveConflict(originalPath); this.plugin.showNotice(`${originalPath} has been resolved.`, 'info'); }).open(); } else { const localContent = await this.app.vault.read(originalFile); const remoteContent = await this.app.vault.read(conflictFile); new ConflictResolutionModal(this.app, localContent, remoteContent, async (chosenContent) => { this.plugin.ignoreNextEventForPath(originalPath); await this.app.vault.modify(originalFile, chosenContent); this.plugin.ignoreNextEventForPath(conflictPath); await this.app.vault.delete(conflictFile); this.conflictCenter.resolveConflict(originalPath); this.plugin.showNotice(`${originalPath} has been resolved.`, 'info'); }).open(); } } onClose() { this.contentEl.empty(); } }
class ConflictResolutionModal extends Modal { constructor(app: App, private localContent: string, private remoteContent: string, private onResolve: (chosenContent: string) => void) { super(app); } onOpen() { const { contentEl } = this; contentEl.addClass('obsidian-decentralized-diff-modal'); contentEl.createEl('h2', { text: 'Resolve Conflict' }); const dmp = new DiffMatchPatch(); const diff = dmp.diff_main(this.localContent, this.remoteContent); dmp.diff_cleanupSemantic(diff); const diffEl = contentEl.createDiv({ cls: 'obsidian-decentralized-diff-view' }); diffEl.innerHTML = dmp.diff_prettyHtml(diff); new Setting(contentEl) .addButton(btn => btn.setButtonText('Keep My Version').onClick(() => { this.onResolve(this.localContent); this.close(); })) .addButton(btn => btn.setButtonText('Use Their Version').setWarning().onClick(() => { this.onResolve(this.remoteContent); this.close(); })); } onClose() { this.contentEl.empty(); } }
class BinaryConflictResolutionModal extends Modal { constructor(app: App, private fileName: string, private onResolve: (choice: 'local' | 'remote') => void) { super(app); } onOpen() { const { contentEl } = this; contentEl.createEl('h2', { text: 'Resolve Binary Conflict' }); contentEl.createEl('p', { text: `The file "${this.fileName}" is a binary file (e.g. image, pdf, audio). Differences cannot be shown.` }); new Setting(contentEl).addButton(btn => btn.setButtonText('Keep My Version (Local)').onClick(() => { this.onResolve('local'); this.close(); })).addButton(btn => btn.setButtonText('Use Their Version (Remote)').setWarning().onClick(() => { this.onResolve('remote'); this.close(); })); } onClose() { this.contentEl.empty(); } }

class SyncProgressModal extends Modal {
    private container: HTMLElement;
    private refreshInterval: number | null = null;

    constructor(app: App, private plugin: ObsidianDecentralizedPlugin) { super(app); }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('od-progress-modal');
        contentEl.createEl('h2', { text: 'Sync Progress' });
        this.container = contentEl.createDiv();
        this.refresh();
        this.refreshInterval = window.setInterval(() => this.refresh(), 500);
    }

    onClose() {
        if (this.refreshInterval) clearInterval(this.refreshInterval);
        this.contentEl.empty();
    }

    refresh() {
        this.container.empty();
        const hasActive = this.plugin.activeTransfers.size > 0;
        const hasFailed = this.plugin.failedSyncs.length > 0;
        const isSyncing = this.plugin.syncState.isSyncing;

        if (!hasActive && !hasFailed && !isSyncing) {
            this.container.createEl('p', { text: 'No active file transfers or syncs.' });
            return;
        }

        if (isSyncing) {
            this.container.createEl('h4', { text: 'Full Sync Progress', attr: { style: 'margin-top: 0;' } });
            const item = this.container.createDiv({ cls: 'od-transfer-item' });
            item.createDiv({ text: `Phase: ${this.plugin.syncState.currentPhase}`, attr: { style: 'font-weight: bold; margin-bottom: 8px;' } });
            
            if (this.plugin.syncState.filesTotal > 0) {
                item.createEl('progress', { attr: { value: this.plugin.syncState.filesTransferred, max: this.plugin.syncState.filesTotal } });
                const meta = item.createDiv({ cls: 'od-transfer-meta' });
                meta.createSpan({ text: `${this.plugin.syncState.filesTransferred} / ${this.plugin.syncState.filesTotal} files` });
                meta.createSpan({ text: `${formatBytes(this.plugin.syncState.bytesTransferred)} / ${formatBytes(this.plugin.syncState.bytesTotal)}` });
            } else {
                item.createDiv({ text: 'Analyzing differences...', cls: 'od-transfer-meta' });
            }
        }

        if (hasActive) {
            if (hasFailed || isSyncing) this.container.createEl('h4', { text: 'Active Data Transfers', attr: { style: 'margin-top: 20px;' } });
            this.plugin.activeTransfers.forEach(transfer => {
                const item = this.container.createDiv({ cls: 'od-transfer-item' });
                const title = item.createDiv({ cls: 'od-transfer-title', attr: { style: 'display: flex; align-items: center; margin-bottom: 4px;' } });
                
                const iconSpan = title.createSpan({ cls: 'od-transfer-icon' });
                setIcon(iconSpan, transfer.direction === 'upload' ? 'arrow-up-circle' : 'arrow-down-circle');
                iconSpan.style.marginRight = '6px';
                iconSpan.style.color = transfer.direction === 'upload' ? 'var(--text-success)' : 'var(--interactive-accent)';
                
                title.createSpan({ text: transfer.path, attr: { style: 'font-weight: 600;' } });
                if (transfer.status === 'paused') title.createSpan({ text: ' (Paused)', attr: { style: 'color: var(--text-muted); font-size: 0.8em; margin-left: 6px;' } });
                
                item.createEl('progress', { attr: { value: transfer.processedChunks, max: transfer.totalChunks } });

                const now = Date.now();
                const elapsedSeconds = (now - transfer.startTime) / 1000;
                const chunkSize = transfer.chunkSize || this.plugin.getChunkSize();
                const processedBytes = transfer.processedChunks * chunkSize;
                const totalBytes = transfer.totalChunks * chunkSize;
                const speedBytesPerSec = elapsedSeconds > 0 ? processedBytes / elapsedSeconds : 0;
                const remainingBytes = totalBytes - processedBytes;
                const remainingSeconds = speedBytesPerSec > 0 ? remainingBytes / speedBytesPerSec : 0;

                const meta = item.createDiv({ cls: 'od-transfer-meta' });
                meta.createSpan({ text: `${formatBytes(speedBytesPerSec)}/s` });
                meta.createSpan({ text: `${Math.round(remainingSeconds)}s remaining` });
                meta.createSpan({ text: `${Math.round((transfer.processedChunks / transfer.totalChunks) * 100)}%` });
            });
        }

        if (hasFailed) {
            this.container.createEl('h4', { text: 'Pending Retries', attr: { style: hasActive ? 'margin-top: 20px;' : 'margin-top: 0;' } });
            this.plugin.failedSyncs.forEach(fail => {
                const item = this.container.createDiv({ cls: 'od-transfer-item' });
                const title = item.createDiv({ cls: 'od-transfer-title', attr: { style: 'display: flex; align-items: center; margin-bottom: 4px;' } });
                
                const iconSpan = title.createSpan({ cls: 'od-transfer-icon' });
                setIcon(iconSpan, fail.type === 'file-delete' ? 'trash-2' : 'alert-circle');
                iconSpan.style.marginRight = '6px';
                iconSpan.style.color = 'var(--text-error)';
                title.createSpan({ text: fail.path, attr: { style: 'font-weight: 600;' } });

                const meta = item.createDiv({ cls: 'od-transfer-meta' });
                const peerName = fail.peerId ? (this.plugin.clusterPeers.get(fail.peerId)?.friendlyName || fail.peerId) : 'Broadcast';
                meta.createSpan({ text: `To: ${peerName}` });
                
                const secondsAgo = Math.round((Date.now() - fail.timestamp) / 1000);
                meta.createSpan({ text: `Failed ${secondsAgo}s ago (Attempt ${fail.retryCount || 0})` });

                if (fail.reason) {
                    const reasonMeta = item.createDiv({ cls: 'od-transfer-meta' });
                    reasonMeta.createSpan({ text: `Error: ${fail.reason}`, attr: { style: 'color: var(--text-error);' } });
                }
            });
        }
    }
}

class ObsidianDecentralizedSettingTab extends PluginSettingTab {
    plugin: ObsidianDecentralizedPlugin;
    private clusterStatusEl: HTMLDivElement | null = null;
    private statusInterval: number | null = null;
    private statusTextEl: HTMLDivElement | null = null;
    private isEditingName = false;

    constructor(app: App, plugin: ObsidianDecentralizedPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        this.isEditingName = false;
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Obsidian Decentralized' });
        const isAuto = this.plugin.settings.syncMode === 'auto';

        const statusContainer = containerEl.createDiv();
        statusContainer.createEl('h3', { text: 'Live Status' });
        this.statusTextEl = statusContainer.createDiv({ cls: 'obsidian-decentralized-status-text' });
        this.statusTextEl.style.fontFamily = 'monospace';
        this.statusTextEl.style.marginBottom = '1em';

        new Setting(containerEl)
            .setName(isAuto ? 'Settings Profile' : 'Mode')
            .setDesc(isAuto ? 'Auto mode is easiest and syncs everything safely. Manual lets you pick folders and behaviors. Advanced unlocks all technical settings.' : 'Auto mode syncs all files. Manual mode allows configuration. Advanced mode unlocks all settings.')
            .addDropdown(dd => dd
                .addOption('auto', 'Auto (Recommended)')
                .addOption('manual', 'Manual')
                .addOption('advanced', 'Advanced')
                .setValue(this.plugin.settings.syncMode)
                .onChange(async (value: 'auto' | 'manual' | 'advanced') => {
                    this.plugin.settings.syncMode = value;
                    await this.plugin.saveSettings();
                    this.display(); 
                }));

        new Setting(containerEl)
            .setName('Connect Devices')
            .setDesc('Open the connection helper to pair with your other devices.')
            .addButton(btn => btn.setButtonText("Connect").setCta().onClick(() => new ConnectionModal(this.app, this.plugin).open()));

        containerEl.createEl('h3', { text: 'Current Cluster' });
        this.clusterStatusEl = containerEl.createDiv();
        this.updateStatus();

        // Shared Settings (Visible in both modes)
        containerEl.createEl('h3', { text: 'Settings' });
        new Setting(containerEl)
            .setName("Excluded folders")
            .setDesc("Never sync folders in this list. One folder per line. Example: 'Attachments/Large Files'.")
            .addTextArea(text => text.setPlaceholder("Path/To/Exclude\nAnother/Path").setValue(this.plugin.settings.excludedFolders).onChange(async (value) => { this.plugin.settings.excludedFolders = value; await this.plugin.saveSettings(); }));

        if (this.plugin.settings.syncMode === 'manual' || this.plugin.settings.syncMode === 'advanced') {
            this.displayManualSettings(containerEl);
        } else {
             new Setting(containerEl)
                .setName('Show Sync Notifications')
                .setDesc('Show notifications for sync events. Important events like connections and conflicts always appear. This toggle controls additional progress notifications.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.showToasts)
                    .onChange(async (value) => {
                        this.plugin.settings.showToasts = value;
                        await this.plugin.saveSettings();
                    }));
        }
        
        if (this.plugin.settings.syncMode === 'advanced') {
            this.displayAdvancedSettings(containerEl);
        }

        if (this.statusInterval) clearInterval(this.statusInterval);
        this.statusInterval = window.setInterval(() => this.updateStatus(), 3000);
    }

    displayManualSettings(containerEl: HTMLElement): void {
        containerEl.createEl('h4', { text: 'Manual Configuration' });

        new Setting(containerEl)
            .setName('Show Sync Notifications')
            .setDesc('Show notifications for sync events. Important events like connections and conflicts always appear. This toggle controls additional progress notifications.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showToasts)
                .onChange(async (value) => {
                    this.plugin.settings.showToasts = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Conflict Resolution Strategy")
            .setDesc("How to handle a file being edited on two devices at once.")
            .addDropdown(dd => dd
                .addOption('create-conflict-file', 'Create Conflict File (Safest)')
                .addOption('last-write-wins', 'Last Write Wins (Newest file is kept)')
                .setValue(this.plugin.settings.conflictResolutionStrategy)
                .onChange(async (value: 'create-conflict-file' | 'last-write-wins') => {
                    this.plugin.settings.conflictResolutionStrategy = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Sync all file types")
            .setDesc("Sync not just markdown, but also images, PDFs, etc. This will increase sync traffic.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncAllFileTypes)
                .onChange(async (value) => {
                    this.plugin.settings.syncAllFileTypes = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Sync '.obsidian' configuration folder")
            .setDesc("DANGEROUS: Syncs settings, themes, and snippets. Can cause issues if devices have different plugins or Obsidian versions. BACKUP FIRST.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncObsidianConfig)
                .onChange(async (value) => {
                    this.plugin.settings.syncObsidianConfig = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Hide Obsidian Sync status')
            .setDesc('Hide the native Obsidian Sync button in the status bar.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.hideNativeSyncStatus)
                .onChange(async (value) => {
                    this.plugin.settings.hideNativeSyncStatus = value;
                    this.plugin.applyHideNativeSync();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Enable Verbose Logging")
            .setDesc("Outputs detailed sync information to the developer console for troubleshooting.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.verboseLogging)
                .onChange(async (value) => {
                    this.plugin.settings.verboseLogging = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Use custom signaling server")
            .setDesc("For advanced users. Use your own self-hosted PeerJS server for a fully private syncing experience, even over the internet.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useCustomPeerServer)
                .onChange(async (value) => {
                    this.plugin.settings.useCustomPeerServer = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        if (this.plugin.settings.useCustomPeerServer) {
            const config = this.plugin.settings.customPeerServerConfig;
            new Setting(containerEl).setName("Host").addText(text => text.setValue(config.host).onChange(async (value) => { config.host = value; await this.plugin.saveSettings(); }));
            new Setting(containerEl).setName("Port").addText(text => text.setValue(config.port.toString()).onChange(async (value) => { config.port = parseInt(value, 10) || 9000; await this.plugin.saveSettings(); }));
            new Setting(containerEl).setName("Path").addText(text => text.setValue(config.path).onChange(async (value) => { config.path = value; await this.plugin.saveSettings(); }));
            new Setting(containerEl).setName("Secure (SSL)").addToggle(toggle => toggle.setValue(config.secure).onChange(async (value) => { config.secure = value; await this.plugin.saveSettings(); }));

            new Setting(containerEl)
                .addButton(btn => btn.setButtonText("Apply and Reconnect").setWarning()
                    .onClick(() => {
                        this.plugin.showNotice("Reconnecting to new PeerJS server...", 'info');
                        this.plugin.reinitializeConnectionManager();
                    }));
        }

        containerEl.createEl('h4', { text: "Selective Sync" });
        new Setting(containerEl)
            .setName("Included folders")
            .setDesc("Only sync folders in this list. One folder per line. If empty, all folders are included (unless excluded). Example: 'Journal/Daily'.")
            .addTextArea(text => text.setPlaceholder("Path/To/Include\nAnother/Path").setValue(this.plugin.settings.includedFolders).onChange(async (value) => { this.plugin.settings.includedFolders = value; await this.plugin.saveSettings(); }));
    }

    displayAdvancedSettings(containerEl: HTMLElement): void {
        containerEl.createEl('h4', { text: 'Two-Device Enhancements' });
        
        new Setting(containerEl)
            .setName("Enable Two-Device Optimizations")
            .setDesc("If exactly one device is connected, enables Version Vectors, Merkle Tree syncing, and Role-based conflict resolution.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableTwoDeviceOptimizations)
                .onChange(async (value) => {
                    this.plugin.settings.enableTwoDeviceOptimizations = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Enable End-to-End Encryption")
            .setDesc("Uses AES-GCM encryption with a PSK exchanged during pairing. Highly recommended.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableEncryption)
                .onChange(async (value) => {
                    this.plugin.settings.enableEncryption = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h4', { text: 'Advanced Settings' });

        new Setting(containerEl)
            .setName("Turbo Real-time")
            .setDesc("WARNING: Streams live keystrokes instantly to avoid conflicts. Requires a flawless connection and a strict 2-device setup. Can be destructive if misused.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableRealtimeSync)
                .onChange(async (value) => {
                    this.plugin.settings.enableRealtimeSync = value;
                    await this.plugin.saveSettings();
                }));
        
        new Setting(containerEl)
            .setName("Enable Text Compression")
            .setDesc("Compress text files (markdown, css, etc.) before sending. Significantly reduces bandwidth usage.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableCompression)
                .onChange(async (value) => {
                    this.plugin.settings.enableCompression = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Enable Delta Sync")
            .setDesc("Only send changes (deltas) instead of the whole file when a text file is modified. Speeds up syncing for large notes.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableDeltaSync)
                .onChange(async (value) => {
                    this.plugin.settings.enableDeltaSync = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Delta Sync Threshold (%)")
            .setDesc("Only use delta sync if the patch is smaller than this percentage of the total file size.")
            .addText(text => text
                .setValue(this.plugin.settings.deltaSyncThreshold.toString())
                .onChange(async (value) => {
                    const num = parseInt(value);
                    this.plugin.settings.deltaSyncThreshold = isNaN(num) ? 50 : num;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Require PIN for all connections")
            .setDesc("If set, the join PIN is never cleared and must be provided by all incoming connections.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.requirePinForAllConnections)
                .onChange(async (value) => {
                    this.plugin.settings.requirePinForAllConnections = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Idle Timeout (ms)")
            .setDesc("Maximum time to wait for a sync operation without progress before aborting.")
            .addText(text => text
                .setValue(this.plugin.settings.idleTimeoutMs?.toString() || "30000")
                .onChange(async (value) => {
                    const num = parseInt(value);
                    this.plugin.settings.idleTimeoutMs = isNaN(num) ? 30000 : num;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Tombstone Retention (Days)")
            .setDesc("How long to remember deleted files. Peers offline longer than this might resurrect deleted files.")
            .addText(text => text
                .setValue(this.plugin.settings.tombstoneRetentionDays?.toString() || "30")
                .onChange(async (value) => {
                    const num = parseInt(value);
                    this.plugin.settings.tombstoneRetentionDays = isNaN(num) ? 30 : num;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Max Concurrent Transfers")
            .setDesc("Maximum number of files to transfer at once. Leave empty for dynamic (auto-tuning).")
            .addText(text => text
                .setPlaceholder("Auto")
                .setValue(this.plugin.settings.maximumConcurrentTransfers?.toString() || "")
                .onChange(async (value) => {
                    const num = parseInt(value);
                    this.plugin.settings.maximumConcurrentTransfers = isNaN(num) ? null : num;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Chunk Size (Bytes)")
            .setDesc("Size of file chunks in bytes. Default is dynamic (starts at 64KB).")
            .addText(text => text
                .setPlaceholder("Auto")
                .setValue(this.plugin.settings.chunkSize?.toString() || "")
                .onChange(async (value) => {
                    const num = parseInt(value);
                    this.plugin.settings.chunkSize = isNaN(num) ? null : num;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Debounce Delay (ms)")
            .setDesc("Time to wait after a file change before syncing. Higher values reduce sync frequency.")
            .addText(text => text
                .setValue(this.plugin.settings.debounceDelay.toString())
                .onChange(async (value) => {
                    const num = parseInt(value);
                    this.plugin.settings.debounceDelay = isNaN(num) ? DEFAULT_SETTINGS.debounceDelay : num;
                    this.plugin.updateDebounceDelay();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Modification Time Tolerance (ms)")
            .setDesc("Time difference to consider files 'the same' to account for clock skew.")
            .addText(text => text
                .setValue(this.plugin.settings.mtimeTolerance.toString())
                .onChange(async (value) => {
                    const num = parseInt(value);
                    this.plugin.settings.mtimeTolerance = isNaN(num) ? DEFAULT_SETTINGS.mtimeTolerance : num;
                    await this.plugin.saveSettings();
                }));
    }

    hide(): void {
        if (this.statusInterval) {
            clearInterval(this.statusInterval);
            this.statusInterval = null;
        }
    }

    private createEditableName(container: HTMLElement, displayName: string, editValue: string, onSave: (newName: string) => void) {
        container.empty();
        const wrapper = container.createDiv({ cls: 'od-editable-name-container' });
        
        wrapper.createSpan({ text: displayName, cls: 'od-editable-name-text' });
        const iconEl = wrapper.createSpan({ cls: 'od-editable-name-icon' });
        setIcon(iconEl, 'pencil');

        const switchToEdit = () => {
            this.isEditingName = true;
            wrapper.empty();
            wrapper.removeClass('od-editable-name-container'); 
            wrapper.addClass('od-setting-item-name-wrapper');

            const inputEl = wrapper.createEl('input', { type: 'text', value: editValue });
            inputEl.addClass('od-editable-name-input');
            
            const save = () => {
                this.isEditingName = false;
                const newName = inputEl.value.trim();
                if (newName && newName !== editValue) onSave(newName);
                else this.createEditableName(container, displayName, editValue, onSave); 
            };

            const submitBtn = wrapper.createSpan({ cls: 'od-editable-name-submit' });
            setIcon(submitBtn, 'check');
            submitBtn.onclick = (e) => { e.stopPropagation(); save(); };

            inputEl.onkeydown = (e) => { 
                if (e.key === 'Enter') save(); 
                if (e.key === 'Escape') { this.isEditingName = false; this.createEditableName(container, displayName, editValue, onSave); }
            };
            inputEl.onclick = (e) => e.stopPropagation();
            
            setTimeout(() => inputEl.focus(), 0);
        };
        wrapper.onclick = (e) => { e.preventDefault(); switchToEdit(); };
    }

    updateStatus() {
        if (this.statusTextEl) {
            const status = this.plugin.calculateStatus();
            this.statusTextEl.empty();
            const iconSpan = this.statusTextEl.createSpan({ cls: 'od-status-icon' });
            setIcon(iconSpan, status.icon);
            if (status.spin) iconSpan.addClass('lucide-spin');
            this.statusTextEl.createSpan({ text: status.text });
        }

        if (!this.clusterStatusEl || !this.clusterStatusEl.isConnected) {
            return;
        }
        if (this.isEditingName) return;
        this.clusterStatusEl.empty();

        const createEntry = (peer: PeerInfo, type: 'self' | 'companion' | 'peer' | 'host' | 'disconnected') => {
            const settingItem = new Setting(this.clusterStatusEl!)
                .setDesc(`ID: ${peer.deviceId}`);

            if (type === 'self') {
                this.createEditableName(settingItem.nameEl, peer.friendlyName + ' (This Device)', peer.friendlyName, async (newName) => {
                    this.plugin.settings.friendlyName = newName;
                    await this.plugin.saveSettings();
                    this.plugin.broadcastData({ type: 'cluster-rename', targetDeviceId: this.plugin.settings.deviceId, newName });
                    this.updateStatus();
                });
            } else if (type === 'peer' || type === 'disconnected') {
                this.createEditableName(settingItem.nameEl, peer.friendlyName, peer.friendlyName, (newName) => {
                    this.plugin.broadcastData({ type: 'cluster-rename', targetDeviceId: peer.deviceId, newName });
                    peer.friendlyName = newName;
                    this.plugin.saveKnownPeers();
                    this.updateStatus();
                });
            } else {
                settingItem.setName(peer.friendlyName);
            }

            if (type === 'companion') {
                settingItem.addButton(btn => btn.setButtonText('Unpair').setWarning().onClick(async () => {
                    await this.plugin.forgetCompanion();
                    this.updateStatus();
                }));
            }
            if (type === 'peer' || type === 'disconnected') {
                settingItem.addExtraButton(btn => btn
                    .setIcon('star')
                    .setTooltip('Set as Primary Sync Partner')
                    .onClick(async () => {
                        this.plugin.settings.companionPeerId = peer.deviceId;
                        await this.plugin.saveSettings();
                        this.plugin.tryToConnectToClusterPeers();
                        this.updateStatus();
                    })
                );
            }
            if (type === 'peer' || type === 'companion' || type === 'disconnected') {
                const conn = this.plugin.connections.get(peer.deviceId);
                if (conn && conn.open) {
                    settingItem.addButton(btn => btn.setButtonText('Disconnect').onClick(() => {
                        conn.close();
                        this.plugin.showNotice(`Disconnecting from ${peer.friendlyName}`, 'important');
                        setTimeout(() => this.updateStatus(), 100);
                    }));
                    settingItem.addExtraButton(btn => btn.setIcon('trash').setTooltip('Kick Device').onClick(() => {
                        this.plugin.broadcastData({ type: 'cluster-kick', targetDeviceId: peer.deviceId });
                        if (this.plugin.connections.has(peer.deviceId)) this.plugin.connections.get(peer.deviceId)?.close();
                    }));
                    settingItem.addExtraButton(btn => btn.setIcon('activity').setTooltip('Ping').onClick(() => {
                        this.plugin.manualPingStart.set(peer.deviceId, Date.now());
                        conn.send({ type: 'ping' });
                    }));
                } else {
                    settingItem.setDesc(settingItem.descEl.textContent + ' (Disconnected)');
                    settingItem.nameEl.style.color = 'var(--text-muted)';
                    
                    settingItem.addButton(btn => btn.setButtonText('Reconnect').setCta().onClick(() => {
                        if (this.plugin.peer && !this.plugin.peer.disconnected) {
                            this.plugin.showNotice(`Reconnecting to ${peer.friendlyName}...`, 'important');
                            const newConn = this.plugin.peer.connect(peer.deviceId);
                            this.plugin.setupConnection(newConn);
                        } else {
                            this.plugin.showNotice("Cannot reconnect: Your sync is offline.", 'error');
                        }
                    }));
                    if (type !== 'companion') {
                        settingItem.addButton(btn => btn.setButtonText('Forget').setWarning().onClick(() => {
                            this.plugin.pendingConnections.delete(peer.deviceId);
                            this.plugin.broadcastData({ type: 'cluster-forget', targetDeviceId: peer.deviceId });
                            this.plugin.handleClusterForget({ type: 'cluster-forget', targetDeviceId: peer.deviceId });
                            this.plugin.saveKnownPeers();
                        }));
                    }
                }
            } else if (type === 'host') {
                settingItem.addButton(btn => btn.setButtonText('Disconnect').onClick(() => {
                    this.plugin.reinitializeConnectionManager();
                    setTimeout(() => this.updateStatus(), 100);
                }));
            }
        };
        createEntry(this.plugin.getMyPeerInfo(), 'self');

        if (this.plugin.getConnectionMode() === 'direct-ip') {
            const list = this.clusterStatusEl;
            if (this.plugin.directIpServer) {
                list.createEl('p', { text: 'Hosting on Offline Mode. Other devices can connect to you.' });
            } else if (this.plugin.directIpClient) {
                const hostInfo = this.plugin.clusterPeers.values().next().value;
                if (hostInfo) createEntry(hostInfo, 'host');
            } else {
                list.createEl('p', { text: 'Offline Mode is idle. Use the "Connect" button to start.' });
            }
            return;
        }

        const companionId = this.plugin.settings.companionPeerId;
        if (companionId && this.plugin.clusterPeers.has(companionId)) {
            createEntry(this.plugin.clusterPeers.get(companionId)!, 'companion');
        }
        this.plugin.clusterPeers.forEach(peer => {
            if (peer.deviceId !== companionId) {
                const isConnected = this.plugin.connections.has(peer.deviceId) && this.plugin.connections.get(peer.deviceId)?.open;
                createEntry(peer, isConnected ? 'peer' : 'disconnected');
            }
        });

        if (this.plugin.clusterPeers.size === 0) {
            const list = this.clusterStatusEl;
            if (!this.plugin.peer || this.plugin.peer.disconnected) {
                list.createEl('p', { text: 'Sync is offline. Trying to reconnect...' });
            } else if (!this.plugin.peer.id) {
                list.createEl('p', { text: 'Connecting to sync network...' });
            } else {
                list.createEl('p', { text: 'Not connected to any other devices.' });
            }
        }
    }
}