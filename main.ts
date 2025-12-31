import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, TAbstractFile, Modal, Platform, requestUrl, debounce, setIcon } from 'obsidian';
import Peer, { DataConnection, PeerJSOption } from 'peerjs';
import DiffMatchPatch from 'diff-match-patch';
import * as QRCode from 'qrcode';

// --- Constants ---
const DISCOVERY_PORT = 41234;
const DISCOVERY_MULTICAST_ADDRESS = '224.0.0.114';
const MTIME_TOLERANCE_MS = 2500;
const DEBOUNCE_DELAY_MS = 1500;
const CHUNK_SIZE = 16 * 1024 * 0.9;
const COMPANION_RECONNECT_INTERVAL_MS = 10000;

// --- Type Definitions ---
type PeerInfo = { deviceId: string; friendlyName: string; ip: string | null; };
type DiscoveryBeacon = { type: 'obsidian-decentralized-beacon'; peerInfo: PeerInfo; };
type FileManifestEntry = { path: string; mtime: number; size: number; type: 'file' };
type FolderManifestEntry = { path: string; type: 'folder' };
type VaultManifest = (FileManifestEntry | FolderManifestEntry)[];

type BasePayload = { transferId: string; };
type HandshakePayload = { type: 'handshake'; peerInfo: PeerInfo; pin?: string; };
type ClusterGossipPayload = { type: 'cluster-gossip'; peers: PeerInfo[]; };
type CompanionPairPayload = { type: 'companion-pair'; peerInfo: PeerInfo; };
type AckPayload = { type: 'ack', transferId: string };
type FileUpdatePayload = BasePayload & { type: 'file-update'; path: string; content: string | ArrayBuffer; mtime: number; encoding: 'utf8' | 'binary' | 'base64' };
type FileDeletePayload = BasePayload & { type: 'file-delete'; path: string; };
type FileRenamePayload = BasePayload & { type: 'file-rename'; oldPath: string; newPath: string; };
type FolderCreatePayload = BasePayload & { type: 'folder-create', path: string; };
type FolderDeletePayload = BasePayload & { type: 'folder-delete', path: string; };
type FolderRenamePayload = BasePayload & { type: 'folder-rename', oldPath: string, newPath: string; };
type FullSyncRequestPayload = { type: 'request-full-sync', manifest: VaultManifest };
type FullSyncResponsePayload = { type: 'response-full-sync'; filesReceiverWillSend: string[]; filesInitiatorMustSend: string[]; };
type FullSyncCompletePayload = { type: 'full-sync-complete' };
type FileChunkStartPayload = { type: 'file-chunk-start', path: string, mtime: number, totalChunks: number, transferId: string };
type FileChunkDataPayload = { type: 'file-chunk-data', transferId: string, index: number, data: ArrayBuffer };
type PingPayload = { type: 'ping' };
type PongPayload = { type: 'pong' };

type SyncData =
    | HandshakePayload | ClusterGossipPayload | CompanionPairPayload | AckPayload
    | FileUpdatePayload | FileDeletePayload | FileRenamePayload
    | FolderCreatePayload | FolderDeletePayload | FolderRenamePayload
    | FullSyncRequestPayload | FullSyncResponsePayload | FullSyncCompletePayload
    | FileChunkStartPayload | FileChunkDataPayload | PingPayload | PongPayload;

// Interfaces
interface PeerServerConfig { host: string; port: number; path: string; secure: boolean; }
interface DirectIpConfig { host: string; port: number; pin: string; }
interface ObsidianDecentralizedSettings {
    syncMode: 'auto' | 'manual';
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
    conflictResolutionStrategy: 'create-conflict-file' | 'last-write-wins' | 'attempt-auto-merge';
    includedFolders: string;
    excludedFolders: string;
    hideNativeSyncStatus: boolean;
}
const DEFAULT_SETTINGS: ObsidianDecentralizedSettings = {
    syncMode: 'auto',
    showToasts: false,
    deviceId: `device-${Math.random().toString(36).slice(2, 10)}`,
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
    hideNativeSyncStatus: true,
};

interface ILANDiscovery {
    on(event: string, listener: (...args: any[]) => void): this;
    startBroadcasting(peerInfo: PeerInfo): void;
    stopBroadcasting(): void;
    startListening(): void;
    stop(): void;
}

class DummyLANDiscovery implements ILANDiscovery {
    on(event: string, listener: (...args: any[]) => void): this { return this; }
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

    constructor() {
        const { EventEmitter } = require('events');
        this._emitter = new EventEmitter();
    }

    public on(event: string, listener: (...args: any[]) => void): this {
        this._emitter.on(event, listener);
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
                this.socket?.addMembership(DISCOVERY_MULTICAST_ADDRESS);
                this.socket?.setMulticastTTL(128);
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

        this.socket.bind(DISCOVERY_PORT);
    }

