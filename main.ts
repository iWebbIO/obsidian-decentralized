import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, Modal, Platform, requestUrl } from 'obsidian';
import Peer, { DataConnection, PeerJSOption } from 'peerjs';
import DiffMatchPatch from 'diff-match-patch';
import * as QRCode from 'qrcode';

const DISCOVERY_PORT = 41234;
const DISCOVERY_MULTICAST_ADDRESS = '224.0.0.114';
const CHUNK_SIZE = 128 * 1024;

type PeerInfo = { deviceId: string; friendlyName: string; ip: string | null; };
type DiscoveryBeacon = { type: 'obsidian-decentralized-beacon'; peerInfo: PeerInfo; };
type HandshakePayload = { type: 'handshake'; peerInfo: PeerInfo; pin?: string; };
type ClusterGossipPayload = { type: 'cluster-gossip'; peers: PeerInfo[]; };
type FileUpdatePayload = { type: 'file-update'; path: string; content: string | ArrayBuffer; mtime: number; encoding: 'utf8' | 'binary' };
type FileDeletePayload = { type: 'file-delete'; path: string; };
type FileRenamePayload = { type: 'file-rename'; oldPath: string; newPath: string; };
type FullSyncRequestPayload = { type: 'request-full-sync' };
type FullSyncManifestPayload = { type: 'full-sync-manifest', paths: string[] };
type FullSyncCompletePayload = { type: 'full-sync-complete' };
type CompanionPairPayload = { type: 'companion-pair'; peerInfo: PeerInfo; };
type FileChunkStartPayload = { type: 'file-chunk-start', path: string, mtime: number, totalChunks: number, transferId: string };
type FileChunkDataPayload = { type: 'file-chunk-data', transferId: string, index: number, data: ArrayBuffer };
type SyncData = FileUpdatePayload | FileDeletePayload | FileRenamePayload | FullSyncRequestPayload | FullSyncManifestPayload | FullSyncCompletePayload | HandshakePayload | ClusterGossipPayload | CompanionPairPayload | FileChunkStartPayload | FileChunkDataPayload;

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

