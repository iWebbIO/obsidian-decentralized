import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, TAbstractFile, Modal, Platform, requestUrl, debounce } from 'obsidian';
import Peer, { DataConnection, PeerJSOption } from 'peerjs';
import DiffMatchPatch from 'diff-match-patch';
import * as QRCode from 'qrcode';

// --- Constants ---
const PLUGIN_VERSION = '1.1.0';
const DISCOVERY_PORT = 41234;
const DISCOVERY_MULTICAST_ADDRESS = '224.0.0.114';
const MTIME_TOLERANCE_MS = 2000; // Allow 2s difference in mtime to account for clock drift/FS differences
const DEBOUNCE_DELAY_MS = 1500; // Wait 1.5s after the last file change before syncing to group events
const CHUNK_SIZE = 16 * 1024 * 0.95; // PeerJS internal chunk size is 16k, we stay just under to be safe
const COMPANION_RECONNECT_INTERVAL_MS = 10000; // 10 seconds, more responsive
const CHUNK_TRANSFER_TIMEOUT_MS = 30000; // 30 seconds for a chunked transfer to complete

// --- Type Definitions ---
type PeerInfo = { deviceId: string; friendlyName: string; ip: string | null; };
type DiscoveryBeacon = { type: 'obsidian-decentralized-beacon'; peerInfo: PeerInfo; };

// Manifest Types for Full Sync
type FileManifestEntry = { path: string; mtime: number; size: number; type: 'file' };
type FolderManifestEntry = { path: string; type: 'folder' };
type VaultManifest = (FileManifestEntry | FolderManifestEntry)[];

// Payload Types
type HandshakePayload = { type: 'handshake'; peerInfo: PeerInfo; pin?: string; };
type ClusterGossipPayload = { type: 'cluster-gossip'; peers: PeerInfo[]; };
type CompanionPairPayload = { type: 'companion-pair'; peerInfo: PeerInfo; };
type AckPayload = { type: 'ack', transferId: string };

// File & Folder Operations
type FileUpdatePayload = { type: 'file-update'; path: string; content: string | ArrayBuffer; mtime: number; encoding: 'utf8' | 'binary' | 'base64', transferId?: string };
type FileDeletePayload = { type: 'file-delete'; path: string; transferId?: string };
type FileRenamePayload = { type: 'file-rename'; oldPath: string; newPath: string; transferId?: string };
type FolderCreatePayload = { type: 'folder-create', path: string; transferId?: string };
type FolderDeletePayload = { type: 'folder-delete', path: string; transferId?: string };
type FolderRenamePayload = { type: 'folder-rename', oldPath: string, newPath: string; transferId?: string };

// Full Sync Operations
type FullSyncRequestPayload = { type: 'request-full-sync', manifest: VaultManifest };
type FullSyncResponsePayload = {
    type: 'response-full-sync';
    filesReceiverWillSend: string[];    // Files the sync initiator will receive (updates/creations)
    filesInitiatorMustSend: string[];   // Files the sync initiator must send (updates/creations)
    filesReceiverMustDelete: string[];  // Files the sync initiator has that the receiver must delete
    filesInitiatorMustDelete: string[]; // Files the receiver has that the initiator must delete
};
type FullSyncBatchCompletePayload = { type: 'full-sync-batch-complete' };
type FullSyncCompletePayload = { type: 'full-sync-complete' }; // Kept for potential future use, but new handshake is primary

// Chunking
type FileChunkStartPayload = { type: 'file-chunk-start', path: string, mtime: number, totalChunks: number, transferId: string };
type FileChunkDataPayload = { type: 'file-chunk-data', transferId: string, index: number, data: ArrayBuffer };

type SyncData =
    | HandshakePayload | ClusterGossipPayload | CompanionPairPayload | AckPayload
    | FileUpdatePayload | FileDeletePayload | FileRenamePayload
    | FolderCreatePayload | FolderDeletePayload | FolderRenamePayload
    | FullSyncRequestPayload | FullSyncResponsePayload | FullSyncCompletePayload | FullSyncBatchCompletePayload
    | FileChunkStartPayload | FileChunkDataPayload;

// Interfaces
interface PeerServerConfig { host: string; port: number; path: string; secure: boolean; }
interface DirectIpConfig { host: string; port: number; pin: string; }
interface ObsidianDecentralizedSettings {
    deviceId: string;
    friendlyName: string;
    companionPeerId?: string;
    useCustomPeerServer: boolean;
    customPeerServerConfig: PeerServerConfig;
    enableExperimentalFeatures: boolean;
    verboseLogging: boolean;
    connectionMode: 'peerjs' | 'direct-ip';
    directIpHostAddress: string;
    directIpHostPort: number;
    syncAllFileTypes: boolean;
    syncObsidianConfig: boolean;
    conflictResolutionStrategy: 'create-conflict-file' | 'last-write-wins' | 'attempt-auto-merge';
    includedFolders: string;
    excludedFolders: string;
}
const DEFAULT_SETTINGS: ObsidianDecentralizedSettings = {
    deviceId: `device-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
    friendlyName: 'My New Device',
    companionPeerId: undefined,
    useCustomPeerServer: false,
    customPeerServerConfig: { host: 'localhost', port: 9000, path: '/myapp', secure: false },
    enableExperimentalFeatures: false,
    verboseLogging: false,
    connectionMode: 'peerjs',
    directIpHostAddress: '192.168.1.100',
    directIpHostPort: 41235,
    syncAllFileTypes: false,
    syncObsidianConfig: false,
    conflictResolutionStrategy: 'create-conflict-file',
    includedFolders: '',
    excludedFolders: '',
};

interface ILANDiscovery {
    on(event: string, listener: (...args: any[]) => void): this;
    startBroadcasting(peerInfo: PeerInfo): void;
    stopBroadcasting(): void;
    startListening(): void;
    stop(): void;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
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
    private messageQueueByDevice: Map<string, SyncData[]> = new Map();
    private pin: string;

    constructor(private plugin: ObsidianDecentralizedPlugin, port: number, pin: string) {
        if (Platform.isMobile) {
            new Notice("Direct IP Host mode is only available on Desktop.");
            return;
        }
        this.pin = pin;
        this.start(port);
    }

    private start(port: number) {
        const http = require('http');
        this.server = http.createServer(this.handleRequest.bind(this));
        this.server.on('error', (err: Error) => {
            new Notice(`Direct IP server error: ${err.message}`);
            this.plugin.log("Direct IP Server Error:", err);
            this.server = null;
        });
        this.server.listen(port, () => {
            this.plugin.log(`Direct IP server listening on port ${port}`);
        });
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

        const deviceId = req.headers['x-device-id'];
        const pin = req.headers['x-pin'];

        if (!deviceId || pin !== this.pin) {
            res.writeHead(403, CORS_HEADERS);
            res.end(JSON.stringify({ error: 'Invalid PIN or missing Device ID' }));
            return;
        }

        if (req.url === '/poll' && req.method === 'GET') {
            const queue = this.messageQueueByDevice.get(deviceId) || [];
            res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
            res.end(JSON.stringify(queue));
            this.messageQueueByDevice.set(deviceId, []);
        } else if (req.url === '/push' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk: any) => body += chunk.toString());
            req.on('end', () => {
                try {
                    const data: SyncData = JSON.parse(body);
                    this.plugin.processIncomingData(data, null, 'direct-ip');
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
        // Broadcast to all connected clients
        const clientIds = Array.from(this.plugin.clusterPeers.keys());
        clientIds.forEach(id => {
            if (!this.messageQueueByDevice.has(id)) {
                this.messageQueueByDevice.set(id, []);
            }
            this.messageQueueByDevice.get(id)!.push(data);
        });
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

    constructor(private plugin: ObsidianDecentralizedPlugin, private config: DirectIpConfig) {
        this.baseUrl = `http://${config.host}:${config.port}`;
        this.headers = {
            'Content-Type': 'application/json',
            'X-Device-Id': plugin.settings.deviceId,
            'X-Pin': config.pin,
        };
        this.startPolling();
        new Notice(`Connected to Direct IP Host at ${config.host}`);
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
                    this.plugin.processIncomingData(msg, null, 'direct-ip');
                }
            } else if (response.status === 403) {
                 new Notice('Direct IP connection rejected: Invalid PIN.');
                 this.plugin.log('Direct IP Poll Error: 403 Forbidden. Check PIN.');
                 this.stop();
                 this.plugin.reinitializeConnectionManager();
            }
        } catch (e) {
            this.plugin.log('Direct IP Poll Error:', e);
        }
    }

    async send(data: SyncData) {
        try {
            await requestUrl({
                url: `${this.baseUrl}/push`,
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify(data),
            });
        } catch (e) {
            new Notice('Failed to send data to host.');
            this.plugin.log('Direct IP Push Error:', e);
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
        new Notice("Disconnected from Direct IP Host.");
    }
}