    public startBroadcasting(peerInfo: PeerInfo) {
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

        sendBeacon();
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
    private messageQueue: SyncData[] = [];
    private pin: string;

    constructor(private plugin: ObsidianDecentralizedPlugin, port: number, pin: string) {
        if (Platform.isMobile) {
            this.plugin.showNotice("Direct IP Host mode is only available on Desktop.", 'info');
            return;
        }
        this.pin = pin;
        this.start(port);
    }

    private start(port: number) {
        const http = require('http');
        this.server = http.createServer(this.handleRequest.bind(this));
        this.server.on('error', (err: Error) => {
            this.plugin.showNotice(`Direct IP server error: ${err.message}`, 'error');
            this.plugin.log("Direct IP Server Error:", err);
            this.server = null;
        });
        this.server.listen(port, () => {
            this.plugin.log(`Direct IP server listening on port ${port}`);
        });
    }

    private base64ToArrayBuffer(base64: string): ArrayBuffer {
        const binary_string = window.atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return bytes.buffer;
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

        if (pin !== this.pin) {
            res.writeHead(403, CORS_HEADERS);
            res.end(JSON.stringify({ error: 'Invalid PIN' }));
            return;
        }

        if (req.url === '/poll' && req.method === 'GET') {
            res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
            res.end(JSON.stringify(this.messageQueue));
            this.messageQueue = [];
        } else if (req.url === '/push' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk: any) => body += chunk.toString());
            req.on('end', () => {
                try {
                    let data: SyncData = JSON.parse(body);
                    if (data.type === 'file-update' && data.encoding === 'base64' && typeof data.content === 'string') {
                         data = {
                            ...data,
                            content: this.base64ToArrayBuffer(data.content),
                            encoding: 'binary'
                        };
                    }

                    this.plugin.processIncomingData(data, null);
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

    send(data: SyncData) {
        this.messageQueue.push(data);
    }

    stop() {
        this.server?.close();
        this.server = null;
        this.plugin.log("Direct IP Server stopped.");
    }
}

class DirectIpClient {
    private pollInterval: number | null = null;
    private baseUrl: string;
    private headers: Record<string, string>;

    constructor(private plugin: ObsidianDecentralizedPlugin, config: DirectIpConfig) {
        this.baseUrl = `http://${config.host}:${config.port}`;
        this.headers = {
            'Content-Type': 'application/json',
            'X-Device-Id': plugin.settings.deviceId,
            'X-Pin': config.pin,
        };
        this.startPolling();
        this.plugin.showNotice(`Connected to Direct IP Host at ${config.host}`, 'info', 3000);
    }

    private arrayBufferToBase64(buffer: ArrayBuffer): string {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }

    private async poll() {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/poll`,
                method: 'GET',
                headers: this.headers,
            });
            if (response.status === 200) {
                const messages: SyncData[] = response.json;
                for (const msg of messages) {
                    this.plugin.processIncomingData(msg, null);
                }
            }
        } catch (e) {
            this.plugin.log('Direct IP Poll Error:', e);
            this.plugin.updateStatus('⚠️ Host Unreachable');
        }
    }

    async send(data: SyncData) {
        let payloadToSend = data;
        
        if (data.type === 'file-update' && data.encoding === 'binary' && data.content instanceof ArrayBuffer) {
            payloadToSend = {
                ...data,
                content: this.arrayBufferToBase64(data.content),
                encoding: 'base64'
            };
        }

        try {
            await requestUrl({
                url: `${this.baseUrl}/push`,
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify(payloadToSend),
            });
        } catch (e) {
            this.plugin.showNotice('Failed to send data to host.', 'error');
            this.plugin.log('Direct IP Push Error:', e);
            this.plugin.updateStatus('⚠️ Host Unreachable');
        }
    }

    startPolling() {
        if (this.pollInterval) clearInterval(this.pollInterval);
        this.pollInterval = window.setInterval(() => this.poll(), 2000);
        this.plugin.registerInterval(this.pollInterval);
    }

    stop() {
        if (this.pollInterval) clearInterval(this.pollInterval);
        this.pollInterval = null;
        this.plugin.showNotice("Disconnected from Direct IP Host.", 'info', 3000);
    }
}


export default class ObsidianDecentralizedPlugin extends Plugin {
    settings: ObsidianDecentralizedSettings;
    peer: Peer | null = null;
    connections: Map<string, DataConnection> = new Map();
    clusterPeers: Map<string, PeerInfo> = new Map();
    lanDiscovery: ILANDiscovery;

    private isSyncing: boolean = false;
    private ignoreEvents: Map<string, number> = new Map();
    private statusBar: HTMLElement;
    private conflictCenter: ConflictCenter;
    private transferProgress: Map<string, { path: string, progress: number }> = new Map();
    public joinPin: string | null = null;
    private companionConnectionInterval: number | null = null;
    private pendingFileChunks: Map<string, { path: string, mtime: number, chunks: ArrayBuffer[], total: number }> = new Map();
    private fullSyncTimeout: number | null = null;

    private syncQueue: { peerId: string | null, data: SyncData, retries: number }[] = [];
    private isQueueProcessing: boolean = false;
    private pendingAcks: Map<string, () => void> = new Map();
    private peerInitRetryTimeout: number | null = null;
    private peerInitAttempts = 0;
    private debouncedHandleFileChange: (file: TAbstractFile) => void;
    public directIpServer: DirectIpServer | null = null;
    public directIpClient: DirectIpClient | null = null;

    async onload() {
        if (Platform.isMobile) {
            this.lanDiscovery = new DummyLANDiscovery();
        } else {
            this.lanDiscovery = new DesktopLANDiscovery();
        }

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
                this.showNotice("Full Sync is not yet supported in Direct IP mode.", 'info');
                return;
            }
            if (this.connections.size === 0) { this.showNotice("No peers connected.", 'info'); return; }
            new SelectPeerModal(this.app, this.connections, this.clusterPeers, (peerId: string) => this.requestFullSyncFromPeer(peerId)).open();
        });

        this.debouncedHandleFileChange = debounce(this.handleFileChange.bind(this), DEBOUNCE_DELAY_MS);
        this.registerEvent(this.app.vault.on('create', (file) => this.handleEvent(file)));
        this.registerEvent(this.app.vault.on('modify', (file) => this.handleEvent(file)));
        this.registerEvent(this.app.vault.on('delete', (file) => this.handleEvent(file)));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.handleRenameEvent(file, oldPath)));

        this.initializeConnectionManager();
        this.startHeartbeat();
    }

    onunload() {
        this.peer?.destroy();
        this.lanDiscovery.stop();
        this.directIpServer?.stop();
        this.directIpClient?.stop();
        if (this.fullSyncTimeout) clearTimeout(this.fullSyncTimeout);
        if (this.peerInitRetryTimeout) clearTimeout(this.peerInitRetryTimeout);
    }
    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); this.applyHideNativeSync(); }
    async saveSettings() { await this.saveData(this.settings); }

    applyHideNativeSync() {
        if (this.settings.hideNativeSyncStatus) {
            document.body.classList.add('od-hide-native-sync');
        } else {
            document.body.classList.remove('od-hide-native-sync');
        }
    }

    public log(...args: any[]) { if (this.settings.verboseLogging) { console.log("Obsidian Decentralized:", ...args); } }

    public showNotice(message: string, level: 'info' | 'verbose' | 'error' = 'info', timeout?: number) {
        if (level === 'error') {
            new Notice(message, timeout || 10000);
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

    public getConflictStrategy() { return this.settings.syncMode === 'auto' ? 'create-conflict-file' : this.settings.conflictResolutionStrategy; }
    public shouldSyncAllFileTypes() { return this.settings.syncMode === 'auto' ? true : this.settings.syncAllFileTypes; }
    public shouldSyncObsidianConfig() { return this.settings.syncMode === 'auto' ? false : this.settings.syncObsidianConfig; }
    public getConnectionMode() { return this.settings.syncMode === 'auto' ? 'peerjs' : this.settings.connectionMode; }

    private generateTransferId(path: string): string { return `${path}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
    private handleEvent(file: TAbstractFile) { if (this.shouldIgnoreEvent(file.path)) return; if (!this.isPathSyncable(file.path)) return; if (!this.app.vault.getAbstractFileByPath(file.path)) { this.handleFileDelete(file); return; } this.debouncedHandleFileChange(file); }
    private async handleFileChange(file: TAbstractFile) { this.log(`Processing debounced change for: ${file.path}`); if (file instanceof TFile) { this.sendFileUpdate(file); } else if (file instanceof TFolder) { this.broadcastData({ type: 'folder-create', path: file.path, transferId: this.generateTransferId(file.path) }); } }
    private handleFileDelete(file: TAbstractFile) { if (this.shouldIgnoreEvent(file.path)) return; if (!this.isPathSyncable(file.path)) return; this.log(`Processing delete: ${file.path}`); const transferId = this.generateTransferId(file.path); if (file instanceof TFile) { this.broadcastData({ type: 'file-delete', path: file.path, transferId }); } else if (file instanceof TFolder) { this.broadcastData({ type: 'folder-delete', path: file.path, transferId }); } }
    private handleRenameEvent(file: TAbstractFile, oldPath: string) { if (this.shouldIgnoreEvent(oldPath) || this.shouldIgnoreEvent(file.path)) return; if (!this.isPathSyncable(file.path) && !this.isPathSyncable(oldPath)) return; this.log(`Processing rename: ${oldPath} -> ${file.path}`); this.ignoreNextEventForPath(file.path); const transferId = this.generateTransferId(file.path); if (file instanceof TFile) { this.broadcastData({ type: 'file-rename', oldPath, newPath: file.path, transferId }); } else if (file instanceof TFolder) { this.broadcastData({ type: 'folder-rename', oldPath, newPath: file.path, transferId }); } }
    
    broadcastData(data: SyncData) { this.addToQueue(null, data); }
    sendData(peerId: string, data: SyncData) { this.addToQueue(peerId, data); }
    private addToQueue(peerId: string | null, data: SyncData) { this.syncQueue.push({ peerId, data, retries: 0 }); this.processQueue(); }

    private async processQueue() {
        if (this.isQueueProcessing || this.syncQueue.length === 0) return;
        this.isQueueProcessing = true;
        this.updateStatus();

        const item = this.syncQueue.shift()!;
        const { peerId, data, retries } = item;
        const transferId = (data as BasePayload).transferId;

        try {
            const isChunkedTransfer = data.type === 'file-update' && data.content instanceof ArrayBuffer && data.content.byteLength > CHUNK_SIZE;

            if (isChunkedTransfer) {
                const targetPeers = peerId ? [peerId] : Array.from(this.connections.keys());
                if (targetPeers.length > 0) {
                    const firstPeer = targetPeers[0];
                    for (let i = 1; i < targetPeers.length; i++) { this.addToQueue(targetPeers[i], data); }
                    
                    const ackPromise = new Promise<void>((resolve, reject) => {
                        const timeout = setTimeout(() => reject(new Error(`Transfer ${transferId} timed out`)), 30000);
                        this.pendingAcks.set(transferId, () => {
                            clearTimeout(timeout);
                            resolve();
                        });
                    });

                    this.sendFileInChunks(firstPeer, data.path, data.mtime, data.content as ArrayBuffer, transferId);
                    await ackPromise;
                    this.log(`Chunked transfer ${transferId} for ${data.path} completed successfully.`);
                }
            } else {
                if (this.getConnectionMode() === 'direct-ip') {
                    if (this.directIpClient) this.directIpClient.send(data);
                    else if (this.directIpServer) this.directIpServer.send(data);
                } else {
                    const peersToSend = peerId ? [peerId] : Array.from(this.connections.keys());
                    peersToSend.forEach(pId => {
                        const conn = this.connections.get(pId);
                        if (conn?.open) { conn.send(data); }
                    });
                }
            }
        } catch (e) {
            console.error(`Error processing queue item ${transferId}:`, e);
            if (retries < 3) {
                this.log(`Retrying transfer ${transferId} (Attempt ${retries + 1}/3)`);
                this.syncQueue.push({ peerId, data, retries: retries + 1 });
                // Add a small delay before processing the retry to let network stabilize
                await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
                this.showNotice(`File transfer failed permanently for ${(data as any).path || 'an item'}.`, 'error', 8000);
            }
        } finally {
            this.pendingAcks.delete(transferId);
            this.transferProgress.delete(transferId);
            this.isQueueProcessing = false;
            this.processQueue();
        }
    }

    public reinitializeConnectionManager() {
        if (this.peerInitRetryTimeout) clearTimeout(this.peerInitRetryTimeout);
        this.peer?.destroy();
        this.directIpClient?.stop();
        this.directIpServer?.stop();
        this.directIpClient = null;
        this.directIpServer = null;
        this.connections.clear();
        this.clusterPeers.clear();
        this.initializeConnectionManager();
    }

    initializeConnectionManager(onOpen?: (id: string) => void) {
        if (this.peerInitRetryTimeout) clearTimeout(this.peerInitRetryTimeout);
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
        this.updateStatus("🔌 Connecting...");

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
            this.tryToConnectToCompanion();
            if (!Platform.isMobile) {
                this.lanDiscovery.startBroadcasting(this.getMyPeerInfo());
                this.lanDiscovery.startListening();
            }
            onOpen?.(id);
        });

        this.peer.on('connection', (conn) => { this.log("Incoming PeerJS connection from:", conn.peer); this.setupConnection(conn); });
        this.peer.on('error', (err) => { clearTimeout(connectionTimeout); this.handlePeerError(err); });
        this.peer.on('disconnected', () => { this.showNotice('Sync network disconnected. Attempting to reconnect...', 'info'); this.updateStatus("🔌 Reconnecting..."); });
        this.peer.on('close', () => { this.showNotice('Sync connection closed permanently.', 'info'); this.handlePeerError(new Error("Peer closed.")); });
    }

    private handlePeerError(err: any) {
        console.error("PeerJS Error:", err);
        this.peer?.destroy();
        this.peer = null;
        this.connections.forEach(conn => conn.close());
        this.connections.clear();
        this.clusterPeers.clear();
    
        let userMessage = 'Connection Failed';
        switch(err.type) {
            case 'network': userMessage = 'Network Error. Check internet connection.'; break;
            case 'peer-unavailable': userMessage = 'Peer not found.'; break;
            case 'server-error': userMessage = 'Server Error. Try again later.'; break;
            case 'disconnected': userMessage = 'Disconnected from server.'; break;
        }
        this.updateStatus(`⚠️ Error: ${userMessage}`);
    
        this.peerInitAttempts++;
        const backoff = Math.min(30000, this.peerInitAttempts * 2000);
        this.showNotice(`Sync connection failed. Retrying in ${backoff / 1000}s...`, 'info');
    
        if (this.peerInitRetryTimeout) clearTimeout(this.peerInitRetryTimeout);
        this.peerInitRetryTimeout = window.setTimeout(() => {
            this.updateStatus(`🔌 Retrying connection...`);
            this.initializePeer();
        }, backoff);
    }

    setupConnection(conn: DataConnection, pin?: string) {
        conn.on('open', () => {
            this.log("DataConnection open with:", conn.peer);
            if (conn.peer === this.settings.companionPeerId && this.companionConnectionInterval) {
                clearInterval(this.companionConnectionInterval);
                this.companionConnectionInterval = null;
                this.log("Companion connected, stopping reconnect attempts.");
            }
            conn.send({ type: 'handshake', peerInfo: this.getMyPeerInfo(), pin });
        });
        conn.on('data', (data: any) => this.processIncomingData(data, conn));
        conn.on('close', () => {
            const peerId = conn.peer;
            this.log("DataConnection closed with:", peerId);
            this.connections.delete(peerId);
            const peerInfo = this.clusterPeers.get(peerId);
            this.clusterPeers.delete(peerId);
            this.updateStatus();

            if (this.pendingAcks.size > 0) {
                this.log(`Connection to peer ${peerId} lost during transfer. Aborting relevant transfers.`);
                this.pendingAcks.forEach((resolver) => resolver());
            }
            if (peerInfo) this.log(`Peer disconnected: ${peerInfo.friendlyName} (${peerId})`);
            if (peerId === this.settings.companionPeerId) {
                this.showNotice(`Companion disconnected. Will try to reconnect automatically.`, 'info');
                this.log("Companion connection closed, restarting connection attempts.");
                this.tryToConnectToCompanion();
            }
        });
        conn.on('error', (err) => { console.error(`Connection error with ${conn.peer}:`, err); this.showNotice(`Connection error with a peer.`, 'error'); });
    }
    
    startHeartbeat() {
        this.registerInterval(window.setInterval(() => {
            this.connections.forEach(conn => {
                if (conn.open) conn.send({ type: 'ping' });
            });
        }, 20000));
    }

    processIncomingData(data: any, conn: DataConnection | null) {
        if (!data || !data.type) return; this.log("Received data:", data.type, "from", conn?.peer);
        switch (data.type) {
            case 'handshake': this.handleHandshake(data, conn!); break;
            case 'cluster-gossip': this.handleClusterGossip(data); break;
            case 'companion-pair': this.handleCompanionPair(data); break;
            case 'ack':
                if (this.pendingAcks.has(data.transferId)) {
                    this.log(`Ack received for ${data.transferId}.`);
                    this.pendingAcks.get(data.transferId)!();
                    this.pendingAcks.delete(data.transferId);
                }
                break;
            case 'file-update': this.applyFileUpdate(data); break;
            case 'file-delete': this.applyFileDelete(data); break;
            case 'file-rename': this.applyFileRename(data); break;
            case 'folder-create': this.applyFolderCreate(data); break;
            case 'folder-delete': this.applyFolderDelete(data); break;
            case 'folder-rename': this.applyFolderRename(data); break;
            case 'request-full-sync': this.handleFullSyncRequest(data, conn!); break;
            case 'response-full-sync': this.handleFullSyncResponse(data, conn!); break;
            case 'full-sync-complete': this.handleFullSyncComplete(); break;
            case 'file-chunk-start': this.handleFileChunkStart(data); break;
            case 'file-chunk-data': this.handleFileChunkData(data, conn!); break;
            case 'ping': conn?.send({ type: 'pong' }); break;
            case 'pong': /* Heartbeat ack */ break;
        }
    }

    handleHandshake(data: HandshakePayload, conn: DataConnection) {
        if (this.joinPin && data.pin !== this.joinPin) { this.showNotice(`Incorrect PIN from ${data.peerInfo.friendlyName}. Connection rejected.`, 'error', 10000); conn.close(); return; }
        if (this.joinPin) this.joinPin = null; 
        this.showNotice(`🤝 Connected to ${data.peerInfo.friendlyName}`, 'info', 4000);
        this.connections.set(conn.peer, conn); this.clusterPeers.set(conn.peer, data.peerInfo); this.updateStatus();
        const existingPeers = Array.from(this.clusterPeers.values());
        conn.send({ type: 'cluster-gossip', peers: existingPeers });
        this.broadcastData({ type: 'cluster-gossip', peers: [this.getMyPeerInfo(), data.peerInfo] });
    }

    handleClusterGossip(data: ClusterGossipPayload) {
        if (this.getConnectionMode() !== 'peerjs') return;
        data.peers.forEach(peerInfo => {
            if (peerInfo.deviceId === this.settings.deviceId || this.connections.has(peerInfo.deviceId)) return;
            if (this.peer && !this.peer.disconnected) { this.log("Gossip: attempting to connect to new peer", peerInfo.friendlyName); const conn = this.peer.connect(peerInfo.deviceId); this.setupConnection(conn); }
        });
    }

    async handleCompanionPair(data: CompanionPairPayload) {
        this.settings.companionPeerId = data.peerInfo.deviceId; await this.saveSettings();
        this.showNotice(`✅ Paired with ${data.peerInfo.friendlyName} as a companion device.`, 'info', 4000);
        this.tryToConnectToCompanion();
    }

    tryToConnectToCompanion() {
        if (this.getConnectionMode() !== 'peerjs') return;
        if (this.companionConnectionInterval) clearInterval(this.companionConnectionInterval); this.companionConnectionInterval = null;
        const companionId = this.settings.companionPeerId; if (!companionId) return;
        const attemptConnection = () => {
            if (!this.settings.companionPeerId) { if (this.companionConnectionInterval) clearInterval(this.companionConnectionInterval); this.companionConnectionInterval = null; return; }
            if (!this.peer || this.peer.disconnected || this.connections.has(companionId)) { return; }
            this.log(`Attempting to connect to companion ${companionId}`); const conn = this.peer.connect(companionId, { reliable: true }); this.setupConnection(conn);
        };
        attemptConnection();
        this.companionConnectionInterval = window.setInterval(attemptConnection, COMPANION_RECONNECT_INTERVAL_MS); this.registerInterval(this.companionConnectionInterval);
    }

    public async forgetCompanion() {
        if (this.companionConnectionInterval) { clearInterval(this.companionConnectionInterval); this.companionConnectionInterval = null; }
        const companionId = this.settings.companionPeerId;
        if (companionId) { const conn = this.connections.get(companionId); conn?.close(); }
        this.settings.companionPeerId = undefined; await this.saveSettings(); 
        this.showNotice('Companion link forgotten.', 'info', 3000);
    }

    async sendFileUpdate(file: TFile, peerId?: string) {
        if (!this.isPathSyncable(file.path)) return;
        const isBinaryFile = this.isBinary(file.extension);
        if (isBinaryFile && !this.shouldSyncAllFileTypes()) { this.log(`Skipping binary file because 'syncAllFileTypes' is disabled: ${file.path}`); return; }
        if (!isBinaryFile && !this.shouldSyncAllFileTypes()) { const textWhitelist = ['md', 'css', 'js', 'json']; if (!textWhitelist.includes(file.extension)) { this.log(`Skipping non-whitelisted text file: ${file.path}`); return; } }
        this.log(`Queueing file update for ${peerId || 'broadcast'}: ${file.path}`);
        try {
            let content: string | ArrayBuffer = isBinaryFile ? await this.app.vault.readBinary(file) : await this.app.vault.cachedRead(file);
            let encoding: 'utf8' | 'binary' | 'base64' = isBinaryFile ? 'binary' : 'utf8';

            // Convert large strings to ArrayBuffer to ensure they get chunked
            if (typeof content === 'string' && content.length > CHUNK_SIZE) {
                content = new TextEncoder().encode(content).buffer;
                encoding = 'binary';
            }

            const payload: FileUpdatePayload = { type: 'file-update', path: file.path, content, mtime: file.stat.mtime, encoding, transferId: this.generateTransferId(file.path) };
            if (peerId) { this.sendData(peerId, payload); } else { this.broadcastData(payload); }
        } catch (e) { console.error(`Error reading file ${file.path} for sync:`, e); }
    }

    async sendFileInChunks(peerId: string, path: string, mtime: number, fileContent: ArrayBuffer, transferId: string) {
        const conn = this.connections.get(peerId);
        if (!conn?.open) {
            this.log(`No open connection to ${peerId} to send chunks. Aborting transfer.`);
            this.pendingAcks.get(transferId)?.();
            return;
        }
        this.transferProgress.set(transferId, { path, progress: 0 });
        this.updateStatus();

        const totalChunks = Math.ceil(fileContent.byteLength / CHUNK_SIZE);
        this.log(`Sending file in ${totalChunks} chunks to ${peerId}: ${path} (ID: ${transferId})`);
        conn.send({ type: 'file-chunk-start', path, mtime, totalChunks, transferId });
        
        for (let i = 0; i < totalChunks; i++) {
            if (!conn.open) {
                this.log(`Connection to ${peerId} closed mid-transfer. Aborting.`);
                this.pendingAcks.get(transferId)?.();
                return;
            }
            try {
                const start = i * CHUNK_SIZE; const end = start + CHUNK_SIZE; const chunk = fileContent.slice(start, end);
                conn.send({ type: 'file-chunk-data', transferId, index: i, data: chunk });
                const progress = Math.round(((i + 1) / totalChunks) * 100);
                this.transferProgress.set(transferId, { path, progress });
                this.updateStatus();
                await new Promise(resolve => setTimeout(resolve, 5));
            } catch (e) {
                this.log(`Error sending chunk ${i} for ${path}. Aborting.`, e);
                this.pendingAcks.get(transferId)?.();
                return;
            }
        }
        this.log(`Finished sending all chunks for ${path} to ${peerId}. Waiting for ack.`);
    }
    handleFileChunkStart(payload: FileChunkStartPayload) { this.pendingFileChunks.set(payload.transferId, { path: payload.path, mtime: payload.mtime, chunks: new Array(payload.totalChunks), total: payload.totalChunks, }); this.log(`Receiving chunked file: ${payload.path}, ID: ${payload.transferId}`); }
    async handleFileChunkData(payload: FileChunkDataPayload, conn: DataConnection) {
        const transfer = this.pendingFileChunks.get(payload.transferId); if (!transfer) { this.log("Received chunk for unknown transfer:", payload.transferId); return; }
        transfer.chunks[payload.index] = payload.data;
        if (transfer.chunks.every(chunk => chunk !== undefined)) {
            this.log(`All chunks received for ${transfer.path}. Reassembling...`);
            this.pendingFileChunks.delete(payload.transferId);
            const totalSize = transfer.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0); const reassembled = new Uint8Array(totalSize); let offset = 0;
            for (const chunk of transfer.chunks) { reassembled.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }
            await this.applyFileUpdate({ type: 'file-update', path: transfer.path, content: reassembled.buffer, mtime: transfer.mtime, encoding: 'binary', transferId: payload.transferId });
            conn.send({ type: 'ack', transferId: payload.transferId }); this.log(`Reassembly complete for ${transfer.path}, sent ack.`);
        }
    }

    async applyFileUpdate(data: FileUpdatePayload) {
        if (!this.isPathSyncable(data.path)) return;
        const existingFile = this.app.vault.getAbstractFileByPath(data.path);
        if (!existingFile) {
            await this.handleNewFileCreation(data);
        } else if (existingFile instanceof TFile) {
            await this.handleFileModification(data, existingFile);
        } else {
            this.log(`Received file update for a path that is a folder: ${data.path}. Ignoring.`);
        }
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
            if (data.mtime > existingFile.stat.mtime + MTIME_TOLERANCE_MS) {
                this.log(`Applying update (remote is newer): ${data.path}`);
                this.ignoreNextEventForPath(data.path);
                if (data.encoding === 'binary' || data.encoding === 'base64') {
                    await this.app.vault.modifyBinary(existingFile, data.content as ArrayBuffer);
                } else {
                    await this.app.vault.modify(existingFile, data.content as string);
                }
                return;
            }

            if (data.mtime < existingFile.stat.mtime - MTIME_TOLERANCE_MS) {
                this.log(`Ignoring update (local is newer): ${data.path}`);
                return;
            }

            const localContent = (data.encoding === 'binary' || data.encoding === 'base64')
                ? await this.app.vault.readBinary(existingFile)
                : await this.app.vault.cachedRead(existingFile);

            const contentIsSame = (data.encoding === 'binary' || data.encoding === 'base64')
                ? this.areArrayBuffersEqual(localContent as ArrayBuffer, data.content as ArrayBuffer)
                : localContent === data.content;

            if (contentIsSame) {
                this.log(`Ignoring update (content is identical): ${data.path}`);
                return;
            }

            await this.resolveConflict(data, existingFile, localContent);
        } catch (e) {
            if (e instanceof Error && (e.message.includes("File not found") || e.message.includes("no such file"))) {
                this.log(`File ${data.path} not found during modification, falling back to creation.`);
                await this.handleNewFileCreation(data);
            } else {
                console.error(`Error modifying file ${data.path}:`, e);
            }
        }
    }

    private async resolveConflict(data: FileUpdatePayload, existingFile: TFile, localContent: string | ArrayBuffer) {
        this.showNotice(`Conflict detected for: ${data.path}`, 'info', 10000);
        const strategy = this.getConflictStrategy();
        this.log(`Conflict detected for: ${data.path}. Strategy: ${strategy}`);

        switch (strategy) {
            case 'last-write-wins':
                this.log(`Conflict resolved by 'last-write-wins' (remote wins): ${data.path}`);
                this.ignoreNextEventForPath(data.path);
                if (data.encoding === 'binary' || data.encoding === 'base64') {
                    await this.app.vault.modifyBinary(existingFile, data.content as ArrayBuffer);
                } else {
                    await this.app.vault.modify(existingFile, data.content as string);
                }
                break;

            case 'attempt-auto-merge':
                this.log(`Auto-merge not supported without base revision, creating conflict file: ${data.path}`);
                await this.createConflictFile(data);
                break;

            case 'create-conflict-file':
            default:
                this.log(`Creating conflict file for: ${data.path}`);
                await this.createConflictFile(data);
                break;
        }
    }

    async createConflictFile(data: FileUpdatePayload) { const conflictPath = this.getConflictPath(data.path); this.ignoreNextEventForPath(conflictPath); if (data.encoding === 'binary' || data.encoding === 'base64') { await this.app.vault.createBinary(conflictPath, data.content as ArrayBuffer); } else { await this.app.vault.create(conflictPath, data.content as string); } this.conflictCenter.addConflict(data.path, conflictPath); }
    async applyFileDelete(data: FileDeletePayload) { if (!this.isPathSyncable(data.path)) return; const existingFile = this.app.vault.getAbstractFileByPath(data.path); if (existingFile) { try { this.log(`Deleting file: ${data.path}`); this.ignoreNextEventForPath(data.path); await this.app.vault.delete(existingFile); } catch (e) { console.error(`Error deleting file: ${data.path}`, e); this.showNotice(`Failed to delete file: ${data.path}`, 'error'); } } }
    async applyFileRename(data: FileRenamePayload) { if (!this.isPathSyncable(data.oldPath) && !this.isPathSyncable(data.newPath)) return; const fileToRename = this.app.vault.getAbstractFileByPath(data.oldPath); if (fileToRename instanceof TFile) { try { this.log(`Renaming file: ${data.oldPath} -> ${data.newPath}`); this.ignoreNextEventForPath(data.newPath); await this.app.vault.rename(fileToRename, data.newPath); } catch (e) { console.error(`Error renaming file: ${data.oldPath} -> ${data.newPath}`, e); this.showNotice(`Failed to rename file: ${data.oldPath}`, 'error'); } } }
    async applyFolderCreate(data: FolderCreatePayload) { if (!this.isPathSyncable(data.path)) return; if (this.app.vault.getAbstractFileByPath(data.path)) return; this.log(`Creating folder: ${data.path}`); this.ignoreNextEventForPath(data.path); try { await this.app.vault.createFolder(data.path); } catch (e) { console.error(`Failed to create folder ${data.path}`, e); } }
    async applyFolderDelete(data: FolderDeletePayload) { if (!this.isPathSyncable(data.path)) return; const folder = this.app.vault.getAbstractFileByPath(data.path); if (folder instanceof TFolder) { this.log(`Deleting folder: ${data.path}`); this.ignoreNextEventForPath(data.path, 5000); try { await this.app.vault.delete(folder, true); } catch (e) { console.error(`Failed to delete folder ${data.path}`, e); } } }
    async applyFolderRename(data: FolderRenamePayload) { if (!this.isPathSyncable(data.oldPath) && !this.isPathSyncable(data.newPath)) return; const folder = this.app.vault.getAbstractFileByPath(data.oldPath); if (folder instanceof TFolder) { this.log(`Renaming folder: ${data.oldPath} -> ${data.newPath}`); this.ignoreNextEventForPath(data.oldPath); this.ignoreNextEventForPath(data.newPath); try { await this.app.vault.rename(folder, data.newPath); } catch (e) { console.error(`Failed to rename folder ${data.oldPath}`, e); } } }

    async requestFullSyncFromPeer(peerId: string) { if (this.isSyncing) { this.showNotice("A sync is already in progress.", 'info'); return; } const conn = this.connections.get(peerId); if (!conn) { this.showNotice("Peer not found.", 'error'); return; } this.showNotice(`Starting full sync with ${this.clusterPeers.get(peerId)?.friendlyName}...`, 'info'); this.isSyncing = true; this.updateStatus(); const localManifest = await this.buildVaultManifest(); this.log(`Sending sync request with ${localManifest.length} items.`); this.sendData(peerId, { type: 'request-full-sync', manifest: localManifest }); }
    async handleFullSyncRequest(data: FullSyncRequestPayload, conn: DataConnection) { if (this.isSyncing) { this.showNotice(`Received a sync request from ${this.clusterPeers.get(conn.peer)?.friendlyName}, but a sync is already in progress. Ignoring.`, 'verbose'); return; } this.showNotice(`Peer ${this.clusterPeers.get(conn.peer)?.friendlyName} requested a full sync. Comparing vaults...`, 'info'); this.isSyncing = true; this.updateStatus(); const remoteManifest = data.manifest; const localManifest = await this.buildVaultManifest(); const remoteIndex = new Map(remoteManifest.map(item => [item.path, item])); const localIndex = new Map(localManifest.map(item => [item.path, item])); const filesInitiatorMustSend: string[] = []; const filesReceiverWillSend: string[] = []; localIndex.forEach((localItem, path) => { const remoteItem = remoteIndex.get(path); if (!remoteItem) { filesReceiverWillSend.push(path); } else if (localItem.type === 'file' && remoteItem.type === 'file') { if (localItem.mtime > remoteItem.mtime + MTIME_TOLERANCE_MS) { filesReceiverWillSend.push(path); } } }); remoteIndex.forEach((remoteItem, path) => { const localItem = localIndex.get(path); if (!localItem) { filesInitiatorMustSend.push(path); } else if (remoteItem.type === 'file' && localItem.type === 'file') { if (remoteItem.mtime > localItem.mtime + MTIME_TOLERANCE_MS) { filesInitiatorMustSend.push(path); } } }); this.log(`Sync plan: They send ${filesInitiatorMustSend.length}, I send ${filesReceiverWillSend.length}`); this.sendData(conn.peer, { type: 'response-full-sync', filesReceiverWillSend, filesInitiatorMustSend }); for (const path of filesReceiverWillSend) { const item = this.app.vault.getAbstractFileByPath(path); if (item instanceof TFile) { await this.sendFileUpdate(item, conn.peer); } else if (item instanceof TFolder) { this.sendData(conn.peer, { type: 'folder-create', path: path, transferId: this.generateTransferId(path) }); } } this.log("Full sync: receiver has sent all its files. Sending complete message."); this.sendData(conn.peer, { type: 'full-sync-complete'}); this.isSyncing = false; this.updateStatus(); }
    async handleFullSyncResponse(data: FullSyncResponsePayload, conn: DataConnection) { if (!this.isSyncing) return; this.showNotice("Received sync plan. Exchanging files...", 'verbose'); this.log(`Sync plan: I must send ${data.filesInitiatorMustSend.length}, I will receive ${data.filesReceiverWillSend.length}`); for (const path of data.filesInitiatorMustSend) { const item = this.app.vault.getAbstractFileByPath(path); if (item instanceof TFile) { await this.sendFileUpdate(item, conn.peer); } else if (item instanceof TFolder) { this.sendData(conn.peer, { type: 'folder-create', path: path, transferId: this.generateTransferId(path) }); } } const dynamicTimeout = 30000 + (data.filesReceiverWillSend.length + data.filesInitiatorMustSend.length) * 1000; if (this.fullSyncTimeout) clearTimeout(this.fullSyncTimeout); this.fullSyncTimeout = window.setTimeout(() => { if (this.isSyncing) { this.showNotice("Sync timed out. Some files may not have transferred.", 'error', 10000); this.handleFullSyncComplete(); } }, dynamicTimeout); }
    handleFullSyncComplete() { if (!this.isSyncing) return; if (this.fullSyncTimeout) { clearTimeout(this.fullSyncTimeout); this.fullSyncTimeout = null; } this.isSyncing = false; this.isQueueProcessing = false; this.processQueue(); this.updateStatus(); this.showNotice("✅ Full sync complete.", 'info'); }
    
    private async buildVaultManifest(): Promise<VaultManifest> { const manifest: VaultManifest = []; const allFiles = this.app.vault.getAllLoadedFiles(); for (const file of allFiles) { if (this.isPathSyncable(file.path)) { if (file instanceof TFolder) { if (file.path !== '/') manifest.push({ type: 'folder', path: file.path }); } else if (file instanceof TFile) { manifest.push({ type: 'file', path: file.path, mtime: file.stat.mtime, size: file.stat.size }); } } } return manifest; }
    private isPathSyncable(path: string): boolean {
        if (path.startsWith('.obsidian/') && !this.shouldSyncObsidianConfig()) { return false; }
        if (this.settings.syncMode === 'manual') {
            const excluded = this.settings.excludedFolders.split('\n').map(p => p.trim()).filter(Boolean);
            const included = this.settings.includedFolders.split('\n').map(p => p.trim()).filter(Boolean);
            if (excluded.length > 0 && excluded.some(p => path.startsWith(p))) { return false; }
            if (included.length > 0 && !included.some(p => path.startsWith(p))) { return false; }
        }
        return true;
    }
    private isBinary(extension: string): boolean { const textExtensions = ['md', 'txt', 'json', 'css', 'js', 'html', 'xml', 'csv', 'yaml', 'toml']; return !textExtensions.includes((extension || '').toLowerCase()); }
    private areArrayBuffersEqual(buf1: ArrayBuffer, buf2: ArrayBuffer): boolean { if (buf1.byteLength !== buf2.byteLength) return false; const view1 = new Uint8Array(buf1); const view2 = new Uint8Array(buf2); for (let i = 0; i < buf1.byteLength; i++) { if (view1[i] !== view2[i]) return false; } return true; }
    private shouldIgnoreEvent(path: string): boolean { const ignoreUntil = this.ignoreEvents.get(path); if (ignoreUntil && Date.now() < ignoreUntil) { return true; } this.ignoreEvents.delete(path); return false; }
    public ignoreNextEventForPath(path: string, durationMs = 2000) { this.ignoreEvents.set(path, Date.now() + durationMs); }
    getConflictPath(originalPath: string): string { const extension = originalPath.split('.').pop() || ''; const base = originalPath.substring(0, originalPath.lastIndexOf('.')); const date = new Date().toISOString().split('T')[0]; return `${base} (conflict on ${date}).${extension}`; }
    getLocalIp(): string | null { if (Platform.isMobile) return null; try { const os = require('os'); const interfaces = os.networkInterfaces(); for (const name in interfaces) { for (const net of interfaces[name]!) { if (net.family === 'IPv4' && !net.internal) return net.address; } } } catch (e) { console.warn("Could not get local IP address.", e); } return null; }
    getMyPeerInfo(): PeerInfo { return { deviceId: this.peer?.id || this.settings.deviceId, friendlyName: this.settings.friendlyName, ip: this.getLocalIp() }; }
    public startDirectIpHost() { if (Platform.isMobile) return; this.reinitializeConnectionManager(); const pin = Math.floor(1000 + Math.random() * 9000).toString().padStart(4, '0'); this.directIpServer = new DirectIpServer(this, this.settings.directIpHostPort, pin); this.updateStatus(); return pin; }
    public async connectToDirectIpHost(config: DirectIpConfig) { this.reinitializeConnectionManager(); this.directIpClient = new DirectIpClient(this, config); this.clusterPeers.set(config.host, { deviceId: config.host, friendlyName: `Host (${config.host})`, ip: config.host }); this.updateStatus(); }
    
    injectStatusBarStyles() {
        const styleId = 'obsidian-decentralized-status-styles';
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.innerHTML = `
            .od-loading-spinner {
                border: 2px solid var(--background-modifier-border);
                border-top: 2px solid var(--interactive-accent);
                border-radius: 50%;
                width: 14px;
                height: 14px;
                animation: od-spin 1s linear infinite;
                display: inline-block;
                vertical-align: middle;
                margin-right: 6px;
            }
            @keyframes od-spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
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
            body.od-hide-native-sync .status-bar-item.plugin-sync {
                display: none !important;
            }
        `;
        document.head.appendChild(style);
    }

    public calculateStatusText(): string {
        if (this.isSyncing) { return "⚙️ Full Syncing..."; }
        if (this.transferProgress.size > 0) {
            const [transfer] = this.transferProgress.entries().next().value;
            return `⏫ Syncing ${transfer.path} (${transfer.progress}%)`;
        }
        if (this.isQueueProcessing) {
            const queueSize = this.syncQueue.length + 1;
            return `⏳ Syncing (${queueSize} item${queueSize > 1 ? 's' : ''})`;
        }
        if (this.getConnectionMode() === 'direct-ip') {
            if (this.directIpServer) return `📡 Host Mode`;
            if (this.directIpClient) return `📲 Client Mode`;
            return `🟡 Direct-IP mode`;
        }
        if (!this.peer || this.peer.disconnected) { return "🔴 Sync Offline"; }
        if (!this.peer.id) { return "🔌 Connecting..."; }
        if (this.connections.size > 0) {
            const totalDevices = this.connections.size + 1;
            return `✅ Sync Cluster (${totalDevices} device${totalDevices > 1 ? 's' : ''})`;
        }
        return "🟢 Sync Online";
    }

    updateStatus(statusText?: string) {
        const currentStatus = statusText || this.calculateStatusText();
        this.statusBar.empty();
        const container = this.statusBar.createDiv({ cls: 'od-status-container' });

        let state: 'loading' | 'success' | 'error' | 'neutral' = 'neutral';
        
        if (this.isSyncing || this.transferProgress.size > 0 || this.isQueueProcessing || currentStatus.includes('Connecting') || currentStatus.includes('Syncing')) {
            state = 'loading';
        } else if (currentStatus.includes('Offline') || currentStatus.includes('Error') || currentStatus.includes('Unreachable')) {
            state = 'error';
        } else if (currentStatus.includes('Online') || currentStatus.includes('Cluster') || currentStatus.includes('Host') || currentStatus.includes('Client')) {
            state = 'success';
        }

        if (state === 'loading') {
            container.createDiv({ cls: 'od-loading-spinner' });
        } else if (state === 'success') {
            const icon = container.createDiv({ cls: 'od-status-icon' });
            setIcon(icon, 'check');
        } else if (state === 'error') {
            const icon = container.createDiv({ cls: 'od-status-icon' });
            setIcon(icon, 'alert-circle');
        }

        const cleanText = currentStatus.replace(/^[\p{Emoji}\uFE0F\u200D]+\s*/u, '');
        container.createSpan({ text: cleanText });
    }
}

class ConnectionModal extends Modal { private discoveredPeers: Map<string, PeerInfo> = new Map(); constructor(app: App, private plugin: ObsidianDecentralizedPlugin) { super(app); } onOpen() { this.injectStyles(); this.showInitialOptions(); } onClose() { this.plugin.lanDiscovery.stop(); this.contentEl.empty(); } injectStyles() { const styleId = 'obsidian-decentralized-styles'; if (document.getElementById(styleId)) return; const style = document.createElement('style'); style.id = styleId; style.innerHTML = ` .obsidian-decentralized-connect-modal .qr-code-container { text-align: center; margin-bottom: 1em; } .obsidian-decentralized-connect-modal .qr-code-container img { max-width: 200px; margin: auto; background: white; padding: 10px; border-radius: 8px; } .obsidian-decentralized-connect-modal .obsidian-decentralized-id-block { font-family: monospace; font-size: 1.1em; padding: 0.8em; background-color: var(--background-secondary); border-radius: 6px; word-break: break-all; user-select: all; margin: 1em 0; text-align: left; } .obsidian-decentralized-connect-modal .obsidian-decentralized-info-display { font-family: monospace; font-size: 1.2em; text-align: center; margin: 0.5em 0; } .obsidian-decentralized-connect-modal .pin-display { font-size: 3em; font-weight: bold; text-align: center; letter-spacing: 0.5em; margin: 0.5em 0; } .obsidian-decentralized-connect-modal .obsidian-decentralized-cluster-list { display: flex; flex-direction: column; gap: 8px; margin-top: 1em; max-height: 200px; overflow-y: auto; } .obsidian-decentralized-connect-modal .obsidian-decentralized-peer-entry { display: flex; align-items: center; padding: 10px; background-color: var(--background-secondary); border-radius: 6px; border-left: 4px solid var(--background-modifier-border); cursor: pointer; } .obsidian-decentralized-connect-modal .obsidian-decentralized-peer-entry:hover { background-color: var(--background-modifier-hover); } .obsidian-decentralized-connect-modal .obsidian-decentralized-peer-entry .peer-info { flex-grow: 1; pointer-events: none; } .obsidian-decentralized-connect-modal .obsidian-decentralized-peer-entry .peer-name { font-weight: bold; display: block; } .obsidian-decentralized-connect-modal .obsidian-decentralized-peer-entry .peer-details { font-size: var(--font-ui-small); color: var(--text-muted); } `; document.head.appendChild(style); } showInitialOptions() { this.plugin.lanDiscovery.stop(); const { contentEl } = this; this.modalEl.addClass('obsidian-decentralized-connect-modal'); contentEl.empty(); contentEl.createEl('h2', { text: 'Connect Devices' }); new Setting(contentEl).setName("PeerJS (Internet/LAN)").setDesc("Connect using the standard PeerJS cloud or your own server. Recommended for most users.").addButton(btn => btn.setButtonText("Setup").setCta().onClick(() => this.showPeerJsMenu())); if (this.plugin.settings.syncMode === 'manual') { new Setting(contentEl).setName("Direct IP (Offline LAN Only)").setDesc("Advanced: Connect directly to another device on your LAN using its IP address. No internet needed.").addButton(btn => btn.setButtonText("Setup").onClick(() => this.showDirectIpMenu())); } } showPeerJsMenu() { const { contentEl } = this; contentEl.empty(); contentEl.createEl('h2', { text: 'PeerJS Connection' }); new Setting(contentEl).setName("Companion Mode").setDesc("Set a permanent companion device for automatic connections.").addButton(btn => btn.setButtonText("Setup").setCta().onClick(() => this.showCompanionSetup())); new Setting(contentEl).setName("One-Time Connection").setDesc("Temporarily connect to any device.").addButton(btn => btn.setButtonText("Connect").onClick(() => this.showOneTimeConnection())); new Setting(contentEl).addButton(btn => btn.setButtonText('Back').onClick(() => this.showInitialOptions())); } showOneTimeConnection() { this.plugin.lanDiscovery.stop(); const { contentEl } = this; contentEl.empty(); contentEl.createEl('h2', { text: 'One-Time Connection' }); if (!Platform.isMobile) { new Setting(contentEl).setName("Invite via LAN (No Internet Needed)").setDesc("Broadcast an invitation on your local network. The other device must be on the same Wi-Fi.").addButton(btn => btn.setButtonText("Invite with PIN").onClick(() => this.showInviteLAN())); } new Setting(contentEl).setName("Invite via ID / QR Code").setDesc("The most secure method. Requires an internet or self-hosted server for the initial handshake.").addButton(btn => btn.setButtonText("Show ID").setCta().onClick(() => this.showMyId(() => this.showOneTimeConnection(), 'Invite with ID', 'On your other device, select "Join a Network" and paste the ID below.'))); new Setting(contentEl).setName("Join a Network").setDesc("Enter an ID from another device, or discover devices on your LAN.").addButton(btn => btn.setButtonText("Join").onClick(() => this.showJoin())); new Setting(contentEl).addButton(btn => btn.setButtonText('Back').onClick(() => this.showPeerJsMenu())); } showDirectIpMenu() { const { contentEl } = this; contentEl.empty(); contentEl.createEl('h2', { text: 'Direct IP Connection' }); contentEl.createEl('p', { text: "One device must act as the 'Host' (usually a Desktop). Other devices then connect as 'Clients'." }).addClass('mod-warning'); if (!Platform.isMobile) { new Setting(contentEl).setName("Become a Host").setDesc("Allow other devices on your LAN to connect to you.").addButton(btn => btn.setButtonText("Start Hosting").setCta().onClick(() => this.showDirectIpHost())); } new Setting(contentEl).setName("Connect to a Host").setDesc("Enter the IP Address and PIN from your Host device.").addButton(btn => btn.setButtonText("Connect").onClick(() => this.showDirectIpClient())); new Setting(contentEl).addButton(btn => btn.setButtonText('Back').onClick(() => this.showInitialOptions())); } showDirectIpHost() { const { contentEl } = this; contentEl.empty(); contentEl.createEl('h2', { text: 'Direct IP Host Mode' }); const pin = this.plugin.startDirectIpHost(); if (!pin) { contentEl.createEl('p', { text: 'Could not start host server. Check console for errors.' }); new Setting(contentEl).addButton(btn => btn.setButtonText("Back").onClick(() => this.showDirectIpMenu())); return; } contentEl.createEl('p', { text: 'This device is now hosting. On your client device, enter the following information:' }); const ip = this.plugin.getLocalIp(); if (ip) { contentEl.createEl('div', { text: `Your IP: ${ip}`, cls: 'obsidian-decentralized-info-display' }); } else { contentEl.createEl('div', { text: `Could not determine IP. Check your system's network settings.`, cls: 'obsidian-decentralized-info-display mod-warning' }); } contentEl.createEl('div', { text: `Port: ${this.plugin.settings.directIpHostPort}`, cls: 'obsidian-decentralized-info-display' }); contentEl.createEl('div', { text: `Your PIN is:`, cls: 'obsidian-decentralized-info-display' }); contentEl.createEl('div', { text: pin, cls: 'pin-display' }); contentEl.createEl('p', { text: 'This window can be closed. The host will remain active.', cls: 'setting-item-description' }); new Setting(contentEl).addButton(btn => btn.setButtonText("Done").onClick(() => this.close())); } showDirectIpClient() { const { contentEl } = this; contentEl.empty(); contentEl.createEl('h2', { text: 'Connect to Direct IP Host' }); contentEl.createEl('p', { text: "Enter the details shown on the host device." }); const config: DirectIpConfig = { host: this.plugin.settings.directIpHostAddress, port: this.plugin.settings.directIpHostPort, pin: '' }; new Setting(contentEl).setName("Host IP Address").addText(text => text.setValue(config.host).onChange(val => config.host = val)); new Setting(contentEl).setName("Host Port").addText(text => text.setValue(config.port.toString()).onChange(val => config.port = parseInt(val) || 31235)); new Setting(contentEl).setName("PIN").addText(text => { text.inputEl.type = 'number'; text.inputEl.maxLength = 4; text.setPlaceholder("Enter PIN...").onChange(value => config.pin = value); }); new Setting(contentEl) .addButton(btn => btn.setButtonText("Back").onClick(() => this.showDirectIpMenu())) .addButton(btn => btn.setButtonText("Connect").setCta().onClick(() => { if (!config.host || config.pin.length !== 4) { new Notice("Please enter a valid Host IP and 4-digit PIN."); return; } this.plugin.connectToDirectIpHost(config); this.close(); })); } showInviteLAN() { const { contentEl } = this; contentEl.empty(); contentEl.createEl('h2', { text: 'Invite with PIN (LAN)' }); contentEl.createEl('p', { text: 'Your device is now discoverable on your local network. On the other device, choose "Join a Network" to find this one.' }); const pin = Math.floor(1000 + Math.random() * 9000).toString().padStart(4, '0'); this.plugin.joinPin = pin; this.plugin.lanDiscovery.startBroadcasting(this.plugin.getMyPeerInfo()); const ip = this.plugin.getLocalIp(); if (ip) { contentEl.createEl('div', { text: `Your IP: ${ip}`, cls: 'obsidian-decentralized-info-display' }); } contentEl.createEl('div', { text: `Your PIN is:`, cls: 'obsidian-decentralized-info-display' }); contentEl.createEl('div', { text: pin, cls: 'pin-display' }); contentEl.createEl('p', { text: 'This PIN will be required to connect.', cls: 'setting-item-description' }); new Setting(contentEl).addButton(btn => btn.setButtonText("Back").onClick(() => this.showOneTimeConnection())); } showJoin() { const { contentEl } = this; contentEl.empty(); contentEl.createEl('h2', { text: 'Join Network' }); if (!Platform.isMobile) { contentEl.createEl('h3', { text: 'Discovered on LAN' }); const discoveryListEl = contentEl.createDiv({ cls: 'obsidian-decentralized-cluster-list' }); const noPeersEl = discoveryListEl.createEl('p', { text: 'Searching for devices...' }); this.plugin.lanDiscovery.on('discover', (peerInfo: PeerInfo) => { noPeersEl.hide(); if (peerInfo.deviceId === this.plugin.settings.deviceId) return; this.discoveredPeers.set(peerInfo.deviceId, peerInfo); this.renderDiscoveredPeers(discoveryListEl); }); this.plugin.lanDiscovery.on('lose', (peerInfo: PeerInfo) => { this.discoveredPeers.delete(peerInfo.deviceId); this.renderDiscoveredPeers(discoveryListEl); if (this.discoveredPeers.size === 0) { noPeersEl.show(); } }); this.plugin.lanDiscovery.startListening(); } contentEl.createEl('h3', { text: 'Manual Connection' }); let remoteId = ''; new Setting(contentEl).setName("Peer ID").addText(text => text.setPlaceholder("Paste ID here...").onChange(value => remoteId = value)); const buttonRow = new Setting(contentEl); buttonRow.addButton(btn => btn.setButtonText("Back").onClick(() => this.showOneTimeConnection())); buttonRow.addButton(btn => btn.setButtonText("Connect with ID").setCta().onClick(() => { if (!remoteId.trim()) { new Notice("Please enter a Peer ID."); return; } if (!this.plugin.peer || this.plugin.peer.disconnected) { new Notice("Peer connection is not active. Please initialize PeerJS first."); this.plugin.initializePeer(); return; } const conn = this.plugin.peer.connect(remoteId.trim()); this.plugin.setupConnection(conn); this.close(); })); } renderDiscoveredPeers(container: HTMLElement) { container.empty(); if (this.discoveredPeers.size === 0) { container.createEl('p', { text: 'Searching for devices...' }); return; } this.discoveredPeers.forEach(peer => { const entry = container.createEl('div', { cls: 'obsidian-decentralized-peer-entry' }); entry.onclick = () => { this.showPinPrompt(peer); }; const infoDiv = entry.createDiv({ cls: 'peer-info' }); infoDiv.createEl('div', { text: peer.friendlyName, cls: 'peer-name' }); infoDiv.createEl('div', { text: `IP: ${peer.ip} | ID: ${peer.deviceId.substring(0, 12)}...`, cls: 'peer-details' }); }); } showPinPrompt(peer: PeerInfo) { this.plugin.lanDiscovery.stop(); const { contentEl } = this; contentEl.empty(); contentEl.createEl('h2', { text: `Connect to ${peer.friendlyName}` }); contentEl.createEl('p', { text: `Enter the PIN displayed on the other device.` }); let pin = ''; new Setting(contentEl).setName("PIN").addText(text => { text.inputEl.type = 'number'; text.setPlaceholder("Enter PIN...").onChange(value => pin = value); }); new Setting(contentEl) .addButton(btn => btn.setButtonText("Back").onClick(() => this.showJoin())) .addButton(btn => btn.setButtonText("Connect").setCta().onClick(() => { if (pin.length !== 4) { new Notice("PIN must be 4 digits."); return; } if (!this.plugin.peer || this.plugin.peer.disconnected) { new Notice("Peer connection is not active."); this.plugin.initializePeer(); return; } const conn = this.plugin.peer.connect(peer.deviceId); this.plugin.setupConnection(conn, pin); this.close(); })); } showCompanionSetup() { const { contentEl } = this; contentEl.empty(); contentEl.createEl('h2', { text: 'Companion Mode' }); const companionId = this.plugin.settings.companionPeerId; if (companionId) { const peerInfo = this.plugin.clusterPeers.get(companionId); contentEl.createEl('p', { text: `Currently paired with: ${peerInfo?.friendlyName || 'Unknown Device'}` }); contentEl.createEl('p', { text: `ID: ${companionId}` }).style.fontSize = 'var(--font-ui-small)'; } else { contentEl.createEl('p', { text: 'Not currently paired with a companion device.' }); } contentEl.createEl('h3', { text: 'Pair a New Companion' }); contentEl.createEl('p', { text: 'Enter the ID from your other device to create a permanent, automatic link. This will replace any existing companion.' }); let remoteId = ''; new Setting(contentEl).setName("Companion's ID").addText(text => text.setPlaceholder("Paste companion's ID...").onChange(value => remoteId = value)); const buttonRow = new Setting(contentEl); buttonRow.addButton(btn => btn.setButtonText('Back').onClick(() => this.showPeerJsMenu())); buttonRow.addButton(btn => btn.setButtonText("Show My ID").onClick(() => this.showMyId(() => this.showCompanionSetup(), 'This Device\'s ID', 'On your other device, select "Companion Mode", and paste this ID.'))); buttonRow.addButton(btn => btn.setButtonText("Pair").setCta().onClick(async () => { if (!remoteId.trim()) { new Notice("Please enter a Peer ID."); return; } await this.plugin.forgetCompanion(); this.plugin.settings.companionPeerId = remoteId.trim(); await this.plugin.saveSettings(); this.plugin.showNotice(`Set ${remoteId.trim()} as companion. Sending pair request...`, 'info'); if (this.plugin.peer && !this.plugin.peer.disconnected) { const conn = this.plugin.peer.connect(remoteId.trim()); this.plugin.setupConnection(conn); conn.on('open', () => { conn.send({ type: 'companion-pair', peerInfo: this.plugin.getMyPeerInfo() }); }); } else { this.plugin.showNotice("Peer connection is not active. Please wait for it to initialize.", 'info'); this.plugin.initializePeer(); } this.plugin.tryToConnectToCompanion(); this.close(); })); } showMyId(backCallback: () => void, title: string, text: string) { this.plugin.lanDiscovery.stop(); const { contentEl } = this; contentEl.empty(); contentEl.createEl('h2', { text: title }); contentEl.createEl('p', { text }); const qrEl = contentEl.createDiv({ cls: 'qr-code-container' }); const idEl = contentEl.createDiv({ cls: 'obsidian-decentralized-id-block', text: 'Loading ID...' }); const buttonContainer = contentEl.createDiv(); this.plugin.initializePeer(async (id) => { try { const dataUrl = await QRCode.toDataURL(id, { width: 200, margin: 2 }); qrEl.empty(); qrEl.createEl('img', { attr: { src: dataUrl } }); idEl.setText(id); buttonContainer.empty(); new Setting(buttonContainer) .addButton(btn => btn.setButtonText("Copy ID").onClick(() => { navigator.clipboard.writeText(id); new Notice("ID Copied!", 2000); })) .addButton(btn => btn.setButtonText("Back").onClick(backCallback)); } catch (e) { console.error("QR Code generation failed", e); idEl.setText("Error generating QR code."); } }); if (!this.plugin.peer || this.plugin.peer.disconnected) { idEl.setText("Connecting to sync network to get ID..."); } } }

class SelectPeerModal extends Modal { constructor(app: App, private connections: Map<string, DataConnection>, private clusterPeers: Map<string, PeerInfo>, private onSubmit: (peerId: string) => void) { super(app); } onOpen() { const { contentEl } = this; contentEl.createEl('h2', { text: 'Force Full Sync with Peer' }); contentEl.createEl('p', { text: 'This will perform a two-way sync. Files will be exchanged based on which is newer. This is the safest way to reconcile two vaults.' }).addClass('mod-warning'); let selectedPeer = ''; const peerList = Array.from(this.connections.keys()); if (peerList.length === 0) { contentEl.createEl('p', { text: 'No peers are currently connected.' }); new Setting(contentEl).addButton(btn => btn.setButtonText("OK").onClick(() => this.close())); return; } new Setting(contentEl).setName('Sync with Device').addDropdown(dropdown => { peerList.forEach(peerId => { const peerInfo = this.clusterPeers.get(peerId); dropdown.addOption(peerId, peerInfo?.friendlyName || peerId); }); selectedPeer = dropdown.getValue(); dropdown.onChange(value => selectedPeer = value); }); new Setting(contentEl) .addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close())) .addButton(btn => btn.setButtonText('Start Full Sync').setWarning().onClick(() => { if (selectedPeer) this.onSubmit(selectedPeer); this.close(); })); } onClose() { this.contentEl.empty(); } }
class ConflictCenter { private conflicts: Map<string, string> = new Map(); private ribbonEl: HTMLElement | null = null; constructor(private app: App, private plugin: ObsidianDecentralizedPlugin) { } registerRibbon() { this.ribbonEl = this.plugin.addRibbonIcon('swords', 'Resolve Sync Conflicts', () => this.showConflictList()); this.ribbonEl.style.display = 'none'; } addConflict(originalPath: string, conflictPath: string) { this.conflicts.set(originalPath, conflictPath); this.updateRibbon(); } resolveConflict(originalPath: string) { this.conflicts.delete(originalPath); this.updateRibbon(); } updateRibbon() { if (!this.ribbonEl) return; if (this.conflicts.size > 0) { this.ribbonEl.show(); this.ribbonEl.setAttribute('aria-label', `Resolve ${this.conflicts.size} sync conflicts`); this.ribbonEl.setText(this.conflicts.size.toString()); } else { this.ribbonEl.hide(); } } showConflictList() { new ConflictListModal(this.app, this, this.plugin).open(); } }
class ConflictListModal extends Modal { constructor(app: App, private conflictCenter: ConflictCenter, private plugin: ObsidianDecentralizedPlugin) { super(app); } onOpen() { const { contentEl } = this; contentEl.createEl('h2', { text: 'Sync Conflicts' }); const conflicts: Map<string, string> = (this.conflictCenter as any).conflicts; if (conflicts.size === 0) { contentEl.createEl('p', { text: 'No conflicts to resolve.' }); return; } conflicts.forEach((conflictPath, originalPath) => { new Setting(contentEl).setName(originalPath).setDesc(`Conflict file: ${conflictPath}`) .addButton(btn => btn.setButtonText('Resolve').setCta().onClick(async () => { this.close(); await this.showResolutionModal(originalPath, conflictPath); })); }); } async showResolutionModal(originalPath: string, conflictPath: string) { const originalFile = this.app.vault.getAbstractFileByPath(originalPath) as TFile; const conflictFile = this.app.vault.getAbstractFileByPath(conflictPath) as TFile; if (!originalFile || !conflictFile) { this.plugin.showNotice("One of the conflict files is missing.", 'error'); this.conflictCenter.resolveConflict(originalPath); return; } const localContent = await this.app.vault.read(originalFile); const remoteContent = await this.app.vault.read(conflictFile); new ConflictResolutionModal(this.app, localContent, remoteContent, async (chosenContent) => { this.plugin.ignoreNextEventForPath(originalPath); await this.app.vault.modify(originalFile, chosenContent); this.plugin.ignoreNextEventForPath(conflictPath); await this.app.vault.delete(conflictFile); this.conflictCenter.resolveConflict(originalPath); this.plugin.showNotice(`${originalPath} has been resolved.`, 'info'); }).open(); } onClose() { this.contentEl.empty(); } }
class ConflictResolutionModal extends Modal { constructor(app: App, private localContent: string, private remoteContent: string, private onResolve: (chosenContent: string) => void) { super(app); } onOpen() { const { contentEl } = this; contentEl.addClass('obsidian-decentralized-diff-modal'); contentEl.createEl('h2', { text: 'Resolve Conflict' }); const dmp = new DiffMatchPatch(); const diff = dmp.diff_main(this.localContent, this.remoteContent); dmp.diff_cleanupSemantic(diff); const diffEl = contentEl.createDiv({ cls: 'obsidian-decentralized-diff-view' }); diffEl.innerHTML = dmp.diff_prettyHtml(diff); new Setting(contentEl) .addButton(btn => btn.setButtonText('Keep My Version').onClick(() => { this.onResolve(this.localContent); this.close(); })) .addButton(btn => btn.setButtonText('Use Their Version').setWarning().onClick(() => { this.onResolve(this.remoteContent); this.close(); })); } onClose() { this.contentEl.empty(); } }