class DummyLANDiscovery implements ILANDiscovery {
    on(event: string, listener: (...args: any[]) => void): this { return this; }
    startBroadcasting(peerInfo: PeerInfo): void {}
    stopBroadcasting(): void {}
    startListening(): void {}
    stop(): void {}
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
            } catch (e) { }
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
                    const data: SyncData = JSON.parse(body);
                    this.plugin.processIncomingData(data, null);
                    res.writeHead(200, CORS_HEADERS);
                    res.end(JSON.stringify({ status: 'ok' }));
                } catch(e) {
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
                    this.plugin.processIncomingData(msg, null);
                }
            }
        } catch(e) {
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
        } catch(e) {
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
    
    private ignoreNextEventForPath: Set<string> = new Set();
    private statusBar: HTMLElement;
    private isFullSyncing: boolean = false;
    private pendingDeletions: string[] = [];
    private conflictCenter: ConflictCenter;
    public joinPin: string | null = null;
    private companionConnectionInterval: number | null = null;
    private pendingFileChunks: Map<string, { path: string, mtime: number, chunks: ArrayBuffer[], total: number }> = new Map();
    
    public directIpServer: DirectIpServer | null = null;
    public directIpClient: DirectIpClient | null = null;

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
        this.addRibbonIcon('refresh-cw', 'Force Pull from Peer', () => {
            if (this.settings.connectionMode === 'direct-ip') {
                new Notice("Force Pull is not available in Direct IP mode yet.");
                return;
            }
            if (this.connections.size === 0) { new Notice("No peers connected."); return; }
            new SelectPeerModal(this.app, this.connections, this.clusterPeers, (peerId: string) => this.requestFullSyncFromPeer(peerId)).open();
        });
        this.registerEvent(this.app.vault.on('modify', this.handleFileModify.bind(this)));
        this.registerEvent(this.app.vault.on('create', this.handleFileCreate.bind(this)));
        this.registerEvent(this.app.vault.on('delete', this.handleFileDelete.bind(this)));
        this.registerEvent(this.app.vault.on('rename', this.handleFileRename.bind(this)));
        this.initializeConnectionManager();
    }

    onunload() { 
        this.peer?.destroy(); 
        if (this.companionConnectionInterval) clearInterval(this.companionConnectionInterval);
        this.lanDiscovery.stop();
        this.directIpServer?.stop();
        this.directIpClient?.stop();
    }
    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }

    public log(...args: any[]) {
        if (this.settings.verboseLogging) {
            console.log("Obsidian Decentralized:", ...args);
        }
    }

    public reinitializeConnectionManager() {
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
        if (this.settings.connectionMode === 'peerjs') {
            this.initializePeer(onOpen);
        } else {
            this.updateStatus();
        }
    }
    
    initializePeer(onOpen?: (id: string) => void) {
        if (this.peer && !this.peer.destroyed) {
            if (onOpen && !this.peer.disconnected) { onOpen(this.peer.id); }
            return;
        }
        
        this.peer?.destroy();

        let peerOptions: PeerJSOption = {};
        if (this.settings.useCustomPeerServer) {
            const { host, port, path, secure } = this.settings.customPeerServerConfig;
            peerOptions = { host, port, path, secure };
        }

        this.peer = new Peer(this.settings.deviceId, peerOptions);
        this.log("Initializing PeerJS with ID:", this.settings.deviceId);

        this.peer.on('open', (id) => {
            this.log(`PeerJS connection open. ID: ${id}`);
            new Notice(`Decentralized Sync network is online.`);
            this.updateStatus();
            this.tryToConnectToCompanion();
            onOpen?.(id);
        });
        this.peer.on('connection', (conn) => {
            this.log("Incoming PeerJS connection from:", conn.peer);
            this.setupConnection(conn);
        });
        this.peer.on('error', (err) => {
            console.error("PeerJS Error:", err);
            new Notice(`Sync connection error: ${err.type}`);
            this.updateStatus();
        });
        this.peer.on('disconnected', () => {
            new Notice('Sync network disconnected. Reconnecting...');
            this.updateStatus();
        });
    }

    setupConnection(conn: DataConnection, pin?: string) {
        conn.on('open', () => {
            this.log("DataConnection open with:", conn.peer);
            conn.send({ type: 'handshake', peerInfo: this.getMyPeerInfo(), pin });
        });
        conn.on('data', (data: SyncData) => this.processIncomingData(data, conn));
        conn.on('close', () => {
            const peerId = conn.peer;
            this.log("DataConnection closed with:", peerId);
            this.connections.delete(peerId);
            const peerInfo = this.clusterPeers.get(peerId);
            this.clusterPeers.delete(peerId);
            this.updateStatus();
            if (peerInfo) new Notice(`👋 Peer disconnected: ${peerInfo.friendlyName}`);
            if (peerId === this.settings.companionPeerId) {
                new Notice(`Companion disconnected. Will try to reconnect automatically.`);
                this.tryToConnectToCompanion();
            }
        });
        conn.on('error', (err) => {
            console.error(`Connection error with ${conn.peer}:`, err);
            new Notice(`Connection error with a peer.`);
        });
    }

    updateStatus() {
        let statusText = "🔄 Sync Idle";
        if (this.settings.connectionMode === 'direct-ip') {
             if (this.directIpServer) statusText = `🔄 Sync Host Mode`;
             else if (this.directIpClient) statusText = `🔄 Sync Client Mode`;
             else statusText = `❌ Sync Offline (Direct IP)`;
        } else {
             if (this.peer?.disconnected || !this.peer) {
                 statusText = "❌ Sync Offline";
             } else if (this.connections.size > 0) {
                 const totalDevices = this.connections.size + 1;
                 statusText = `🔄 Sync Cluster (${totalDevices} device${totalDevices > 1 ? 's' : ''})`;
             }
        }
        this.statusBar.setText(statusText);
    }

    processIncomingData(data: SyncData, conn: DataConnection | null) {
        this.log("Received data:", data.type, "from", conn?.peer);
        switch (data.type) {
            case 'handshake': this.handleHandshake(data, conn!); break;
            case 'cluster-gossip': this.handleClusterGossip(data); break;
            case 'companion-pair': this.handleCompanionPair(data); break;
            case 'file-update': this.applyFileUpdate(data); break;
            case 'file-delete': this.applyFileDelete(data); break;
            case 'file-rename': this.applyFileRename(data); break;
            case 'request-full-sync': this.handleFullSyncRequest(conn!); break;
            case 'full-sync-manifest': this.handleFullSyncManifest(data); break;
            case 'full-sync-complete': this.handleFullSyncComplete(); break;
            case 'file-chunk-start': this.handleFileChunkStart(data); break;
            case 'file-chunk-data': this.handleFileChunkData(data); break;
        }
    }
    
    handleHandshake(data: HandshakePayload, conn: DataConnection) {
        if (this.joinPin && data.pin !== this.joinPin) {
            new Notice(`Incorrect PIN from ${data.peerInfo.friendlyName}. Connection rejected.`, 10000);
            conn.close();
            return;
        }
        if(this.joinPin) this.joinPin = null;

        new Notice(`🤝 Connected to ${data.peerInfo.friendlyName}`);
        this.connections.set(conn.peer, conn);
        this.clusterPeers.set(conn.peer, data.peerInfo);
        this.updateStatus();

        if (conn.peer === this.settings.companionPeerId && this.companionConnectionInterval) {
            clearInterval(this.companionConnectionInterval);
            this.companionConnectionInterval = null;
        }
        
        const existingPeers = Array.from(this.clusterPeers.values());
        conn.send({ type: 'cluster-gossip', peers: existingPeers });
        this.broadcastData({ type: 'cluster-gossip', peers: [this.getMyPeerInfo(), data.peerInfo] });
    }

    handleClusterGossip(data: ClusterGossipPayload) {
        if (this.settings.connectionMode !== 'peerjs') return;
        data.peers.forEach(peerInfo => {
            if (peerInfo.deviceId === this.settings.deviceId || this.connections.has(peerInfo.deviceId)) return;
            if (this.peer && !this.peer.disconnected) {
                this.log("Gossip: attempting to connect to new peer", peerInfo.friendlyName);
                const conn = this.peer.connect(peerInfo.deviceId);
                this.setupConnection(conn);
            }
        });
    }

    async handleCompanionPair(data: CompanionPairPayload) {
        this.settings.companionPeerId = data.peerInfo.deviceId;
        await this.saveSettings();
        new Notice(`✅ Paired with ${data.peerInfo.friendlyName} as a companion device.`);
        this.tryToConnectToCompanion();
    }

    tryToConnectToCompanion() {
        if (this.settings.connectionMode !== 'peerjs') return;
        if (this.companionConnectionInterval) clearInterval(this.companionConnectionInterval);
        if (!this.settings.companionPeerId || !this.peer || this.peer.disconnected) return;
    
        const attemptConnection = () => {
            const companionId = this.settings.companionPeerId;
            if (!companionId) {
                if (this.companionConnectionInterval) clearInterval(this.companionConnectionInterval);
                this.companionConnectionInterval = null;
                return;
            }

            if (this.connections.has(companionId) || !this.peer || this.peer.disconnected) {
                if (this.companionConnectionInterval) clearInterval(this.companionConnectionInterval);
                this.companionConnectionInterval = null;
                return;
            }
            this.log(`Attempting to connect to companion ${companionId}`);
            const conn = this.peer.connect(companionId);
            this.setupConnection(conn);
        };
    
        attemptConnection();
        this.companionConnectionInterval = window.setInterval(attemptConnection, 15000);
        this.registerInterval(this.companionConnectionInterval);
    }
    
    public async forgetCompanion() {
        if (this.companionConnectionInterval) {
            clearInterval(this.companionConnectionInterval);
            this.companionConnectionInterval = null;
        }
        const companionId = this.settings.companionPeerId;
        if (companionId) {
            const conn = this.connections.get(companionId);
            conn?.close();
        }
        this.settings.companionPeerId = undefined;
        await this.saveSettings();
        new Notice('Companion link forgotten.');
    }

    broadcastData(data: SyncData) {
        if (this.settings.connectionMode === 'peerjs') {
            this.connections.forEach(conn => conn.open && conn.send(data));
        } else if (this.directIpServer) {
            this.directIpServer.send(data);
        } else if (this.directIpClient) {
            this.directIpClient.send(data);
        }
    }

    private isPathSyncable(path: string): boolean {
        if (path.startsWith('.obsidian/') && !this.settings.syncObsidianConfig) {
            this.log(`Ignoring path in .obsidian: ${path}`);
            return false;
        }

        const excluded = this.settings.excludedFolders.split('\n').map(p => p.trim()).filter(Boolean);
        const included = this.settings.includedFolders.split('\n').map(p => p.trim()).filter(Boolean);

        if (excluded.length > 0 && excluded.some(p => path.startsWith(p))) {
            this.log(`Ignoring excluded path: ${path}`);
            return false;
        }

        if (included.length > 0 && !included.some(p => path.startsWith(p))) {
            this.log(`Ignoring path not in 'included' list: ${path}`);
            return false;
        }
        
        return true;
    }
    
    async handleFileModify(file: TFile) {
        if (this.ignoreNextEventForPath.has(file.path)) { this.ignoreNextEventForPath.delete(file.path); return; }
        if (!this.isPathSyncable(file.path)) return;

        this.log(`File modified: ${file.path}, size: ${file.stat.size}`);
        const isBinary = !file.extension || !['md', 'txt', 'json', 'css', 'js'].includes(file.extension.toLowerCase());
        
        if (file.stat.size > CHUNK_SIZE) {
            this.sendFileInChunks(file);
            return;
        }

        const content = isBinary ? await this.app.vault.readBinary(file) : await this.app.vault.cachedRead(file);
        this.broadcastData({ type: 'file-update', path: file.path, content: content, mtime: file.stat.mtime, encoding: isBinary ? 'binary' : 'utf8' });
    }

    async sendFileInChunks(file: TFile) {
        const fileContent = await this.app.vault.readBinary(file);
        const totalChunks = Math.ceil(fileContent.byteLength / CHUNK_SIZE);
        const transferId = `${file.path}-${Date.now()}`;
        this.log(`Sending file in ${totalChunks} chunks: ${file.path}`);

        this.broadcastData({ type: 'file-chunk-start', path: file.path, mtime: file.stat.mtime, totalChunks, transferId });
        
        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = start + CHUNK_SIZE;
            const chunk = fileContent.slice(start, end);
            await new Promise(resolve => setTimeout(resolve, 5)); 
            this.broadcastData({ type: 'file-chunk-data', transferId, index: i, data: chunk });
        }
    }

    handleFileChunkStart(payload: FileChunkStartPayload) {
        this.pendingFileChunks.set(payload.transferId, {
            path: payload.path,
            mtime: payload.mtime,
            chunks: new Array(payload.totalChunks),
            total: payload.totalChunks,
        });
        this.log(`Receiving chunked file: ${payload.path}, ID: ${payload.transferId}`);
    }

    async handleFileChunkData(payload: FileChunkDataPayload) {
        const transfer = this.pendingFileChunks.get(payload.transferId);
        if (!transfer) {
            this.log("Received chunk for unknown transfer:", payload.transferId);
            return;
        }

        transfer.chunks[payload.index] = payload.data;
        
        if (transfer.chunks.every(chunk => chunk !== undefined)) {
            this.log(`All chunks received for ${transfer.path}. Reassembling...`);
            this.pendingFileChunks.delete(payload.transferId);
            
            const totalSize = transfer.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
            const reassembled = new Uint8Array(totalSize);
            let offset = 0;
            for (const chunk of transfer.chunks) {
                reassembled.set(new Uint8Array(chunk), offset);
                offset += chunk.byteLength;
            }
            
            await this.applyFileUpdate({
                type: 'file-update',
                path: transfer.path,
                content: reassembled.buffer,
                mtime: transfer.mtime,
                encoding: 'binary',
            });
        }
    }


    handleFileCreate(file: TFile) { if (this.isPathSyncable(file.path)) this.handleFileModify(file); }
    handleFileDelete(file: TFile) { if (this.ignoreNextEventForPath.has(file.path)) { this.ignoreNextEventForPath.delete(file.path); return; } if (this.isPathSyncable(file.path)) this.broadcastData({ type: 'file-delete', path: file.path }); }
    handleFileRename(file: TFile, oldPath: string) { if (this.ignoreNextEventForPath.has(file.path)) { this.ignoreNextEventForPath.delete(file.path); return; } if (this.isPathSyncable(file.path) || this.isPathSyncable(oldPath)) this.broadcastData({ type: 'file-rename', oldPath: oldPath, newPath: file.path }); }
    
    requestFullSyncFromPeer(peerId: string) { const conn = this.connections.get(peerId); if (!conn) { new Notice("Peer not found."); return; } new Notice(`Requesting full sync from ${this.clusterPeers.get(peerId)?.friendlyName}...`); this.isFullSyncing = true; conn.send({ type: 'request-full-sync' }); }
    async handleFullSyncRequest(conn: DataConnection) {
        new Notice(`Peer ${this.clusterPeers.get(conn.peer)?.friendlyName} requested a full sync. Sending vault...`);
        const files = this.app.vault.getFiles().filter(f => this.isPathSyncable(f.path));
        this.log(`Starting full sync, sending ${files.length} files.`);
        
        conn.send({ type: 'full-sync-manifest', paths: files.map(f => f.path) });
        
        for (const file of files) {
            await new Promise(resolve => setTimeout(resolve, 10));
            const isBinary = !file.extension || !['md', 'txt', 'json', 'css', 'js'].includes(file.extension.toLowerCase());
            
            if (this.settings.syncAllFileTypes && file.stat.size > CHUNK_SIZE) {
                this.log(`Sending large file in full sync (relying on PeerJS chunking): ${file.path}`);
            }

            const content = isBinary && this.settings.syncAllFileTypes ? await this.app.vault.readBinary(file) : await this.app.vault.read(file);
            conn.send({ type: 'file-update', path: file.path, content: content, mtime: file.stat.mtime, encoding: isBinary && this.settings.syncAllFileTypes ? 'binary' : 'utf8' });
        }
        conn.send({ type: 'full-sync-complete' });
        new Notice("Full sync data sent.");
    }
    
    handleFullSyncManifest(data: FullSyncManifestPayload) { 
        if (!this.isFullSyncing) { new Notice("Received unexpected sync manifest. Ignoring."); return; }
        const remotePaths = new Set(data.paths);
        this.pendingDeletions = this.app.vault.getFiles()
            .filter(file => this.isPathSyncable(file.path) && !remotePaths.has(file.path))
            .map(file => file.path);
        this.log(`Full Sync Manifest received. ${this.pendingDeletions.length} files marked for deletion.`);
    }

    async handleFullSyncComplete() { 
        if (!this.isFullSyncing) return;
        new Notice("Full sync received. Finalizing..."); 
        for (const path of this.pendingDeletions) { 
            const file = this.app.vault.getAbstractFileByPath(path); 
            if (file) { 
                try {
                    this.log(`Full Sync: deleting ${path}`);
                    this.ignoreNextEventForPath.add(path); 
                    await this.app.vault.delete(file); 
                } catch(e) {
                    console.error(`Error deleting file during full sync: ${path}`, e);
                }
            } 
        } 
        this.pendingDeletions = []; 
        this.isFullSyncing = false;
        new Notice("✅ Full sync complete."); 
    }

    async applyFileUpdate(data: FileUpdatePayload) { 
        if (!this.isPathSyncable(data.path)) return;
        
        const existingFile = this.app.vault.getAbstractFileByPath(data.path); 
        
        if (!existingFile) {
            this.log(`Creating new file: ${data.path}`);
            this.ignoreNextEventForPath.add(data.path);
            try {
                const folderPath = data.path.substring(0, data.path.lastIndexOf('/'));
                if (folderPath && !this.app.vault.getAbstractFileByPath(folderPath)) {
                    await this.app.vault.createFolder(folderPath);
                }
                if (data.encoding === 'binary') {
                    await this.app.vault.createBinary(data.path, data.content as ArrayBuffer);
                } else {
                    await this.app.vault.create(data.path, data.content as string);
                }
            } catch (e) { console.error("File creation error:", e); new Notice(`Failed to create file: ${data.path}`); }
            return;
        }

        if (existingFile instanceof TFile) { 
            const MTIME_TOLERANCE_MS = 2000;
            if (data.mtime > existingFile.stat.mtime + MTIME_TOLERANCE_MS) {
                this.log(`Applying update (remote is newer): ${data.path}`);
                this.ignoreNextEventForPath.add(data.path);
                if (data.encoding === 'binary') {
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

            const localContent = data.encoding === 'binary' ? await this.app.vault.readBinary(existingFile) : await this.app.vault.cachedRead(existingFile);
            const contentIsSame = data.encoding === 'binary' 
                ? Buffer.from(localContent as ArrayBuffer).equals(Buffer.from(data.content as ArrayBuffer))
                : localContent === data.content;

            if (contentIsSame) {
                this.log(`Ignoring update (content is identical): ${data.path}`);
                return;
            }

            new Notice(`Conflict detected for: ${data.path}`, 10000);
            this.log(`Conflict detected for: ${data.path}. Strategy: ${this.settings.conflictResolutionStrategy}`);

            switch(this.settings.conflictResolutionStrategy) {
                case 'last-write-wins':
                    this.log(`Conflict resolved by 'last-write-wins' (remote wins): ${data.path}`);
                    this.ignoreNextEventForPath.add(data.path);
                    if (data.encoding === 'binary') {
                        await this.app.vault.modifyBinary(existingFile, data.content as ArrayBuffer);
                    } else {
                        await this.app.vault.modify(existingFile, data.content as string);
                    }
                    break;
                
                case 'attempt-auto-merge':
                    if (data.encoding === 'binary' || !data.path.endsWith('.md')) {
                        this.log(`Cannot auto-merge binary or non-md file, creating conflict file: ${data.path}`);
                        await this.createConflictFile(data);
                        break;
                    }
                    const dmp = new DiffMatchPatch();
                    const patches = dmp.patch_make(localContent as string, data.content as string);
                    const [mergedContent, results] = dmp.patch_apply(patches, localContent as string);

                    if (results.every(r => r)) {
                        this.log(`Conflict successfully auto-merged: ${data.path}`);
                        this.ignoreNextEventForPath.add(data.path);
                        await this.app.vault.modify(existingFile, mergedContent);
                        new Notice(`Successfully auto-merged ${data.path}`);
                    } else {
                        this.log(`Auto-merge failed, creating conflict file: ${data.path}`);
                        await this.createConflictFile(data);
                    }
                    break;

                case 'create-conflict-file':
                default:
                    this.log(`Creating conflict file for: ${data.path}`);
                    await this.createConflictFile(data);
                    break;
            }
        } 
    }
    
    async createConflictFile(data: FileUpdatePayload) {
        const conflictPath = this.getConflictPath(data.path);
        if (data.encoding === 'binary') {
            await this.app.vault.createBinary(conflictPath, data.content as ArrayBuffer);
        } else {
            await this.app.vault.create(conflictPath, data.content as string);
        }
        this.conflictCenter.addConflict(data.path, conflictPath);
    }

    async applyFileDelete(data: FileDeletePayload) { 
        if (!this.isPathSyncable(data.path)) return;
        const existingFile = this.app.vault.getAbstractFileByPath(data.path); 
        if (existingFile) { 
            try {
                this.log(`Deleting file: ${data.path}`);
                this.ignoreNextEventForPath.add(data.path); 
                await this.app.vault.delete(existingFile); 
            } catch (e) {
                console.error(`Error deleting file: ${data.path}`, e);
                new Notice(`Failed to delete file: ${data.path}`);
            }
        } 
    }
    
    async applyFileRename(data: FileRenamePayload) {
        if (!this.isPathSyncable(data.oldPath) && !this.isPathSyncable(data.newPath)) return;
        
        const fileToRename = this.app.vault.getAbstractFileByPath(data.oldPath);
        if (fileToRename instanceof TFile) {
            try {
                this.log(`Renaming file: ${data.oldPath} -> ${data.newPath}`);
                this.ignoreNextEventForPath.add(data.newPath);
                await this.app.vault.rename(fileToRename, data.newPath);
            } catch (e) {
                console.error(`Error renaming file: ${data.oldPath} -> ${data.newPath}`, e);
                new Notice(`Failed to rename file: ${data.oldPath}`);
            }
        }
    }

    getConflictPath(originalPath: string): string { const extension = originalPath.split('.').pop() || ''; const base = originalPath.substring(0, originalPath.lastIndexOf('.')); const date = new Date().toISOString().split('T')[0]; return `${base} (conflict on ${date}).${extension}`; }
    
    getLocalIp(): string | null {
        if (Platform.isMobile) return null;
        try {
            const os = require('os');
            const interfaces = os.networkInterfaces();
            for (const name in interfaces) {
                for (const net of interfaces[name]!) {
                    if (net.family === 'IPv4' && !net.internal) return net.address;
                }
            }
        } catch (e) { console.warn("Could not get local IP address.", e); }
        return null;
    }
    
    getMyPeerInfo(): PeerInfo {
        return { deviceId: this.peer?.id || this.settings.deviceId, friendlyName: this.settings.friendlyName, ip: this.getLocalIp() };
    }
    
    public startDirectIpHost() {
        if (Platform.isMobile) return;
        this.reinitializeConnectionManager();
        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        this.directIpServer = new DirectIpServer(this, this.settings.directIpHostPort, pin);
        this.updateStatus();
        return pin;
    }
    public async connectToDirectIpHost(config: DirectIpConfig) {
        this.reinitializeConnectionManager();
        this.directIpClient = new DirectIpClient(this, config);
        this.clusterPeers.set(config.host, { deviceId: config.host, friendlyName: `Host (${config.host})`, ip: config.host });
        this.updateStatus();
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
            .obsidian-decentralized-cluster-list { display: flex; flex-direction: column; gap: 8px; margin-top: 1em; max-height: 200px; overflow-y: auto; }
            .obsidian-decentralized-peer-entry { display: flex; align-items: center; padding: 10px; background-color: var(--background-secondary); border-radius: 6px; border-left: 4px solid var(--background-modifier-border); cursor: pointer; }
            .obsidian-decentralized-peer-entry:hover { background-color: var(--background-modifier-hover); }
            .obsidian-decentralized-peer-entry .peer-info { flex-grow: 1; pointer-events: none; }
            .obsidian-decentralized-peer-entry .peer-name { font-weight: bold; display: block; }
            .obsidian-decentralized-peer-entry .peer-details { font-size: var(--font-ui-small); color: var(--text-muted); }
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
        contentEl.createEl('p', { text: "One device must act as the 'Host' (usually a Desktop). Other devices then connect as 'Clients'."}).addClass('mod-warning');

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
        
        contentEl.createEl('p', { text: 'This device is now hosting. On your client device, enter the following information:'});

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
        contentEl.createEl('p', { text: "Enter the details shown on the host device."});

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
        contentEl.createEl('p', { text: 'Your device is now discoverable on your local network. On the other device, choose "Join a Network" to find this one.'});

        const pin = Math.floor(100000 + Math.random() * 900000).toString();
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

            const conn = this.plugin.peer.connect(remoteId.trim());
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
            infoDiv.createEl('div', { text: `IP: ${peer.ip} | ID: ${peer.deviceId.substring(0,12)}...`, cls: 'peer-details' });
        });
    }

    showPinPrompt(peer: PeerInfo) {
        this.plugin.lanDiscovery.stop();
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', {text: `Connect to ${peer.friendlyName}`});
        contentEl.createEl('p', {text: `Enter the 6-digit PIN displayed on the other device.`});

        let pin = '';
        new Setting(contentEl).setName("PIN").addText(text => {
            text.inputEl.type = 'number';
            text.inputEl.maxLength = 6;
            text.setPlaceholder("Enter PIN...").onChange(value => pin = value);
        });

        new Setting(contentEl)
            .addButton(btn => btn.setButtonText("Back").onClick(() => this.showJoin()))
            .addButton(btn => btn.setButtonText("Connect").setCta().onClick(() => {
                if (pin.length !== 6) { new Notice("PIN must be 6 digits."); return; }
                if (!this.plugin.peer || this.plugin.peer.disconnected) { new Notice("Peer connection is not active."); this.plugin.initializePeer(); return; }
                
                const conn = this.plugin.peer.connect(peer.deviceId);
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
                const conn = this.plugin.peer.connect(remoteId.trim());
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
        contentEl.createEl('h2', { text: 'Force Pull from Peer' });
        contentEl.createEl('p', { text: 'This will overwrite local files that are older and delete local files that do not exist on the selected device. This is a one-way sync.'}).addClass('mod-warning');
        let selectedPeer = '';
        const peerList = Array.from(this.connections.keys());
        if (peerList.length === 0) {
            contentEl.createEl('p', { text: 'No peers are currently connected.' });
            new Setting(contentEl).addButton(btn => btn.setButtonText("OK").onClick(() => this.close()));
            return;
        }
        new Setting(contentEl).setName('Source Device').addDropdown(dropdown => {
            peerList.forEach(peerId => {
                const peerInfo = this.clusterPeers.get(peerId);
                dropdown.addOption(peerId, peerInfo?.friendlyName || peerId);
            });
            selectedPeer = dropdown.getValue();
            dropdown.onChange(value => selectedPeer = value);
        });
        new Setting(contentEl)
            .addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
            .addButton(btn => btn.setButtonText('Confirm and Sync').setWarning().onClick(() => {
                if (selectedPeer) this.onSubmit(selectedPeer);
                this.close();
            }));
    }
    onClose() { this.contentEl.empty(); }
}

class ConflictCenter {
    private conflicts: Map<string, string> = new Map();
    private ribbonEl: HTMLElement | null = null;
    constructor(private plugin: ObsidianDecentralizedPlugin) {}
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
        if(!el || !el.isConnected) {
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
                if(conn) {
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
                if(hostInfo) createEntry(hostInfo, 'host');
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
            } else {
                list.createEl('p', { text: 'Not connected to any other devices.' });
            }
        }
    }
}