export default class ObsidianDecentralizedPlugin extends Plugin {
    settings: ObsidianDecentralizedSettings;
    peer: Peer | null = null;
    connections: Map<string, DataConnection> = new Map();
    clusterPeers: Map<string, PeerInfo> = new Map();
    lanDiscovery: ILANDiscovery;

    // State Management
    private ignoreEvents: Map<string, number> = new Map(); // Better event ignoring
    private statusBar: HTMLElement;
    private conflictCenter: ConflictCenter;
    public joinPin: string | null = null;
    private companionConnectionInterval: number | null = null;
    private pendingFileChunks: Map<string, { path: string, mtime: number, chunks: ArrayBuffer[], total: number }> = new Map();

    private syncState: {
        isSyncing: boolean;
        peerId: string | null;
        sentMyBatchComplete: boolean;
        receivedPeerBatchComplete: boolean;
    } = { isSyncing: false, peerId: null, sentMyBatchComplete: false, receivedPeerBatchComplete: false };


    // Sync Queue for Flow Control
    private syncQueue: { peerId: string | null, data: SyncData }[] = []; // null peerId for broadcast
    private isQueueProcessing: boolean = false;
    private currentTransferId: string | null = null;
    private chunkTransferTimeout: number | null = null;

    // Debounced handlers
    private debouncedHandleFileChange: (file: TAbstractFile) => void;

    public directIpServer: DirectIpServer | null = null;
    public directIpClient: DirectIpClient | null = null;

    // Robust PeerJS initialization state
    private peerInitRetryTimeout: number | null = null;
    private peerInitAttempts = 0;