class ObsidianDecentralizedSettingTab extends PluginSettingTab {
    plugin: ObsidianDecentralizedPlugin;
    private clusterStatusEl: HTMLDivElement | null = null;
    private statusInterval: number | null = null;
    private statusTextEl: HTMLDivElement | null = null;

    constructor(app: App, plugin: ObsidianDecentralizedPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Obsidian Decentralized' });

        const statusContainer = containerEl.createDiv();
        statusContainer.createEl('h3', { text: 'Live Status' });
        this.statusTextEl = statusContainer.createDiv({ cls: 'obsidian-decentralized-status-text' });
        this.statusTextEl.style.fontFamily = 'monospace';
        this.statusTextEl.style.marginBottom = '1em';

        new Setting(containerEl)
            .setName('Mode')
            .setDesc('Auto mode is recommended for most users. Manual mode provides advanced configuration options.')
            .addDropdown(dd => dd
                .addOption('auto', 'Auto (Recommended)')
                .addOption('manual', 'Manual')
                .setValue(this.plugin.settings.syncMode)
                .onChange(async (value: 'auto' | 'manual') => {
                    this.plugin.settings.syncMode = value;
                    await this.plugin.saveSettings();
                    this.display(); 
                }));

        new Setting(containerEl)
            .setName('This Device\'s Name').addText(text => text.setPlaceholder('e.g., My Desktop').setValue(this.plugin.settings.friendlyName)
                .onChange(async (value) => { this.plugin.settings.friendlyName = value; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Connect Devices')
            .setDesc('Open the connection helper to pair with your other devices.')
            .addButton(btn => btn.setButtonText("Connect").setCta().onClick(() => new ConnectionModal(this.app, this.plugin).open()));

        containerEl.createEl('h3', { text: 'Current Cluster' });
        this.clusterStatusEl = containerEl.createDiv();
        this.updateStatus();

        if (this.plugin.settings.syncMode === 'manual') {
            this.displayManualSettings(containerEl);
        } else {
            containerEl.createEl('h2', { text: 'Notifications' });
             new Setting(containerEl)
                .setName('Show Sync Notifications')
                .setDesc('Enable to see pop-up notifications for sync events like connections and conflicts.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.showToasts)
                    .onChange(async (value) => {
                        this.plugin.settings.showToasts = value;
                        await this.plugin.saveSettings();
                    }));
        }

        if (this.statusInterval) clearInterval(this.statusInterval);
        this.statusInterval = window.setInterval(() => this.updateStatus(), 3000);
    }

    displayManualSettings(containerEl: HTMLElement): void {
        containerEl.createEl('h2', { text: 'Notifications & Sync Behavior' });

        new Setting(containerEl)
            .setName('Show Sync Notifications')
            .setDesc('Enable to see pop-up notifications for sync events. If verbose logging is on, more notifications will be shown.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showToasts)
                .onChange(async (value) => {
                    this.plugin.settings.showToasts = value;
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
            .setName("Conflict Resolution Strategy")
            .setDesc("How to handle a file being edited on two devices at once.")
            .addDropdown(dd => dd
                .addOption('create-conflict-file', 'Create Conflict File (Safest)')
                .addOption('last-write-wins', 'Last Write Wins (Newest file is kept)')
                .addOption('attempt-auto-merge', 'Attempt Auto-Merge (For Markdown)')
                .setValue(this.plugin.settings.conflictResolutionStrategy)
                .onChange(async (value: 'create-conflict-file' | 'last-write-wins' | 'attempt-auto-merge') => {
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

        containerEl.createEl('h4', { text: "Selective Sync" });
        new Setting(containerEl)
            .setName("Included folders")
            .setDesc("Only sync folders in this list. One folder per line. If empty, all folders are included (unless excluded). Example: 'Journal/Daily'.")
            .addTextArea(text => text.setPlaceholder("Path/To/Include\nAnother/Path").setValue(this.plugin.settings.includedFolders).onChange(async (value) => { this.plugin.settings.includedFolders = value; await this.plugin.saveSettings(); }));
        new Setting(containerEl)
            .setName("Excluded folders")
            .setDesc("Never sync folders in this list. One folder per line. Takes priority over included folders. Example: 'Attachments/Large Files'.")
            .addTextArea(text => text.setPlaceholder("Path/To/Exclude\nAnother/Path").setValue(this.plugin.settings.excludedFolders).onChange(async (value) => { this.plugin.settings.excludedFolders = value; await this.plugin.saveSettings(); }));
        
        const advancedSettings = containerEl.createEl('details');
        advancedSettings.createEl('summary', { text: 'Advanced Settings' });

        new Setting(advancedSettings)
            .setName("Connection Mode")
            .setDesc("Choose how devices connect. 'PeerJS' is standard. 'Direct IP' is for offline LAN-only sync. Changing this requires a plugin reload or Obsidian restart.")
            .addDropdown(dd => dd
                .addOption('peerjs', 'PeerJS (Cloud/Self-Hosted)')
                .addOption('direct-ip', 'Direct IP (Offline LAN)')
                .setValue(this.plugin.settings.connectionMode)
                .onChange(async (value: 'peerjs' | 'direct-ip') => {
                    this.plugin.settings.connectionMode = value; 
                    await this.plugin.saveSettings(); 
                    this.plugin.reinitializeConnectionManager(); 
                    this.display(); 
                })); 
        
        if (this.plugin.settings.connectionMode === 'direct-ip') { 
            advancedSettings.createEl('p', { text: "Direct IP mode must be configured from the 'Connect' modal.", cls: "setting-item-description" }); 
        } 

        new Setting(advancedSettings)
            .setName("Enable Verbose Logging")
            .setDesc("Outputs detailed sync information to the developer console for troubleshooting.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.verboseLogging)
                .onChange(async (value) => {
                    this.plugin.settings.verboseLogging = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(advancedSettings)
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
            new Setting(advancedSettings).setName("Host").addText(text => text.setValue(config.host).onChange(async (value) => { config.host = value; await this.plugin.saveSettings(); }));
            new Setting(advancedSettings).setName("Port").addText(text => text.setValue(config.port.toString()).onChange(async (value) => { config.port = parseInt(value, 10) || 9000; await this.plugin.saveSettings(); }));
            new Setting(advancedSettings).setName("Path").addText(text => text.setValue(config.path).onChange(async (value) => { config.path = value; await this.plugin.saveSettings(); }));
            new Setting(advancedSettings).setName("Secure (SSL)").addToggle(toggle => toggle.setValue(config.secure).onChange(async (value) => { config.secure = value; await this.plugin.saveSettings(); }));

            new Setting(advancedSettings)
                .addButton(btn => btn.setButtonText("Apply and Reconnect").setWarning()
                    .onClick(() => {
                        this.plugin.showNotice("Reconnecting to new PeerJS server...", 'info');
                        this.plugin.reinitializeConnectionManager();
                    }));
        }
    }

    hide(): void {
        if (this.statusInterval) {
            clearInterval(this.statusInterval);
            this.statusInterval = null;
        }
    }

    updateStatus() {
        if (this.statusTextEl) {
            this.statusTextEl.setText(this.plugin.calculateStatusText());
        }

        if (!this.clusterStatusEl || !this.clusterStatusEl.isConnected) {
            return;
        }
        this.clusterStatusEl.empty();

        const createEntry = (peer: PeerInfo, type: 'self' | 'companion' | 'peer' | 'host') => {
            const settingItem = new Setting(this.clusterStatusEl!)
                .setName(peer.friendlyName + (type === 'self' ? ' (This Device)' : ''))
                .setDesc(`ID: ${peer.deviceId}`);

            if (type === 'companion') {
                settingItem.addButton(btn => btn.setButtonText('Forget').setWarning().onClick(async () => {
                    await this.plugin.forgetCompanion();
                    this.updateStatus();
                }));
            }
            if (type === 'peer' || type === 'companion') {
                const conn = this.plugin.connections.get(peer.deviceId);
                if (conn && conn.open) {
                    settingItem.addButton(btn => btn.setButtonText('Disconnect').onClick(() => {
                        conn.close();
                        this.plugin.showNotice(`Disconnecting from ${peer.friendlyName}`, 'info');
                        setTimeout(() => this.updateStatus(), 100);
                    }));
                } else {
                    settingItem.setDesc(settingItem.descEl.textContent + ' (Connecting...)');
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
                list.createEl('p', { text: 'Hosting on Direct IP. Other devices can connect to you.' });
            } else if (this.plugin.directIpClient) {
                const hostInfo = this.plugin.clusterPeers.values().next().value;
                if (hostInfo) createEntry(hostInfo, 'host');
            } else {
                list.createEl('p', { text: 'Direct IP mode is idle. Use the "Connect" button to start.' });
            }
            return;
        }

        const companionId = this.plugin.settings.companionPeerId;
        if (companionId && this.plugin.clusterPeers.has(companionId)) {
            createEntry(this.plugin.clusterPeers.get(companionId)!, 'companion');
        }
        this.plugin.clusterPeers.forEach(peer => {
            if (peer.deviceId !== companionId) {
                createEntry(peer, 'peer');
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