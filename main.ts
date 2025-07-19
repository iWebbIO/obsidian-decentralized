import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, Modal, Platform } from 'obsidian';
import Peer, { DataConnection, PeerJSOption } from 'peerjs';
import DiffMatchPatch from 'diff-match-patch';
import QRCode from 'qrcode';

const DISCOVERY_PORT = 41234;
const DISCOVERY_MULTICAST_ADDRESS = '224.0.0.114';

type PeerInfo = { deviceId: string; friendlyName: string; ip: string | null; };
type DiscoveryBeacon = { type: 'obsidian-decentralized-beacon'; peerInfo: PeerInfo; };
type HandshakePayload = { type: 'handshake'; peerInfo: PeerInfo; pin?: string; };
type ClusterGossipPayload = { type: 'cluster-gossip'; peers: PeerInfo[]; };
type FileUpdatePayload = { type: 'file-update'; path: string; content: string; mtime: number; };
type FileDeletePayload = { type: 'file-delete'; path: string; };
type FileRenamePayload = { type: 'file-rename'; oldPath: string; newPath: string; };
type FullSyncRequestPayload = { type: 'request-full-sync' };
type FullSyncManifestPayload = { type: 'full-sync-manifest', paths: string[] };
type FullSyncCompletePayload = { type: 'full-sync-complete' };
type CompanionPairPayload = { type: 'companion-pair'; peerInfo: PeerInfo; };
type SyncData = FileUpdatePayload | FileDeletePayload | FileRenamePayload | FullSyncRequestPayload | FullSyncManifestPayload | FullSyncCompletePayload | HandshakePayload | ClusterGossipPayload | CompanionPairPayload;

interface PeerServerConfig {
    host: string;
    port: number;
    path: string;
    secure: boolean;
}