    async onload() {
        if (Platform.isMobile) {
            this.lanDiscovery = new DummyLANDiscovery();
        } else {
            this.lanDiscovery = new DesktopLANDiscovery();
        }

        await this.loadSettings();
        this.statusBar = this.addStatusBarItem();
        this.addSettingTab(new ObsidianDecentralizedSettingTab(this.app, this));
        this.conflictCenter = new ConflictCenter(this);
        this.conflictCenter.registerRibbon();
        this.addRibbonIcon('users', 'Connect to a Peer', () => new ConnectionModal(this.app, this).open());
        this.addRibbonIcon('refresh-cw', 'Force Full Sync with Peer', () => {
            if (this.settings.connectionMode === 'direct-ip') {
                new Notice("Full Sync is not yet available in Direct IP mode.");
                return;
            }
            if (this.connections.size === 0) { new Notice("No peers connected."); return; }
            new SelectPeerModal(this.app, this.connections, this.clusterPeers, (peerId: string) => this.requestFullSyncFromPeer(peerId)).open();
        });

        this.debouncedHandleFileChange = debounce(this.handleFileChange.bind(this), DEBOUNCE_DELAY_MS, false);
        this.registerEvent(this.app.vault.on('create', (file) => this.handleEvent(file)));
        this.registerEvent(this.app.vault.on('modify', (file) => this.handleEvent(file)));
        this.registerEvent(this.app.vault.on('delete', (file) => this.handleEvent(file)));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.handleRenameEvent(file, oldPath)));

        this.initializeConnectionManager();
    }

    onunload() {
        this.peer?.destroy();
        if (this.companionConnectionInterval) clearInterval(this.companionConnectionInterval);
        if (this.peerInitRetryTimeout) clearTimeout(this.peerInitRetryTimeout);
        if (this.chunkTransferTimeout) clearTimeout(this.chunkTransferTimeout);
        this.lanDiscovery.stop();
        this.directIpServer?.stop();
        this.directIpClient?.stop();
    }
    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }

    public log(...args: any[]) { if (this.settings.verboseLogging) { console.log("Obsidian Decentralized:", ...args); } }

    private shouldIgnoreEvent(path: string): boolean { const ignoreUntil = this.ignoreEvents.get(path); if (ignoreUntil && Date.now() < ignoreUntil) { return true; } this.ignoreEvents.delete(path); return false; }
    private ignoreNextEventForPath(path: string, durationMs = 2000) { this.ignoreEvents.set(path, Date.now() + durationMs); }
    private handleEvent(file: TAbstractFile) { if (this.shouldIgnoreEvent(file.path)) return; if (!this.isPathSyncable(file.path)) return; if (!this.app.vault.getAbstractFileByPath(file.path)) { this.handleFileDelete(file); return; } this.debouncedHandleFileChange(file); }
    private async handleFileChange(file: TAbstractFile) { this.log(`Processing debounced change for: ${file.path}`); if (file instanceof TFile) { this.sendFileUpdate(file); } else if (file instanceof TFolder) { this.broadcastData({ type: 'folder-create', path: file.path }); } }
    private handleFileDelete(file: TAbstractFile) { if (this.shouldIgnoreEvent(file.path)) return; if (!this.isPathSyncable(file.path)) return; this.log(`Processing delete: ${file.path}`); if (file instanceof TFile) { this.broadcastData({ type: 'file-delete', path: file.path }); } else if (file instanceof TFolder) { this.broadcastData({ type: 'folder-delete', path: file.path }); } }
    private handleRenameEvent(file: TAbstractFile, oldPath: string) { if (this.shouldIgnoreEvent(oldPath) || this.shouldIgnoreEvent(file.path)) return; if (!this.isPathSyncable(file.path) && !this.isPathSyncable(oldPath)) return; this.log(`Processing rename: ${oldPath} -> ${file.path}`); this.ignoreNextEventForPath(file.path); if (file instanceof TFile) { this.broadcastData({ type: 'file-rename', oldPath, newPath: file.path }); } else if (file instanceof TFolder) { this.broadcastData({ type: 'folder-rename', oldPath, newPath: file.path }); } }

    // --- Data Broadcasting & Queueing (Flow Control) ---
    broadcastData(data: SyncData) { this.addToQueue(null, data); }
    sendData(peerId: string, data: SyncData) { this.addToQueue(peerId, data); }
    private addToQueue(peerId: string | null, data: SyncData) { this.syncQueue.push({ peerId, data }); this.processQueue(); }

    private async processQueue() {
        if (this.isQueueProcessing || this.syncQueue.length === 0) {
            return;
        }
        this.isQueueProcessing = true;
        this.updateStatus();

        const { peerId, data } = this.syncQueue.shift()!;

        try {
            if (data.type === 'file-update' && data.content instanceof ArrayBuffer && data.content.byteLength > CHUNK_SIZE) {
                this.currentTransferId = `${data.path}-${Date.now()}`;
                const targetPeers = peerId ? [peerId] : Array.from(this.connections.keys());

                if (targetPeers.length > 0) {
                    const firstPeer = targetPeers[0];
                    this.log(`Starting chunked transfer to ${firstPeer} for ${data.path}`);

                    if (targetPeers.length > 1) { // Re-queue for other peers if broadcasting
                        for (let i = 1; i < targetPeers.length; i++) { this.addToQueue(targetPeers[i], data); }
                    }

                    const transferIdForTimeout = this.currentTransferId;
                    this.chunkTransferTimeout = window.setTimeout(() => {
                        if (this.currentTransferId === transferIdForTimeout) {
                            this.log(`Chunk transfer for ${transferIdForTimeout} timed out. Aborting and continuing queue.`);
                            new Notice(`A file transfer timed out. Check connection.`, 8000);
                            this.currentTransferId = null;
                            this.isQueueProcessing = false;
                            this.processQueue();
                        }
                    }, CHUNK_TRANSFER_TIMEOUT_MS);

                    this.sendFileInChunks(firstPeer, data.path, data.mtime, data.content, this.currentTransferId);
                } else {
                    this.isQueueProcessing = false;
                    this.processQueue();
                }
            } else {
                let processedData = data;
                if (this.settings.connectionMode === 'direct-ip' && data.type === 'file-update' && data.content instanceof ArrayBuffer) {
                    processedData = { ...data, content: arrayBufferToBase64(data.content), encoding: 'base64' };
                }

                if (this.settings.connectionMode === 'direct-ip') {
                    if (this.directIpClient) await this.directIpClient.send(processedData);
                    else if (this.directIpServer) this.directIpServer.send(processedData);
                } else {
                    const peersToSend = peerId ? [peerId] : Array.from(this.connections.keys());
                    peersToSend.forEach(pId => {
                        const conn = this.connections.get(pId);
                        if (conn?.open) {
                            try {
                                conn.send(processedData);
                            } catch (e) {
                                this.log(`Failed to send data to peer ${pId}, it may have disconnected.`, e);
                            }
                        }
                    });
                }
                this.isQueueProcessing = false;
                this.processQueue();
            }
        } catch (e) {
            console.error("Error processing sync queue:", e);
            this.isQueueProcessing = false;
            this.currentTransferId = null;
            if (this.chunkTransferTimeout) clearTimeout(this.chunkTransferTimeout);
            this.chunkTransferTimeout = null;
            this.processQueue();
        }
    }

    // --- Connection Management ---
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
        if (this.settings.connectionMode === 'peerjs') {
            this.initializePeer(onOpen);
        } else if (this.settings.connectionMode === 'direct-ip') {
            if (!Platform.isMobile) {
                this.log("Direct IP mode is active, but requires user action (Host or Connect) to start.");
            }
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
            new Notice(`Decentralized Sync network is online.`);
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
        this.peer.on('disconnected', () => { new Notice('Sync network disconnected. Attempting to reconnect...'); this.updateStatus("🔌 Reconnecting..."); this.reinitializeConnectionManager(); });
        this.peer.on('close', () => { new Notice('Sync connection closed permanently.'); this.handlePeerError(new Error("Peer closed.")); });
    }

    private handlePeerError(err: any) {
        console.error("PeerJS Error:", err);
        this.updateStatus(`❌ Error: ${err.type || 'Connection Failed'}`);
        this.peer?.destroy();
        this.peer = null;

        this.connections.forEach(conn => conn.close());
        this.connections.clear();
        this.clusterPeers.clear();

        this.peerInitAttempts++;
        const backoff = Math.min(30000, 1000 + this.peerInitAttempts * 2000); // Start with shorter backoff
        new Notice(`Sync connection failed. Retrying in ${backoff / 1000}s...`);

        if (this.peerInitRetryTimeout) clearTimeout(this.peerInitRetryTimeout);
        
        setTimeout(() => this.updateStatus(`🔌 Offline (retrying in ${backoff / 1000}s)`), 2000);

        this.peerInitRetryTimeout = window.setTimeout(() => {
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
        conn.on('data', (data: any) => this.processIncomingData(data, conn, 'peerjs'));
        conn.on('close', () => {
            const peerId = conn.peer;
            this.log("DataConnection closed with:", peerId);
            this.connections.delete(peerId);
            const peerInfo = this.clusterPeers.get(peerId);
            this.clusterPeers.delete(peerId);
            if (this.syncState.isSyncing && this.syncState.peerId === peerId) {
                new Notice(`Peer disconnected during full sync. Aborting.`);
                this.resetFullSyncState();
            }
            this.updateStatus();
            if (peerInfo) new Notice(`👋 Peer disconnected: ${peerInfo.friendlyName}`);
            if (peerId === this.settings.companionPeerId) {
                new Notice(`Companion disconnected. Will try to reconnect automatically.`);
                this.log("Companion connection closed, restarting connection attempts.");
                this.tryToConnectToCompanion();
            }
        });
        conn.on('error', (err) => { console.error(`Connection error with ${conn.peer}:`, err); new Notice(`Connection error with a peer.`); });
    }

    processIncomingData(data: any, conn: DataConnection | null, source: 'peerjs' | 'direct-ip') {
        if (!data || !data.type) return;
        this.log("Received data:", data.type, "from", conn?.peer || 'Direct IP');
        
        if (source === 'direct-ip' && data.type === 'file-update' && data.encoding === 'base64') {
            try {
                data.content = base64ToArrayBuffer(data.content);
                data.encoding = 'binary';
            } catch (e) {
                console.error("Failed to decode Base64 content from Direct IP:", e);
                return;
            }
        }

        switch (data.type) {
            case 'handshake': this.handleHandshake(data, conn!); break;
            case 'cluster-gossip': this.handleClusterGossip(data); break;
            case 'companion-pair': this.handleCompanionPair(data); break;
            case 'ack':
                if (data.transferId === this.currentTransferId) {
                    if (this.chunkTransferTimeout) clearTimeout(this.chunkTransferTimeout);
                    this.chunkTransferTimeout = null;
                    this.log(`Ack received for chunked transfer ${this.currentTransferId}. Processing next item.`);
                    this.currentTransferId = null;
                    this.isQueueProcessing = false;
                    this.processQueue();
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
            case 'full-sync-batch-complete': this.handleFullSyncBatchComplete(conn!); break;
            case 'full-sync-complete': this.handleFullSyncComplete(); break; // Legacy, kept for compatibility
            case 'file-chunk-start': this.handleFileChunkStart(data); break;
            case 'file-chunk-data': this.handleFileChunkData(data, conn!); break;
        }
    }

    handleHandshake(data: HandshakePayload, conn: DataConnection) {
        if (this.joinPin && data.pin !== this.joinPin) { new Notice(`Incorrect PIN from ${data.peerInfo.friendlyName}. Connection rejected.`, 10000); conn.close(); return; }
        if (this.joinPin) this.joinPin = null; new Notice(`🤝 Connected to ${data.peerInfo.friendlyName}`);
        this.connections.set(conn.peer, conn); this.clusterPeers.set(conn.peer, data.peerInfo); this.updateStatus();
        const existingPeers = Array.from(this.clusterPeers.values());
        conn.send({ type: 'cluster-gossip', peers: existingPeers });
        this.broadcastData({ type: 'cluster-gossip', peers: [this.getMyPeerInfo(), data.peerInfo] });
    }

    handleClusterGossip(data: ClusterGossipPayload) {
        if (this.settings.connectionMode !== 'peerjs') return;
        data.peers.forEach(peerInfo => {
            if (peerInfo.deviceId === this.settings.deviceId || this.connections.has(peerInfo.deviceId)) return;
            if (this.peer && !this.peer.disconnected) { this.log("Gossip: attempting to connect to new peer", peerInfo.friendlyName); const conn = this.peer.connect(peerInfo.deviceId, { reliable: true }); this.setupConnection(conn); }
        });
    }

    async handleCompanionPair(data: CompanionPairPayload) {
        this.settings.companionPeerId = data.peerInfo.deviceId; await this.saveSettings();
        new Notice(`✅ Paired with ${data.peerInfo.friendlyName} as a companion device.`);
        this.tryToConnectToCompanion();
    }

    tryToConnectToCompanion() {
        if (this.settings.connectionMode !== 'peerjs') return;
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
        this.settings.companionPeerId = undefined; await this.saveSettings(); new Notice('Companion link forgotten.');
    }

    async sendFileUpdate(file: TFile, peerId?: string) {
        if (!this.isPathSyncable(file.path)) return;
        if (!this.isFiletypeSyncable(file.extension)) {
            this.log(`Skipping file with non-whitelisted extension because syncAllFileTypes is off: ${file.path}`);
            return;
        }

        this.log(`Queueing file update for ${peerId || 'broadcast'}: ${file.path}`);
        try {
            const isBinary = this.isBinary(file.extension);
            const content = await this.app.vault[isBinary ? 'readBinary' : 'cachedRead'](file);
            const payload: FileUpdatePayload = { type: 'file-update', path: file.path, content, mtime: file.stat.mtime, encoding: isBinary ? 'binary' : 'utf8' };
            if (peerId) { this.sendData(peerId, payload); } else { this.broadcastData(payload); }
        } catch (e) { console.error(`Error reading file ${file.path} for sync:`, e); }
    }

    private isFiletypeSyncable(extension: string): boolean {
        if (this.settings.syncAllFileTypes) {
            return true;
        }
        const textWhitelist = ['md', 'css', 'js', 'json', 'txt', 'html', 'xml', 'csv', 'yaml', 'toml'];
        return textWhitelist.includes((extension || '').toLowerCase());
    }

    private isBinary(extension: string): boolean { const textExtensions = ['md', 'txt', 'json', 'css', 'js', 'html', 'xml', 'csv', 'yaml', 'toml']; return !textExtensions.includes((extension || '').toLowerCase()); }
    private areArrayBuffersEqual(buf1: ArrayBuffer, buf2: ArrayBuffer): boolean { if (buf1.byteLength !== buf2.byteLength) return false; const view1 = new Uint8Array(buf1); const view2 = new Uint8Array(buf2); for (let i = 0; i < buf1.byteLength; i++) { if (view1[i] !== view2[i]) return false; } return true; }

    async sendFileInChunks(peerId: string, path: string, mtime: number, fileContent: ArrayBuffer, transferId: string) {
        const conn = this.connections.get(peerId);
        if (!conn?.open) { this.log(`No open connection to ${peerId} to send chunks. Aborting transfer.`); this.isQueueProcessing = false; this.processQueue(); return; }
        const totalChunks = Math.ceil(fileContent.byteLength / CHUNK_SIZE);
        this.log(`Sending file in ${totalChunks} chunks to ${peerId}: ${path} (ID: ${transferId})`);
        conn.send({ type: 'file-chunk-start', path, mtime, totalChunks, transferId });
        for (let i = 0; i < totalChunks; i++) {
            if (!conn.open) { this.log(`Connection to ${peerId} closed mid-transfer. Aborting.`); return; }
            const start = i * CHUNK_SIZE; const end = start + CHUNK_SIZE; const chunk = fileContent.slice(start, end);
            conn.send({ type: 'file-chunk-data', transferId, index: i, data: chunk });
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        this.log(`Finished sending all chunks for ${path} to ${peerId}. Waiting for ack.`);
    }

    handleFileChunkStart(payload: FileChunkStartPayload) { this.pendingFileChunks.set(payload.transferId, { path: payload.path, mtime: payload.mtime, chunks: new Array(payload.totalChunks), total: payload.totalChunks, }); this.log(`Receiving chunked file: ${payload.path}, ID: ${payload.transferId}`); }
    async handleFileChunkData(payload: FileChunkDataPayload, conn: DataConnection) {
        const transfer = this.pendingFileChunks.get(payload.transferId); if (!transfer) { this.log("Received chunk for unknown transfer:", payload.transferId); return; }
        transfer.chunks[payload.index] = payload.data;
        if (transfer.chunks.every(chunk => chunk !== undefined)) {
            this.log(`All chunks received for ${transfer.path}. Reassembling...`); this.pendingFileChunks.delete(payload.transferId);
            const totalSize = transfer.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0); const reassembled = new Uint8Array(totalSize); let offset = 0;
            for (const chunk of transfer.chunks) { reassembled.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }
            await this.applyFileUpdate({ type: 'file-update', path: transfer.path, content: reassembled.buffer, mtime: transfer.mtime, encoding: 'binary', });
            conn.send({ type: 'ack', transferId: payload.transferId }); this.log(`Reassembly complete for ${transfer.path}, sent ack.`);
        }
    }

    async applyFileUpdate(data: FileUpdatePayload) {
        if (!this.isPathSyncable(data.path)) return; const existingFile = this.app.vault.getAbstractFileByPath(data.path);
        const isBinary = data.encoding === 'binary' || data.encoding === 'base64';
        
        if (!existingFile) {
            this.log(`Creating new file: ${data.path}`); this.ignoreNextEventForPath(data.path);
            try {
                const folderPath = data.path.substring(0, data.path.lastIndexOf('/')); if (folderPath && !this.app.vault.getAbstractFileByPath(folderPath)) { await this.app.vault.createFolder(folderPath); }
                if (isBinary) { await this.app.vault.createBinary(data.path, data.content as ArrayBuffer); } else { await this.app.vault.create(data.path, data.content as string); }
            } catch (e) { console.error("File creation error:", e); new Notice(`Failed to create file: ${data.path}`); } return;
        }
        if (existingFile instanceof TFile) {
            if (data.mtime > existingFile.stat.mtime + MTIME_TOLERANCE_MS) { this.log(`Applying update (remote is newer): ${data.path}`); this.ignoreNextEventForPath(data.path); if (isBinary) { await this.app.vault.modifyBinary(existingFile, data.content as ArrayBuffer); } else { await this.app.vault.modify(existingFile, data.content as string); } return; }
            if (data.mtime < existingFile.stat.mtime - MTIME_TOLERANCE_MS) { this.log(`Ignoring update (local is newer): ${data.path}`); return; }
            const localContent = isBinary ? await this.app.vault.readBinary(existingFile) : await this.app.vault.cachedRead(existingFile);
            const contentIsSame = isBinary ? this.areArrayBuffersEqual(localContent as ArrayBuffer, data.content as ArrayBuffer) : localContent === data.content;
            if (contentIsSame) { this.log(`Ignoring update (content is identical): ${data.path}`); return; }
            new Notice(`Conflict detected for: ${data.path}`, 10000); this.log(`Conflict detected for: ${data.path}. Strategy: ${this.settings.conflictResolutionStrategy}`);
            switch (this.settings.conflictResolutionStrategy) {
                case 'last-write-wins': this.log(`Conflict resolved by 'last-write-wins' (remote wins): ${data.path}`); this.ignoreNextEventForPath(data.path); if (isBinary) { await this.app.vault.modifyBinary(existingFile, data.content as ArrayBuffer); } else { await this.app.vault.modify(existingFile, data.content as string); } break;
                case 'attempt-auto-merge': if (isBinary || !data.path.endsWith('.md')) { this.log(`Cannot auto-merge binary or non-md file, creating conflict file: ${data.path}`); await this.createConflictFile(data); break; } const dmp = new DiffMatchPatch(); const patches = dmp.patch_make(localContent as string, data.content as string); const [mergedContent, results] = dmp.patch_apply(patches, localContent as string); if (results.every(r => r)) { this.log(`Conflict successfully auto-merged: ${data.path}`); this.ignoreNextEventForPath(data.path); await this.app.vault.modify(existingFile, mergedContent); new Notice(`Successfully auto-merged ${data.path}`); } else { this.log(`Auto-merge failed, creating conflict file: ${data.path}`); await this.createConflictFile(data); } break;
                case 'create-conflict-file': default: this.log(`Creating conflict file for: ${data.path}`); await this.createConflictFile(data); break;
            }
        }
    }

    async createConflictFile(data: FileUpdatePayload) { const conflictPath = this.getConflictPath(data.path); const isBinary = data.encoding === 'binary' || data.encoding === 'base64'; if (isBinary) { await this.app.vault.createBinary(conflictPath, data.content as ArrayBuffer); } else { await this.app.vault.create(conflictPath, data.content as string); } this.conflictCenter.addConflict(data.path, conflictPath); }
    async applyFileDelete(data: FileDeletePayload) { if (!this.isPathSyncable(data.path)) return; const existingFile = this.app.vault.getAbstractFileByPath(data.path); if (existingFile) { try { this.log(`Deleting file/folder: ${data.path}`); this.ignoreNextEventForPath(data.path, 5000); await this.app.vault.delete(existingFile, true); } catch (e) { console.error(`Error deleting file: ${data.path}`, e); new Notice(`Failed to delete file: ${data.path}`); } } }
    async applyFileRename(data: FileRenamePayload) { if (!this.isPathSyncable(data.oldPath) && !this.isPathSyncable(data.newPath)) return; const fileToRename = this.app.vault.getAbstractFileByPath(data.oldPath); if (fileToRename instanceof TFile) { try { this.log(`Renaming file: ${data.oldPath} -> ${data.newPath}`); this.ignoreNextEventForPath(data.newPath); await this.app.vault.rename(fileToRename, data.newPath); } catch (e) { console.error(`Error renaming file: ${data.oldPath} -> ${data.newPath}`, e); new Notice(`Failed to rename file: ${data.oldPath}`); } } }
    async applyFolderCreate(data: FolderCreatePayload) { if (!this.isPathSyncable(data.path)) return; if (this.app.vault.getAbstractFileByPath(data.path)) return; this.log(`Creating folder: ${data.path}`); this.ignoreNextEventForPath(data.path); try { await this.app.vault.createFolder(data.path); } catch (e) { console.error(`Failed to create folder ${data.path}`, e); } }
    async applyFolderDelete(data: FolderDeletePayload) { if (!this.isPathSyncable(data.path)) return; const folder = this.app.vault.getAbstractFileByPath(data.path); if (folder instanceof TFolder) { this.log(`Deleting folder: ${data.path}`); this.ignoreNextEventForPath(data.path, 5000); try { await this.app.vault.delete(folder, true); } catch (e) { console.error(`Failed to delete folder ${data.path}`, e); } } }
    async applyFolderRename(data: FolderRenamePayload) { if (!this.isPathSyncable(data.oldPath) && !this.isPathSyncable(data.newPath)) return; const folder = this.app.vault.getAbstractFileByPath(data.oldPath); if (folder instanceof TFolder) { this.log(`Renaming folder: ${data.oldPath} -> ${data.newPath}`); this.ignoreNextEventForPath(data.oldPath); this.ignoreNextEventForPath(data.newPath); try { await this.app.vault.rename(folder, data.newPath); } catch (e) { console.error(`Failed to rename folder ${data.oldPath}`, e); } } }

    private async buildVaultManifest(): Promise<VaultManifest> {
        const manifest: VaultManifest = []; const allFiles = this.app.vault.getAllLoadedFiles();
        for (const file of allFiles) { if (this.isPathSyncable(file.path)) { if (file instanceof TFolder) { if (file.path !== '/') manifest.push({ type: 'folder', path: file.path }); } else if (file instanceof TFile) { manifest.push({ type: 'file', path: file.path, mtime: file.stat.mtime, size: file.stat.size }); } } } return manifest;
    }

    async requestFullSyncFromPeer(peerId: string) {
        if (this.syncState.isSyncing) { new Notice("A sync is already in progress."); return; }
        const conn = this.connections.get(peerId); if (!conn) { new Notice("Peer not found."); return; }
        
        new Notice(`Starting full sync with ${this.clusterPeers.get(peerId)?.friendlyName}...`);
        this.syncState = { isSyncing: true, peerId, sentMyBatchComplete: false, receivedPeerBatchComplete: false };
        this.updateStatus(); 
        
        try {
            const localManifest = await this.buildVaultManifest();
            this.log(`Sending sync request with ${localManifest.length} items.`); 
            this.sendData(peerId, { type: 'request-full-sync', manifest: localManifest });
        } catch (e) {
            console.error("Failed to start full sync:", e);
            new Notice("Error starting full sync. See console for details.");
            this.resetFullSyncState();
        }
    }

    async handleFullSyncRequest(data: FullSyncRequestPayload, conn: DataConnection) {
        if (this.syncState.isSyncing) { new Notice(`Received a sync request from ${this.clusterPeers.get(conn.peer)?.friendlyName}, but a sync is already in progress. Ignoring.`); return; }
        new Notice(`Peer ${this.clusterPeers.get(conn.peer)?.friendlyName} requested a full sync. Comparing vaults...`);
        this.syncState = { isSyncing: true, peerId: conn.peer, sentMyBatchComplete: false, receivedPeerBatchComplete: false };
        this.updateStatus();

        try {
            const remoteManifest = data.manifest; 
            const localManifest = await this.buildVaultManifest();
            const remoteIndex = new Map(remoteManifest.map(item => [item.path, item])); 
            const localIndex = new Map(localManifest.map(item => [item.path, item]));
            
            const filesInitiatorMustSend: string[] = []; // Files they have that I don't/mine are older
            const filesReceiverWillSend: string[] = []; // Files I have that they don't/theirs are older
            const filesInitiatorMustDelete: string[] = []; // Files I have that they don't
            const filesReceiverMustDelete: string[] = []; // Files they have that I don't

            // Compare local to remote
            localIndex.forEach((localItem, path) => {
                const remoteItem = remoteIndex.get(path);
                if (!remoteItem) {
                    filesReceiverWillSend.push(path); // I have it, they don't. I'll send it.
                } else if (localItem.type === 'file' && remoteItem.type === 'file') {
                    if (localItem.mtime > remoteItem.mtime + MTIME_TOLERANCE_MS) {
                        filesReceiverWillSend.push(path); // Mine is newer. I'll send it.
                    }
                }
            });

            // Compare remote to local
            remoteIndex.forEach((remoteItem, path) => {
                const localItem = localIndex.get(path);
                if (!localItem) {
                    filesInitiatorMustSend.push(path); // They have it, I don't. They must send it.
                } else if (remoteItem.type === 'file' && localItem.type === 'file') {
                    if (remoteItem.mtime > localItem.mtime + MTIME_TOLERANCE_MS) {
                        filesInitiatorMustSend.push(path); // Theirs is newer. They must send it.
                    }
                }
            });

            // Calculate deletions. A file is deleted if it exists on one manifest but not the other *after* update calculations.
            // This logic is tricky. Let's simplify: deletions are handled if a file exists on one but not the other.
            const allLocalPaths = new Set(localManifest.map(i => i.path));
            const allRemotePaths = new Set(remoteManifest.map(i => i.path));

            allLocalPaths.forEach(path => {
                if (!allRemotePaths.has(path)) filesInitiatorMustDelete.push(path); // I have it, they don't -> they should delete it.
            });
            allRemotePaths.forEach(path => {
                if (!allLocalPaths.has(path)) filesReceiverMustDelete.push(path); // They have it, I don't -> I should delete it.
            });

            this.log(`Sync plan: They send ${filesInitiatorMustSend.length}, I send ${filesReceiverWillSend.length}. They delete ${filesReceiverMustDelete.length}, I delete ${filesInitiatorMustDelete.length}`);
            this.sendData(conn.peer, { type: 'response-full-sync', filesReceiverWillSend, filesInitiatorMustSend, filesInitiatorMustDelete, filesReceiverMustDelete });

            // This device (the receiver) starts its work
            this.executeSyncActions(conn.peer, filesReceiverWillSend, filesInitiatorMustDelete);
        } catch(e) {
            console.error("Error during full sync request handling:", e);
            new Notice("Error processing sync request. See console for details.");
            this.sendData(conn.peer, {type: 'full-sync-complete'}); // Tell peer to abort
            this.resetFullSyncState();
        }
    }

    async handleFullSyncResponse(data: FullSyncResponsePayload, conn: DataConnection) {
        if (!this.syncState.isSyncing || this.syncState.peerId !== conn.peer) return;
        new Notice("Received sync plan. Exchanging files and deletions..."); 
        this.log(`Sync plan: I must send ${data.filesInitiatorMustSend.length}, will receive ${data.filesReceiverWillSend.length}. I must delete ${data.filesInitiatorMustDelete.length}, will receive deletions for ${data.filesReceiverMustDelete.length}`);
        
        // This device (the initiator) starts its work
        this.executeSyncActions(conn.peer, data.filesInitiatorMustSend, data.filesReceiverMustDelete);
    }
    
    async executeSyncActions(peerId: string, filesToSend: string[], filesToDelete: string[]) {
        if (!this.syncState.isSyncing) return;
        try {
            // Process sends
            for (const path of filesToSend) {
                const item = this.app.vault.getAbstractFileByPath(path);
                if (item instanceof TFile) {
                    await this.sendFileUpdate(item, peerId);
                } else if (item instanceof TFolder) {
                    this.sendData(peerId, { type: 'folder-create', path });
                }
            }
            // Process own deletions
            for (const path of filesToDelete) {
                const item = this.app.vault.getAbstractFileByPath(path);
                if (item) {
                    this.log(`Full Sync: Deleting ${path}`);
                    await this.applyFileDelete({type: 'file-delete', path}); // use apply to handle ignore logic
                }
            }
            // After finishing my batch, I notify the peer.
            this.log("Finished sending my batch of sync actions.");
            this.sendData(peerId, { type: 'full-sync-batch-complete' });
            this.syncState.sentMyBatchComplete = true;
            this.checkFullSyncCompletion();
        } catch(e) {
            console.error("Error executing sync actions:", e);
            new Notice("Error during file exchange. Aborting sync.");
            this.sendData(peerId, {type: 'full-sync-complete'}); // Tell peer to abort
            this.resetFullSyncState();
        }
    }

    handleFullSyncBatchComplete(conn: DataConnection) {
        if (!this.syncState.isSyncing || this.syncState.peerId !== conn.peer) return;
        this.log("Received peer's batch completion signal.");
        this.syncState.receivedPeerBatchComplete = true;
        this.checkFullSyncCompletion();
    }

    checkFullSyncCompletion() {
        if (this.syncState.isSyncing && this.syncState.sentMyBatchComplete && this.syncState.receivedPeerBatchComplete) {
            this.log("Both peers have completed their sync batches. Sync is complete.");
            this.handleFullSyncComplete();
        }
    }
    
    resetFullSyncState() {
        this.syncState = { isSyncing: false, peerId: null, sentMyBatchComplete: false, receivedPeerBatchComplete: false };
        this.syncQueue = []; 
        this.isQueueProcessing = false; 
        this.currentTransferId = null;
        this.updateStatus();
    }

    handleFullSyncComplete() { 
        if (!this.syncState.isSyncing) return; 
        this.resetFullSyncState();
        new Notice("✅ Full sync complete."); 
    }

    private isPathSyncable(path: string): boolean {
        if (path.startsWith('.obsidian/') && !this.settings.syncObsidianConfig) { return false; }
        const excluded = this.settings.excludedFolders.split('\n').map(p => p.trim()).filter(Boolean);
        const included = this.settings.includedFolders.split('\n').map(p => p.trim()).filter(Boolean);
        if (excluded.length > 0 && excluded.some(p => path.startsWith(p))) { return false; }
        if (included.length > 0 && !included.some(p => path.startsWith(p))) { return false; }
        return true;
    }

    getConflictPath(originalPath: string): string { const extension = originalPath.split('.').pop() || ''; const base = originalPath.substring(0, originalPath.lastIndexOf('.')); const date = new Date().toISOString().split('T')[0]; return `${base} (conflict on ${date}).${extension}`; }
    getLocalIp(): string | null { if (Platform.isMobile) return null; try { const os = require('os'); const interfaces = os.networkInterfaces(); for (const name in interfaces) { for (const net of interfaces[name]!) { if (net.family === 'IPv4' && !net.internal) return net.address; } } } catch (e) { console.warn("Could not get local IP address.", e); } return null; }
    getMyPeerInfo(): PeerInfo { return { deviceId: this.peer?.id || this.settings.deviceId, friendlyName: this.settings.friendlyName, ip: this.getLocalIp() }; }

    public startDirectIpHost() { if (Platform.isMobile) return; this.reinitializeConnectionManager(); const pin = Math.floor(100000 + Math.random() * 900000).toString(); this.directIpServer = new DirectIpServer(this, this.settings.directIpHostPort, pin); this.updateStatus(); return pin; }
    public async connectToDirectIpHost(config: DirectIpConfig) { this.reinitializeConnectionManager(); this.directIpClient = new DirectIpClient(this, config); const hostId = `${config.host}:${config.port}`; this.clusterPeers.set(hostId, { deviceId: hostId, friendlyName: `Host (${config.host})`, ip: config.host }); this.updateStatus(); }

    updateStatus(statusText?: string) {
        if (statusText) { this.statusBar.setText(statusText); return; }
        let currentStatus = "🔄 Sync Idle";
        if (this.syncState.isSyncing) { currentStatus = "⚙️ Full Syncing..."; }
        else if (this.isQueueProcessing) { currentStatus = `⏳ Syncing (${this.syncQueue.length + 1} item${this.syncQueue.length > 0 ? 's' : ''})`; }
        else if (this.settings.connectionMode === 'direct-ip') { if (this.directIpServer) currentStatus = `Host Mode`; else if (this.directIpClient) currentStatus = `Client Mode`; else currentStatus = `❌ Sync Offline (Direct IP)`; }
        else {
            if (!this.peer || this.peer.disconnected) { currentStatus = "❌ Sync Offline"; }
            else if (!this.peer.id) { currentStatus = "🔌 Connecting..."; }
            else if (this.connections.size > 0) { const totalDevices = this.connections.size + 1; currentStatus = `✅ Sync Cluster (${totalDevices} device${totalDevices > 1 ? 's' : ''})`; }
            else { currentStatus = "✅ Sync Online"; }
        }
        this.statusBar.setText(currentStatus);
    }
}


class ConnectionModal extends Modal {
    private discoveredPeers: Map<string, PeerInfo> = new Map();

    constructor(app: App, private plugin: ObsidianDecentralizedPlugin) { super(app); }

    onOpen() {
        this.injectStyles();
        this.showInitialOptions();
    }

    onClose() {
        this.plugin.lanDiscovery.stop();
        this.contentEl.empty();
    }

    injectStyles() {
        const styleId = 'obsidian-decentralized-styles';
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.innerHTML = `
            .obsidian-decentralized-connect-modal .qr-code-container { text-align: center; margin-bottom: 1em; }
            .obsidian-decentralized-connect-modal .qr-code-container img { max-width: 200px; margin: auto; background: white; padding: 10px; border-radius: 8px; }
            .obsidian-decentralized-connect-modal .obsidian-decentralized-id-block { font-family: monospace; font-size: 1.1em; padding: 0.8em; background-color: var(--background-secondary); border-radius: 6px; word-break: break-all; user-select: all; margin: 1em 0; text-align: left; }
            .obsidian-decentralized-connect-modal .obsidian-decentralized-info-display { font-family: monospace; font-size: 1.2em; text-align: center; margin: 0.5em 0; }
            .obsidian-decentralized-connect-modal .pin-display { font-size: 3em; font-weight: bold; text-align: center; letter-spacing: 0.5em; margin: 0.5em 0; }
            .obsidian-decentralized-connect-modal .obsidian-decentralized-cluster-list { display: flex; flex-direction: column; gap: 8px; margin-top: 1em; max-height: 200px; overflow-y: auto; }
            .obsidian-decentralized-connect-modal .obsidian-decentralized-peer-entry { display: flex; align-items: center; padding: 10px; background-color: var(--background-secondary); border-radius: 6px; border-left: 4px solid var(--background-modifier-border); cursor: pointer; }
            .obsidian-decentralized-connect-modal .obsidian-decentralized-peer-entry:hover { background-color: var(--background-modifier-hover); }
            .obsidian-decentralized-connect-modal .obsidian-decentralized-peer-entry .peer-info { flex-grow: 1; pointer-events: none; }
            .obsidian-decentralized-connect-modal .obsidian-decentralized-peer-entry .peer-name { font-weight: bold; display: block; }
            .obsidian-decentralized-connect-modal .obsidian-decentralized-peer-entry .peer-details { font-size: var(--font-ui-small); color: var(--text-muted); }
        `;
        document.head.appendChild(style);
    }

    showInitialOptions() {
        this.plugin.lanDiscovery.stop();
        const { contentEl } = this;
        this.modalEl.addClass('obsidian-decentralized-connect-modal');
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Connect Devices' });

        new Setting(contentEl).setName("PeerJS (Internet/LAN)").setDesc("Connect using the standard PeerJS cloud or your own server. Recommended for most users.").addButton(btn => btn.setButtonText("Setup").setCta().onClick(() => this.showPeerJsMenu()));

        if (this.plugin.settings.enableExperimentalFeatures) {
            new Setting(contentEl).setName("Direct IP (Offline LAN Only)").setDesc("Experimental. Connect directly to another device on your LAN using its IP address. No internet needed.").addButton(btn => btn.setButtonText("Setup").onClick(() => this.showDirectIpMenu()));
        }
    }

    showPeerJsMenu() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'PeerJS Connection' });

        new Setting(contentEl).setName("Companion Mode").setDesc("Set a permanent companion device for automatic connections.").addButton(btn => btn.setButtonText("Setup").setCta().onClick(() => this.showCompanionSetup()));
        new Setting(contentEl).setName("One-Time Connection").setDesc("Temporarily connect to any device.").addButton(btn => btn.setButtonText("Connect").onClick(() => this.showOneTimeConnection()));

        new Setting(contentEl).addButton(btn => btn.setButtonText('Back').onClick(() => this.showInitialOptions()));
    }

    showOneTimeConnection() {
        this.plugin.lanDiscovery.stop();
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'One-Time Connection' });

        if (!Platform.isMobile) {
            new Setting(contentEl).setName("Invite via LAN (No Internet Needed)").setDesc("Broadcast an invitation on your local network. The other device must be on the same Wi-Fi.").addButton(btn => btn.setButtonText("Invite with PIN").onClick(() => this.showInviteLAN()));
        }
        new Setting(contentEl).setName("Invite via ID / QR Code").setDesc("The most secure method. Requires an internet or self-hosted server for the initial handshake.").addButton(btn => btn.setButtonText("Show ID").setCta().onClick(() => this.showMyId(() => this.showOneTimeConnection(), 'Invite with ID', 'On your other device, select "Join a Network" and paste the ID below.')));
        new Setting(contentEl).setName("Join a Network").setDesc("Enter an ID from another device, or discover devices on your LAN.").addButton(btn => btn.setButtonText("Join").onClick(() => this.showJoin()));
        new Setting(contentEl).addButton(btn => btn.setButtonText('Back').onClick(() => this.showPeerJsMenu()));
    }

    showDirectIpMenu() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Direct IP Connection (Experimental)' });
        contentEl.createEl('p', { text: "One device must act as the 'Host' (usually a Desktop). Other devices then connect as 'Clients'." }).addClass('mod-warning');

        if (!Platform.isMobile) {
            new Setting(contentEl).setName("Become a Host").setDesc("Allow other devices on your LAN to connect to you.").addButton(btn => btn.setButtonText("Start Hosting").setCta().onClick(() => this.showDirectIpHost()));
        }

        new Setting(contentEl).setName("Connect to a Host").setDesc("Enter the IP Address and PIN from your Host device.").addButton(btn => btn.setButtonText("Connect").onClick(() => this.showDirectIpClient()));

        new Setting(contentEl).addButton(btn => btn.setButtonText('Back').onClick(() => this.showInitialOptions()));
    }

    showDirectIpHost() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Direct IP Host Mode' });

        const pin = this.plugin.startDirectIpHost();
        if (!pin) {
            contentEl.createEl('p', { text: 'Could not start host server. Check console for errors.' });
            new Setting(contentEl).addButton(btn => btn.setButtonText("Back").onClick(() => this.showDirectIpMenu()));
            return;
        }

        contentEl.createEl('p', { text: 'This device is now hosting. On your client device, enter the following information:' });

        const ip = this.plugin.getLocalIp();
        if (ip) {
            contentEl.createEl('div', { text: `Your IP: ${ip}`, cls: 'obsidian-decentralized-info-display' });
        } else {
            contentEl.createEl('div', { text: `Could not determine IP. Check your system's network settings.`, cls: 'obsidian-decentralized-info-display mod-warning' });
        }
        contentEl.createEl('div', { text: `Port: ${this.plugin.settings.directIpHostPort}`, cls: 'obsidian-decentralized-info-display' });
        contentEl.createEl('div', { text: `Your PIN is:`, cls: 'obsidian-decentralized-info-display' });
        contentEl.createEl('div', { text: pin, cls: 'pin-display' });
        contentEl.createEl('p', { text: 'This window can be closed. The host will remain active.', cls: 'setting-item-description' });

        new Setting(contentEl).addButton(btn => btn.setButtonText("Done").onClick(() => this.close()));
    }

    showDirectIpClient() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Connect to Direct IP Host' });
        contentEl.createEl('p', { text: "Enter the details shown on the host device." });

        const config: DirectIpConfig = {
            host: this.plugin.settings.directIpHostAddress,
            port: this.plugin.settings.directIpHostPort,
            pin: '',
        };

        new Setting(contentEl).setName("Host IP Address").addText(text => text.setValue(config.host).onChange(val => config.host = val));
        new Setting(contentEl).setName("Host Port").addText(text => text.setValue(config.port.toString()).onChange(val => config.port = parseInt(val) || 31235));
        new Setting(contentEl).setName("PIN").addText(text => {
            text.inputEl.type = 'number';
            text.inputEl.maxLength = 6;
            text.setPlaceholder("Enter PIN...").onChange(value => config.pin = value);
        });

        new Setting(contentEl)
            .addButton(btn => btn.setButtonText("Back").onClick(() => this.showDirectIpMenu()))
            .addButton(btn => btn.setButtonText("Connect").setCta().onClick(() => {
                if (!config.host || config.pin.length !== 6) {
                    new Notice("Please enter a valid Host IP and 6-digit PIN.");
                    return;
                }
                this.plugin.connectToDirectIpHost(config);
                this.close();
            }));
    }

    showInviteLAN() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Invite with PIN (LAN)' });
        contentEl.createEl('p', { text: 'Your device is now discoverable on your local network. On the other device, choose "Join a Network" to find this one.' });

        const pin = Math.floor(1000 + Math.random() * 9000).toString().padStart(4, '0');
        this.plugin.joinPin = pin;
        this.plugin.lanDiscovery.startBroadcasting(this.plugin.getMyPeerInfo());

        const ip = this.plugin.getLocalIp();
        if (ip) {
            contentEl.createEl('div', { text: `Your IP: ${ip}`, cls: 'obsidian-decentralized-info-display' });
        }

        contentEl.createEl('div', { text: `Your PIN is:`, cls: 'obsidian-decentralized-info-display' });
        contentEl.createEl('div', { text: pin, cls: 'pin-display' });
        contentEl.createEl('p', { text: 'This PIN will be required to connect.', cls: 'setting-item-description' });

        new Setting(contentEl).addButton(btn => btn.setButtonText("Back").onClick(() => this.showOneTimeConnection()));
    }

    showJoin() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Join Network' });

        if (!Platform.isMobile) {
            contentEl.createEl('h3', { text: 'Discovered on LAN' });
            const discoveryListEl = contentEl.createDiv({ cls: 'obsidian-decentralized-cluster-list' });
            const noPeersEl = discoveryListEl.createEl('p', { text: 'Searching for devices...' });

            this.plugin.lanDiscovery.on('discover', (peerInfo: PeerInfo) => {
                noPeersEl.hide();
                if (peerInfo.deviceId === this.plugin.settings.deviceId) return;
                this.discoveredPeers.set(peerInfo.deviceId, peerInfo);
                this.renderDiscoveredPeers(discoveryListEl);
            });
            this.plugin.lanDiscovery.on('lose', (peerInfo: PeerInfo) => {
                this.discoveredPeers.delete(peerInfo.deviceId);
                this.renderDiscoveredPeers(discoveryListEl);
                if (this.discoveredPeers.size === 0) { noPeersEl.show(); }
            });

            this.plugin.lanDiscovery.startListening();
        }

        contentEl.createEl('h3', { text: 'Manual Connection' });
        let remoteId = '';
        new Setting(contentEl).setName("Peer ID").addText(text => text.setPlaceholder("Paste ID here...").onChange(value => remoteId = value));

        const buttonRow = new Setting(contentEl);
        buttonRow.addButton(btn => btn.setButtonText("Back").onClick(() => this.showOneTimeConnection()));
        buttonRow.addButton(btn => btn.setButtonText("Connect with ID").setCta().onClick(() => {
            if (!remoteId.trim()) { new Notice("Please enter a Peer ID."); return; }
            if (!this.plugin.peer || this.plugin.peer.disconnected) { new Notice("Peer connection is not active. Please initialize PeerJS first."); this.plugin.initializePeer(); return; }

            const conn = this.plugin.peer.connect(remoteId.trim(), { reliable: true });
            this.plugin.setupConnection(conn);
            this.close();
        }));
    }

    renderDiscoveredPeers(container: HTMLElement) {
        container.empty();
        if (this.discoveredPeers.size === 0) {
            container.createEl('p', { text: 'Searching for devices...' });
            return;
        }

        this.discoveredPeers.forEach(peer => {
            const entry = container.createEl('div', { cls: 'obsidian-decentralized-peer-entry' });
            entry.onclick = () => {
                this.showPinPrompt(peer);
            };
            const infoDiv = entry.createDiv({ cls: 'peer-info' });
            infoDiv.createEl('div', { text: peer.friendlyName, cls: 'peer-name' });
            infoDiv.createEl('div', { text: `IP: ${peer.ip} | ID: ${peer.deviceId.substring(0, 12)}...`, cls: 'peer-details' });
        });
    }

    showPinPrompt(peer: PeerInfo) {
        this.plugin.lanDiscovery.stop();
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: `Connect to ${peer.friendlyName}` });
        contentEl.createEl('p', { text: `Enter the PIN displayed on the other device.` });

        let pin = '';
        new Setting(contentEl).setName("PIN").addText(text => {
            text.inputEl.type = 'number';
            text.setPlaceholder("Enter PIN...").onChange(value => pin = value);
        });

        new Setting(contentEl)
            .addButton(btn => btn.setButtonText("Back").onClick(() => this.showJoin()))
            .addButton(btn => btn.setButtonText("Connect").setCta().onClick(() => {
                if (pin.length !== 4) { new Notice("PIN must be 4 digits."); return; }
                if (!this.plugin.peer || this.plugin.peer.disconnected) { new Notice("Peer connection is not active."); this.plugin.initializePeer(); return; }

                const conn = this.plugin.peer.connect(peer.deviceId, { reliable: true });
                this.plugin.setupConnection(conn, pin);
                this.close();
            }));
    }

    showCompanionSetup() {
        this.plugin.lanDiscovery.stop();
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Companion Mode' });

        const companionId = this.plugin.settings.companionPeerId;
        if (companionId) {
            const peerInfo = this.plugin.clusterPeers.get(companionId);
            contentEl.createEl('p', { text: `Currently paired with: ${peerInfo?.friendlyName || 'Unknown Device'}` });
            contentEl.createEl('p', { text: `ID: ${companionId}` }).style.fontSize = 'var(--font-ui-small)';
        } else {
            contentEl.createEl('p', { text: 'Not currently paired with a companion device.' });
        }

        contentEl.createEl('h3', { text: 'Pair a New Companion' });
        contentEl.createEl('p', { text: 'Enter the ID from your other device to create a permanent, automatic link. This will replace any existing companion.' });
        let remoteId = '';
        new Setting(contentEl).setName("Companion's ID").addText(text => text.setPlaceholder("Paste companion's ID...").onChange(value => remoteId = value));
        const buttonRow = new Setting(contentEl);
        buttonRow.addButton(btn => btn.setButtonText('Back').onClick(() => this.showPeerJsMenu()));
        buttonRow.addButton(btn => btn.setButtonText("Show My ID").onClick(() => this.showMyId(() => this.showCompanionSetup(), 'This Device\'s ID', 'On your other device, select "Companion Mode", and paste this ID.')));
        buttonRow.addButton(btn => btn.setButtonText("Pair").setCta().onClick(async () => {
            if (!remoteId.trim()) { new Notice("Please enter a Peer ID."); return; }

            await this.plugin.forgetCompanion();
            this.plugin.settings.companionPeerId = remoteId.trim();
            await this.plugin.saveSettings();
            new Notice(`Set ${remoteId.trim()} as companion. Sending pair request...`);

            if (this.plugin.peer && !this.plugin.peer.disconnected) {
                const conn = this.plugin.peer.connect(remoteId.trim(), { reliable: true });
                this.plugin.setupConnection(conn);
                conn.on('open', () => {
                    conn.send({ type: 'companion-pair', peerInfo: this.plugin.getMyPeerInfo() });
                });
            } else {
                new Notice("Peer connection is not active. Please wait.");
                this.plugin.initializePeer();
            }

            this.plugin.tryToConnectToCompanion();
            this.close();
        }));
    }

    showMyId(backCallback: () => void, title: string, text: string) {
        this.plugin.lanDiscovery.stop();
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: title });
        contentEl.createEl('p', { text });
        const qrEl = contentEl.createDiv({ cls: 'qr-code-container' });
        const idEl = contentEl.createDiv({ cls: 'obsidian-decentralized-id-block', text: 'Loading ID...' });

        this.plugin.initializePeer(async (id) => {
            try {
                const dataUrl = await QRCode.toDataURL(id, { width: 200, margin: 2 });
                qrEl.empty();
                qrEl.createEl('img', { attr: { src: dataUrl } });
                idEl.setText(id);
                new Setting(contentEl)
                    .addButton(btn => btn.setButtonText("Copy ID").onClick(() => { navigator.clipboard.writeText(id); new Notice("ID Copied!"); }))
                    .addButton(btn => btn.setButtonText("Back").onClick(backCallback));
            } catch (e) {
                console.error("QR Code generation failed", e);
                idEl.setText("Error generating QR code.");
            }
        });

        if (!this.plugin.peer || this.plugin.peer.disconnected) {
            idEl.setText("Connecting to sync network to get ID...");
        }
    }
}

class SelectPeerModal extends Modal {
    constructor(app: App, private connections: Map<string, DataConnection>, private clusterPeers: Map<string, PeerInfo>, private onSubmit: (peerId: string) => void) { super(app); }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Force Full Sync with Peer' });
        contentEl.createEl('p', { text: 'This will perform a two-way sync. Files and deletions will be exchanged based on which is newer. This is the safest way to reconcile two vaults.' }).addClass('mod-warning');
        let selectedPeer = '';
        const peerList = Array.from(this.connections.keys());
        if (peerList.length === 0) {
            contentEl.createEl('p', { text: 'No peers are currently connected.' });
            new Setting(contentEl).addButton(btn => btn.setButtonText("OK").onClick(() => this.close()));
            return;
        }
        new Setting(contentEl).setName('Sync with Device').addDropdown(dropdown => {
            peerList.forEach(peerId => {
                const peerInfo = this.clusterPeers.get(peerId);
                dropdown.addOption(peerId, peerInfo?.friendlyName || peerId);
            });
            selectedPeer = dropdown.getValue();
            dropdown.onChange(value => selectedPeer = value);
        });
        new Setting(contentEl)
            .addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
            .addButton(btn => btn.setButtonText('Start Full Sync').setWarning().onClick(() => {
                if (selectedPeer) this.onSubmit(selectedPeer);
                this.close();
            }));
    }
    onClose() { this.contentEl.empty(); }
}