interface ObsidianDecentralizedSettings {
    deviceId: string;
    friendlyName: string;
    companionPeerId?: string;
    useCustomPeerServer: boolean;
    customPeerServerConfig: PeerServerConfig;
}
const DEFAULT_SETTINGS: ObsidianDecentralizedSettings = {
    deviceId: `device-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
    friendlyName: 'My New Device',
    companionPeerId: undefined,
    useCustomPeerServer: false,
    customPeerServerConfig: {
        host: 'localhost',
        port: 9000,
        path: '/myapp',
        secure: false,
    }
};

class LANDiscovery {
    private socket: any | null = null;
    private broadcastInterval: NodeJS.Timeout | null = null;
    private discoveredPeers: Map<string, PeerInfo> = new Map();
    private peerTimeouts: Map<string, NodeJS.Timeout> = new Map();
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
                    
                    const timeout = setTimeout(() => {
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
        
        const beacon = Buffer.from(JSON.stringify({
            type: 'obsidian-decentralized-beacon',
            peerInfo
        }));

        const sendBeacon = () => {
            this.socket?.send(beacon, 0, beacon.length, DISCOVERY_PORT, DISCOVERY_MULTICAST_ADDRESS, (err: Error | null) => {
                if (err) console.error("Beacon send error:", err);
            });
        };
        
        sendBeacon(); 
        this.broadcastInterval = setInterval(sendBeacon, 2000); 
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


export default class ObsidianDecentralizedPlugin extends Plugin {
    settings: ObsidianDecentralizedSettings;
    peer: Peer | null = null;
    connections: Map<string, DataConnection> = new Map();
    clusterPeers: Map<string, PeerInfo> = new Map();
    lanDiscovery: LANDiscovery | undefined;
    
    private ignoreNextEventForPath: Set<string> = new Set();
    private statusBar: HTMLElement;
    private isFullSyncing: boolean = false;
    private pendingDeletions: string[] = [];
    private conflictCenter: ConflictCenter;
    public joinPin: string | null = null;
    private companionConnectionInterval: NodeJS.Timeout | null = null;

    async onload() {
        if (!Platform.isMobile) {
            this.lanDiscovery = new LANDiscovery();
        }

        await this.loadSettings();
        this.statusBar = this.addStatusBarItem();
        this.addSettingTab(new ObsidianDecentralizedSettingTab(this.app, this));
        this.conflictCenter = new ConflictCenter(this);
        this.conflictCenter.registerRibbon();
        this.addRibbonIcon('users', 'Connect to a Peer', () => new ConnectionModal(this.app, this).open());
        this.addRibbonIcon('refresh-cw', 'Force Pull from Peer', () => {
            if (this.connections.size === 0) { new Notice("No peers connected."); return; }
            new SelectPeerModal(this.app, this.connections, this.clusterPeers, (peerId: string) => this.requestFullSyncFromPeer(peerId)).open();
        });
        this.registerEvent(this.app.vault.on('modify', this.handleFileModify.bind(this)));
        this.registerEvent(this.app.vault.on('create', this.handleFileCreate.bind(this)));
        this.registerEvent(this.app.vault.on('delete', this.handleFileDelete.bind(this)));
        this.registerEvent(this.app.vault.on('rename', this.handleFileRename.bind(this)));
        this.initializePeer();
    }

    onunload() { 
        this.peer?.destroy(); 
        if (this.companionConnectionInterval) clearInterval(this.companionConnectionInterval);
        this.lanDiscovery?.stop();
    }
    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }

    public reinitializePeer() {
        this.peer?.destroy();
        this.initializePeer();
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

        this.peer.on('open', (id) => {
            new Notice(`Decentralized Sync network is online.`);
            this.updateStatus();
            this.tryToConnectToCompanion();
            onOpen?.(id);
        });
        this.peer.on('connection', (conn) => {
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
            conn.send({ type: 'handshake', peerInfo: this.getMyPeerInfo(), pin });
        });
        conn.on('data', (data: SyncData) => this.processIncomingData(data, conn));
        conn.on('close', () => {
            const peerId = conn.peer;
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
        if (this.peer?.disconnected || !this.peer) {
            statusText = "❌ Sync Offline";
        } else if (this.connections.size > 0) {
            const totalDevices = this.connections.size + 1;
            statusText = `🔄 Sync Cluster (${totalDevices} device${totalDevices > 1 ? 's' : ''})`;
        }
        this.statusBar.setText(statusText);
    }

    processIncomingData(data: SyncData, conn: DataConnection) {
        switch (data.type) {
            case 'handshake': this.handleHandshake(data, conn); break;
            case 'cluster-gossip': this.handleClusterGossip(data); break;
            case 'companion-pair': this.handleCompanionPair(data); break;
            case 'file-update': this.applyFileUpdate(data); break;
            case 'file-delete': this.applyFileDelete(data); break;
            case 'file-rename': this.applyFileRename(data); break;
            case 'request-full-sync': this.handleFullSyncRequest(conn); break;
            case 'full-sync-manifest': this.handleFullSyncManifest(data); break;
            case 'full-sync-complete': this.handleFullSyncComplete(); break;
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
        data.peers.forEach(peerInfo => {
            if (peerInfo.deviceId === this.settings.deviceId || this.connections.has(peerInfo.deviceId)) return;
            if (this.peer && !this.peer.disconnected) {
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
            console.log(`Obsidian Decentralized: Attempting to connect to companion ${companionId}`);
            const conn = this.peer.connect(companionId);
            this.setupConnection(conn);
        };
    
        attemptConnection();
        this.companionConnectionInterval = setInterval(attemptConnection, 15000);
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

    broadcastData(data: SyncData) { this.connections.forEach(conn => conn.open && conn.send(data)); }
    async handleFileModify(file: TFile) { if (this.ignoreNextEventForPath.has(file.path)) { this.ignoreNextEventForPath.delete(file.path); return; } this.broadcastData({ type: 'file-update', path: file.path, content: await this.app.vault.cachedRead(file), mtime: file.stat.mtime }); }
    handleFileCreate(file: TFile) { this.handleFileModify(file); }
    handleFileDelete(file: TFile) { if (this.ignoreNextEventForPath.has(file.path)) { this.ignoreNextEventForPath.delete(file.path); return; } this.broadcastData({ type: 'file-delete', path: file.path }); }
    handleFileRename(file: TFile, oldPath: string) { if (this.ignoreNextEventForPath.has(file.path)) { this.ignoreNextEventForPath.delete(file.path); return; } this.broadcastData({ type: 'file-rename', oldPath: oldPath, newPath: file.path }); }
    
    requestFullSyncFromPeer(peerId: string) { const conn = this.connections.get(peerId); if (!conn) { new Notice("Peer not found."); return; } new Notice(`Requesting full sync from ${this.clusterPeers.get(peerId)?.friendlyName}...`); this.isFullSyncing = true; conn.send({ type: 'request-full-sync' }); }
    async handleFullSyncRequest(conn: DataConnection) { new Notice(`Peer ${this.clusterPeers.get(conn.peer)?.friendlyName} requested a full sync. Sending vault...`); const files = this.app.vault.getMarkdownFiles(); conn.send({ type: 'full-sync-manifest', paths: files.map(f => f.path) }); for (const file of files) { conn.send({ type: 'file-update', path: file.path, content: await this.app.vault.cachedRead(file), mtime: file.stat.mtime }); } conn.send({ type: 'full-sync-complete' }); new Notice("Full sync data sent."); }
    
    handleFullSyncManifest(data: FullSyncManifestPayload) { 
        if (!this.isFullSyncing) { new Notice("Received unexpected sync manifest. Ignoring."); return; }
        const remotePaths = new Set(data.paths); 
        this.pendingDeletions = this.app.vault.getMarkdownFiles().filter(file => !remotePaths.has(file.path)).map(file => file.path); 
    }

    async handleFullSyncComplete() { 
        if (!this.isFullSyncing) return;
        new Notice("Full sync received. Finalizing..."); 
        for (const path of this.pendingDeletions) { 
            const file = this.app.vault.getAbstractFileByPath(path); 
            if (file) { 
                try {
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
        if (data.path.startsWith('.obsidian/')) { console.warn(`Ignoring sync attempt for protected path: ${data.path}`); return; }

        const existingFile = this.app.vault.getAbstractFileByPath(data.path); 
        if (existingFile instanceof TFile) { 
            const MTIME_TOLERANCE_MS = 2000;
            if (data.mtime > existingFile.stat.mtime + MTIME_TOLERANCE_MS) { 
                this.ignoreNextEventForPath.add(data.path); 
                await this.app.vault.modify(existingFile, data.content); 
                return; 
            } 
            if (data.mtime < existingFile.stat.mtime - MTIME_TOLERANCE_MS) {
                return; 
            } 
            const localContent = await this.app.vault.cachedRead(existingFile); 
            if (localContent !== data.content) { 
                new Notice(`Conflict detected for: ${data.path}`, 10000); 
                const conflictPath = this.getConflictPath(data.path); 
                await this.app.vault.create(conflictPath, data.content); 
                this.conflictCenter.addConflict(data.path, conflictPath); 
            } 
        } else { 
            this.ignoreNextEventForPath.add(data.path); 
            try { 
                const folder = data.path.substring(0, data.path.lastIndexOf('/')); 
                if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
                    await this.app.vault.createFolder(folder);
                }
                await this.app.vault.create(data.path, data.content); 
            } catch (e) { console.error("File creation error:", e); new Notice(`Failed to create file: ${data.path}`); } 
        } 
    }

    async applyFileDelete(data: FileDeletePayload) { 
        if (data.path.startsWith('.obsidian/')) { console.warn(`Ignoring sync delete attempt for protected path: ${data.path}`); return; }
        const existingFile = this.app.vault.getAbstractFileByPath(data.path); 
        if (existingFile) { 
            try {
                this.ignoreNextEventForPath.add(data.path); 
                await this.app.vault.delete(existingFile); 
            } catch (e) {
                console.error(`Error deleting file: ${data.path}`, e);
                new Notice(`Failed to delete file: ${data.path}`);
            }
        } 
    }
    
    async applyFileRename(data: FileRenamePayload) {
        if (data.oldPath.startsWith('.obsidian/') || data.newPath.startsWith('.obsidian/')) {
            console.warn(`Ignoring sync rename attempt for protected path: ${data.oldPath} -> ${data.newPath}`);
            return;
        }
        const fileToRename = this.app.vault.getAbstractFileByPath(data.oldPath);
        if (fileToRename instanceof TFile) {
            try {
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
        if (Platform.isMobile) {
            return null;
        }

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
}

class ConnectionModal extends Modal {
    private discoveredPeers: Map<string, PeerInfo> = new Map();
    
    constructor(app: App, private plugin: ObsidianDecentralizedPlugin) { super(app); }
    
    onOpen() { 
        this.injectStyles(); 
        this.showInitialOptions(); 
    }

    onClose() { 
        this.plugin.lanDiscovery?.stop();
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
        this.plugin.lanDiscovery?.stop();
        const { contentEl } = this;
        this.modalEl.addClass('obsidian-decentralized-connect-modal');
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Connect Devices' });
        
        new Setting(contentEl).setName("Companion Mode").setDesc("Set a permanent companion device for automatic connections.").addButton(btn => btn.setButtonText("Setup").setCta().onClick(() => this.showCompanionSetup()));
        new Setting(contentEl).setName("One-Time Connection").setDesc("Temporarily connect to any device.").addButton(btn => btn.setButtonText("Connect").onClick(() => this.showOneTimeConnection()));
    }

    showOneTimeConnection() {
        this.plugin.lanDiscovery?.stop();
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'One-Time Connection' });

        if (!Platform.isMobile) {
            new Setting(contentEl).setName("Invite via LAN (No Internet Needed)").setDesc("Broadcast an invitation on your local network. The other device must be on the same Wi-Fi.").addButton(btn => btn.setButtonText("Invite with PIN").onClick(() => this.showInviteLAN()));
        }
        new Setting(contentEl).setName("Invite via ID / QR Code").setDesc("The most secure method. Requires an internet or self-hosted server for the initial handshake.").addButton(btn => btn.setButtonText("Show ID").setCta().onClick(() => this.showMyId(() => this.showOneTimeConnection(), 'Invite with ID', 'On your other device, select "Join a Network" and paste the ID below.')));
        new Setting(contentEl).setName("Join a Network").setDesc("Enter an ID from another device, or discover devices on your LAN.").addButton(btn => btn.setButtonText("Join").onClick(() => this.showJoin()));
        new Setting(contentEl).addButton(btn => btn.setButtonText('Back').onClick(() => this.showInitialOptions()));
    }

    showInviteLAN() {
        if (!this.plugin.lanDiscovery) {
            new Notice("LAN Discovery is not available on mobile devices.");
            return;
        }

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
            
            this.plugin.lanDiscovery?.on('discover', (peerInfo: PeerInfo) => {
                noPeersEl.hide();
                if (peerInfo.deviceId === this.plugin.settings.deviceId) return;
                this.discoveredPeers.set(peerInfo.deviceId, peerInfo);
                this.renderDiscoveredPeers(discoveryListEl);
            });
            this.plugin.lanDiscovery?.on('lose', (peerInfo: PeerInfo) => {
                this.discoveredPeers.delete(peerInfo.deviceId);
                this.renderDiscoveredPeers(discoveryListEl);
                if (this.discoveredPeers.size === 0) { noPeersEl.show(); }
            });

            this.plugin.lanDiscovery?.startListening();
        }

        contentEl.createEl('h3', { text: 'Manual Connection' });
        let remoteId = '';
        new Setting(contentEl).setName("Peer ID").addText(text => text.setPlaceholder("Paste ID here...").onChange(value => remoteId = value));
        
        const buttonRow = new Setting(contentEl);
        buttonRow.addButton(btn => btn.setButtonText("Back").onClick(() => this.showOneTimeConnection()));
        buttonRow.addButton(btn => btn.setButtonText("Connect with ID").setCta().onClick(() => {
            if (!remoteId.trim()) { new Notice("Please enter a Peer ID."); return; }
            if (!this.plugin.peer || this.plugin.peer.disconnected) { new Notice("Peer connection is not active."); return; }

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
        this.plugin.lanDiscovery?.stop();
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
                if (!this.plugin.peer || this.plugin.peer.disconnected) { new Notice("Peer connection is not active."); return; }
                
                const conn = this.plugin.peer.connect(peer.deviceId);
                this.plugin.setupConnection(conn, pin);
                this.close();
            }));
    }
    
    showCompanionSetup() {
        this.plugin.lanDiscovery?.stop();
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
        buttonRow.addButton(btn => btn.setButtonText('Back').onClick(() => this.showInitialOptions()));
        buttonRow.addButton(btn => btn.setButtonText("Show My ID").onClick(() => this.showMyId(() => this.showCompanionSetup(), 'This Device\'s ID', 'On your other device, select "Companion Mode", and paste this ID.')));
        buttonRow.addButton(btn => btn.setButtonText("Pair").setCta().onClick(async () => {
            if (!remoteId.trim()) { new Notice("Please enter a Peer ID."); return; }
            
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
            }

            this.plugin.tryToConnectToCompanion();
            this.close();
        }));
    }
    
    showMyId(backCallback: () => void, title: string, text: string) {
        this.plugin.lanDiscovery?.stop();
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
            .setDesc('Open the connection helper to pair a companion or join a network.')
            .addButton(btn => btn.setButtonText("Connect").setCta().onClick(() => new ConnectionModal(this.app, this.plugin).open()));
        
        containerEl.createEl('h3', { text: 'Current Cluster' });
        const statusDiv = containerEl.createDiv();
        this.updateStatus(statusDiv);
        this.statusInterval = window.setInterval(() => this.updateStatus(statusDiv), 3000);
        this.plugin.registerInterval(this.statusInterval);

        containerEl.createEl('h2', { text: 'Advanced Settings' });

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
            new Setting(containerEl)
                .setName("Host")
                .addText(text => text.setValue(config.host).onChange(async (value) => {
                    config.host = value;
                    await this.plugin.saveSettings();
                }));
            new Setting(containerEl)
                .setName("Port")
                .addText(text => text.setValue(config.port.toString()).onChange(async (value) => {
                    config.port = parseInt(value, 10) || 9000;
                    await this.plugin.saveSettings();
                }));
            new Setting(containerEl)
                .setName("Path")
                .addText(text => text.setValue(config.path).onChange(async (value) => {
                    config.path = value;
                    await this.plugin.saveSettings();
                }));
            new Setting(containerEl)
                .setName("Secure (SSL)")
                .addToggle(toggle => toggle.setValue(config.secure).onChange(async (value) => {
                    config.secure = value;
                    await this.plugin.saveSettings();
                }));

            new Setting(containerEl)
                .addButton(btn => btn
                    .setButtonText("Apply and Reconnect")
                    .setWarning()
                    .onClick(() => {
                        new Notice("Reconnecting to new PeerJS server...");
                        this.plugin.reinitializePeer();
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
        
        const createEntry = (peer: PeerInfo, type: 'self' | 'companion' | 'peer') => {
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
            }
        };

        createEntry(this.plugin.getMyPeerInfo(), 'self');
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