class ConflictCenter {
    private conflicts: Map<string, string> = new Map();
    private ribbonEl: HTMLElement | null = null;
    constructor(private plugin: ObsidianDecentralizedPlugin) { }
    registerRibbon() { this.ribbonEl = this.plugin.addRibbonIcon('swords', 'Resolve Sync Conflicts', () => this.showConflictList()); this.ribbonEl.hide(); }
    addConflict(originalPath: string, conflictPath: string) { this.conflicts.set(originalPath, conflictPath); this.updateRibbon(); }
    resolveConflict(originalPath: string) { this.conflicts.delete(originalPath); this.updateRibbon(); }
    updateRibbon() { if (!this.ribbonEl) return; if (this.conflicts.size > 0) { this.ribbonEl.show(); this.ribbonEl.setAttribute('aria-label', `Resolve ${this.conflicts.size} sync conflicts`); this.ribbonEl.setText(this.conflicts.size.toString()); } else { this.ribbonEl.hide(); } }
    showConflictList() { new ConflictListModal(this.plugin.app, this).open(); }
}

class ConflictListModal extends Modal {
    constructor(app: App, private conflictCenter: ConflictCenter) { super(app); }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Sync Conflicts' });
        const conflicts: Map<string, string> = (this.conflictCenter as any).conflicts;
        if (conflicts.size === 0) { contentEl.createEl('p', { text: 'No conflicts to resolve.' }); return; }
        conflicts.forEach((conflictPath, originalPath) => {
            new Setting(contentEl).setName(originalPath).setDesc(`Conflict file: ${conflictPath}`)
                .addButton(btn => btn.setButtonText('Resolve').setCta().onClick(async () => { this.close(); await this.resolve(originalPath, conflictPath); }));
        });
    }
    async resolve(originalPath: string, conflictPath: string) {
        const originalFile = this.app.vault.getAbstractFileByPath(originalPath) as TFile;
        const conflictFile = this.app.vault.getAbstractFileByPath(conflictPath) as TFile;
        if (!originalFile || !conflictFile) { new Notice("One of the conflict files is missing."); this.conflictCenter.resolveConflict(originalPath); return; }
        const localContent = await this.app.vault.read(originalFile);
        const remoteContent = await this.app.vault.read(conflictFile);
        new ConflictResolutionModal(this.app, localContent, remoteContent, async (chosenContent) => {
            await this.app.vault.modify(originalFile, chosenContent);
            await this.app.vault.delete(conflictFile);
            this.conflictCenter.resolveConflict(originalPath);
            new Notice(`${originalPath} has been resolved.`);
        }).open();
    }
    onClose() { this.contentEl.empty(); }
}

class ConflictResolutionModal extends Modal {
    constructor(app: App, private localContent: string, private remoteContent: string, private onResolve: (chosenContent: string) => void) { super(app); }
    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('obsidian-decentralized-diff-modal');
        contentEl.createEl('h2', { text: 'Resolve Conflict' });
        const dmp = new DiffMatchPatch();
        const diff = dmp.diff_main(this.localContent, this.remoteContent);
        dmp.diff_cleanupSemantic(diff);
        const diffEl = contentEl.createDiv({ cls: 'obsidian-decentralized-diff-view' });
        diffEl.innerHTML = dmp.diff_prettyHtml(diff);
        new Setting(contentEl)
            .addButton(btn => btn.setButtonText('Keep My Version').onClick(() => { this.onResolve(this.localContent); this.close(); }))
            .addButton(btn => btn.setButtonText('Use Their Version').setWarning().onClick(() => { this.onResolve(this.remoteContent); this.close(); }));
    }
    onClose() { this.contentEl.empty(); }
}

class ObsidianDecentralizedSettingTab extends PluginSettingTab {
    plugin: ObsidianDecentralizedPlugin;
    private statusInterval: number | null = null;
    constructor(app: App, plugin: ObsidianDecentralizedPlugin) { super(app, plugin); this.plugin = plugin; }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Obsidian Decentralized' });

        new Setting(containerEl)
            .setName('This Device\'s Name').addText(text => text.setPlaceholder('e.g., My Desktop').setValue(this.plugin.settings.friendlyName)
                .onChange(async (value) => { this.plugin.settings.friendlyName = value; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Connect Devices')
            .setDesc('Open the connection helper to pair, join a network, or use Direct IP mode.')
            .addButton(btn => btn.setButtonText("Connect").setCta().onClick(() => new ConnectionModal(this.app, this.plugin).open()));

        containerEl.createEl('h3', { text: 'Current Cluster' });
        const statusDiv = containerEl.createDiv();
        this.updateStatus(statusDiv);
        this.statusInterval = window.setInterval(() => this.updateStatus(statusDiv), 3000);
        this.plugin.registerInterval(this.statusInterval);

        containerEl.createEl('h2', { text: 'Experimental Features' });
        new Setting(containerEl)
            .setName("Enable Experimental Features")
            .setDesc("WARNING: These features may be unstable and could lead to data loss. Use with caution and always have backups.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableExperimentalFeatures)
                .onChange(async (value) => {
                    this.plugin.settings.enableExperimentalFeatures = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        if (this.plugin.settings.enableExperimentalFeatures) {
            this.displayExperimentalSettings(containerEl);
        }

        containerEl.createEl('h2', { text: 'Advanced Settings' });
        this.displayAdvancedSettings(containerEl);
    }

    displayExperimentalSettings(containerEl: HTMLElement) {
        new Setting(containerEl)
            .setName("Connection Mode")
            .setDesc("Choose how devices connect. 'PeerJS' is standard. 'Direct IP' is for offline LAN sync.")
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
            containerEl.createEl('p', { text: "Direct IP mode must be configured from the 'Connect' modal.", cls: "setting-item-description" });
        }

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
            .addTextArea(text => text.setPlaceholder("Path/To/Include\nAnother/Path")
                .setValue(this.plugin.settings.includedFolders)
                .onChange(async (value) => {
                    this.plugin.settings.includedFolders = value;
                    await this.plugin.saveSettings();
                }));
        new Setting(containerEl)
            .setName("Excluded folders")
            .setDesc("Never sync folders in this list. One folder per line. Takes priority over included folders. Example: 'Attachments/Large Files'.")
            .addTextArea(text => text.setPlaceholder("Path/To/Exclude\nAnother/Path")
                .setValue(this.plugin.settings.excludedFolders)
                .onChange(async (value) => {
                    this.plugin.settings.excludedFolders = value;
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
    }

    displayAdvancedSettings(containerEl: HTMLElement) {
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
                        new Notice("Reconnecting to new PeerJS server...");
                        this.plugin.reinitializeConnectionManager();
                    }));
        }
    }


    hide() {
        if (this.statusInterval) window.clearInterval(this.statusInterval);
    }

    updateStatus(el: HTMLDivElement) {
        if (!el || !el.isConnected) {
            if (this.statusInterval) window.clearInterval(this.statusInterval);
            this.statusInterval = null;
            return;
        }
        el.empty();
        const list = el.createDiv();
        const createEntry = (peer: PeerInfo, type: 'self' | 'companion' | 'peer' | 'host') => {
            const settingItem = new Setting(list)
                .setName(peer.friendlyName + (type === 'self' ? ' (This Device)' : ''))
                .setDesc(`ID: ${peer.deviceId}`);

            if (type === 'companion') {
                settingItem.addButton(btn => btn.setButtonText('Forget').setWarning().onClick(async () => {
                    await this.plugin.forgetCompanion();
                    this.updateStatus(el);
                }));
            }
            if (type === 'peer' || type === 'companion') {
                const conn = this.plugin.connections.get(peer.deviceId);
                if (conn) {
                    settingItem.addButton(btn => btn.setButtonText('Disconnect').onClick(() => {
                        conn.close();
                        new Notice(`Disconnecting from ${peer.friendlyName}`);
                        setTimeout(() => this.updateStatus(el), 100);
                    }));
                }
            } else if (type === 'host') {
                settingItem.addButton(btn => btn.setButtonText('Disconnect').onClick(() => {
                    this.plugin.reinitializeConnectionManager();
                    setTimeout(() => this.updateStatus(el), 100);
                }));
            }
        };

        createEntry(this.plugin.getMyPeerInfo(), 'self');

        if (this.plugin.settings.connectionMode === 'direct-ip') {
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
