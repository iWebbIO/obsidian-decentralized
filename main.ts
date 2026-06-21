import { Notice, Plugin, TFile, TFolder, TAbstractFile, Platform, debounce, MarkdownView, setIcon } from 'obsidian';
import Peer, { DataConnection, PeerJSOption } from 'peerjs';
import DiffMatchPatch from 'diff-match-patch';

// UI imports
import { ConnectionModal, SelectPeerModal, ConflictCenter, SyncProgressModal, formatBytes } from './ui';

// Settings tab import
import { ObsidianDecentralizedSettingTab } from './settings-tab';

// LAN Discovery imports
import { DummyLANDiscovery, DesktopLANDiscovery } from './discovery';

// Direct IP imports
import { DirectIpServer, DirectIpClient } from './directip';

// Types & Constants imports
import {
    COMPANION_RECONNECT_INTERVAL_MS,
    TARGET_CHUNK_TIME_MS,
    MIN_CHUNK_SIZE,
    MAX_CHUNK_SIZE,
    MAX_BANDWIDTH_SAMPLES,
    MAX_QUEUE_DEPTH,
    LOCK_EXPIRATION_MS,
    MAX_HASH_CACHE_SIZE,
    REQUESTING_TIMEOUT,
    PLANNING_TIMEOUT,
    BATCH_TIMEOUT,
    COMPLETING_TIMEOUT,
    SyncPhase,
    SyncErrorCategory,
    SyncError,
    SyncState,
    PeerInfo,
    VaultManifest,
    DeviceRole,
    VersionVector,
    HandshakePayload,
    ClusterGossipPayload,
    CompanionPairPayload,
    FileUpdatePayload,
    FileDeltaPayload,
    FileDeletePayload,
    FileRenamePayload,
    FolderCreatePayload,
    FolderDeletePayload,
    FolderRenamePayload,
    FullSyncRequestPayload,
    SyncPlanPayload,
    RequestBatchPayload,
    BatchCompletePayload,
    RequestFilePayload,
    FileChunkStartPayload,
    FileChunkDataPayload,
    ClusterForgetPayload,
    ClusterKickPayload,
    ClusterRenamePayload,
    LockRequestPayload,
    LockGrantPayload,
    LockDenyPayload,
    LockReleasePayload,
    EditorActivatePayload,
    EditorDeltaPayload,
    MerkleRootPayload,
    MerkleNodeRequestPayload,
    MerkleNodeResponsePayload,
    MerkleNode,
    TransferStatus,
    FailedSync,
    SyncStatusState,
    SyncTask,
    BatchState,
    SyncData,
    DirectIpConfig,
    ObsidianDecentralizedSettings,
    TwoDeviceState,
    DEFAULT_SETTINGS,
    ILANDiscovery
} from './types';

// Utils imports
import {
    compressText,
    decompressText,
    arrayBufferToBase64,
    base64ToArrayBuffer
} from './utils';



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
    private processingQueue = false;
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
        if (this.clusterConnectionInterval) clearInterval(this.clusterConnectionInterval); // Fix: Clear cluster connection interval on unload
        this.activeTransfers.clear();
        this.connections.clear(); // Fix: Clear connections map references
        this.saveState(); // Fix: Force immediate save on unload instead of debounced delay
    }

    // --- Core Two-Device Infrastructure ---
    isTwoDeviceMode(): boolean {
        if (this.currentSyncIsTwoDeviceMode !== null) return this.currentSyncIsTwoDeviceMode;
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
            throw err; // Fix: Rethrow to prevent swallowing errors
        }).finally(() => {
            // Fix: Delete path from fileLocks map if it is the last lock in the chain to prevent memory leaks
            if (this.fileLocks.get(path) === newLock) {
                this.fileLocks.delete(path);
            }
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
        // Acquire locks in sorted order to prevent deadlock between concurrent renames (e.g. A→B and B→A)
        const [firstLock, secondLock] = [oldPath, file.path].sort();
        await this.runLocked(firstLock, async () => { 
            await this.runLocked(secondLock, async () => { 
                if (this.shouldIgnoreEvent(oldPath) || this.shouldIgnoreEvent(file.path)) return; 
                if (!this.isPathSyncable(file.path) && !this.isPathSyncable(oldPath)) return; 
                if (!this.hasPeers()) return; 
                this.log(`Processing rename: ${oldPath} -> ${file.path}`); 
                this.ignoreNextEventForPath(file.path); 
                this.ignoreNextEventForPath(oldPath); 
                
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
            // Await lock before sending edits to avoid racing with peer's active editing
            this.requestLock(path).then(granted => {
                if (granted) {
                    this.sendData(this.twoDevicePeerId!, { type: 'editor-active', path });
                }
            });
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

        const controlMessages = ['request-full-sync', 'sync-plan', 'request-batch', 'batch-complete', 'full-sync-complete'];
        if (controlMessages.includes(data.type)) return 500000;

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
        if (this.getConnectionMode() === 'direct-ip') {
            if (this.directIpClient) {
                return this.directIpClient.isOpen && peerId === 'direct-ip-host';
            }
            if (this.directIpServer) {
                return this.directIpServer.hasClient(peerId);
            }
            return false;
        }
        const conn = this.connections.get(peerId);
        if (!conn || !conn.open) return false;
        const lastSuccess = this.lastSuccessfulMessageTime.get(peerId);
        if (lastSuccess && (Date.now() - lastSuccess > 35000)) return false;
        return true;
    }

    public async sendSyncMessage(peerId: string, data: any, retryCount = 0, existingMessageId?: string): Promise<void> {
        if (!this.isConnectionHealthy(peerId)) {
            throw new SyncError(SyncErrorCategory.CONNECTION_ERROR, `Connection to ${peerId} is unhealthy.`, true, "Check network connection.");
        }
        // Reuse messageId on retries so the peer's ACK for any attempt resolves the original promise
        const messageId = existingMessageId || this.generateTransferId(data.type);
        const payload = { ...data, messageId };
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(async () => {
                this.pendingSyncAcks.delete(messageId);
                if (retryCount < 3) {
                    this.log(`Timeout sending ${data.type}, retrying (${retryCount + 1}/3)...`);
                    try {
                        await this.sendSyncMessage(peerId, data, retryCount + 1, messageId);
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
        this.peerFileSizes = {};
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
        if (this.processingQueue) return;
        this.processingQueue = true;
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
        this.processingQueue = false;
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
                        const MAX_SENT_CONTENT_CACHE = 200;
                        for (const [p, cacheData] of this.lastSentContent.entries()) {
                            if (now - cacheData.timestamp > 10 * 60 * 1000) this.lastSentContent.delete(p);
                        }
                        // Evict oldest entries if cache exceeds size limit
                        if (this.lastSentContent.size > MAX_SENT_CONTENT_CACHE) {
                            const sorted = Array.from(this.lastSentContent.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
                            const toEvict = sorted.slice(0, this.lastSentContent.size - MAX_SENT_CONTENT_CACHE);
                            for (const [p] of toEvict) this.lastSentContent.delete(p);
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
                            if (typeof content === 'string') {
                                const encoded = new TextEncoder().encode(content);
                                if (encoded.byteLength > this.getChunkSize()) {
                                    content = encoded.buffer;
                                    encoding = 'binary';
                                }
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
            // Fix: Clear and resolve pending timeouts in pendingAcks to prevent memory leaks and unhandled promise rejections
            if (transferId && this.pendingAcks.has(transferId)) {
                const ack = this.pendingAcks.get(transferId);
                ack?.resolve();
                this.pendingAcks.delete(transferId);
            }

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
                this.log(`Retrying transfer ${transferId} (Attempt ${item.retries + 1}/3) with backoff`);
                item.retries++;
                const priority = item.priority;
                
                // Fix: Push back to the queue asynchronously after a 5-second backoff delay
                setTimeout(() => {
                    let low = 0, high = this.syncQueue.length;
                    while (low < high) {
                        const mid = (low + high) >>> 1;
                        if (this.syncQueue[mid].priority < priority) high = mid;
                        else low = mid + 1;
                    }
                    this.syncQueue.splice(low, 0, item);
                    this.processQueue();
                }, 5000);
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
        if (this.clusterConnectionInterval) { clearInterval(this.clusterConnectionInterval); this.clusterConnectionInterval = null; }
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
            // Role announcement is deferred to handleHandshake (after conn is in this.connections)
            // to avoid isTwoDeviceMode() seeing wrong connections.size
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

            // Fix: Abort sync immediately if the connection to the syncing peer closes mid-sync
            if (this.syncState.isSyncing && this.syncState.peerId === peerId) {
                this.abortSync(new SyncError(SyncErrorCategory.CONNECTION_ERROR, "Connection closed mid-sync.", false, "Check peer connection."));
            }

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
        
        if (this.getConnectionMode() === 'direct-ip') {
            if (!data.isResponse) {
                this.sendData(conn.peer, { type: 'handshake', peerInfo: this.getMyPeerInfo(), pin: data.pin, isResponse: true } as any);
            }
        } else {
            this.sendData(conn.peer, { type: 'cluster-gossip', peers: existingPeers });
            this.broadcastData({ type: 'cluster-gossip', peers: [this.getMyPeerInfo(), data.peerInfo] });
        }
        
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
            // Fix: Do not register this dynamically recreated interval to avoid leaking in Obsidian core's internal list.
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
                    for (let i = 0; i < diff.length; i++) {
                        const [op, text] = diff[i];
                        if (op === 0) {
                            offset += text.length;
                        } else if (op === -1) {
                            const nextDiff = diff[i + 1];
                            if (nextDiff && nextDiff[0] === 1) {
                                changes.push({ from: offset, to: offset + text.length, insert: nextDiff[1] });
                                offset += text.length;
                                i++; // skip insert
                            } else {
                                changes.push({ from: offset, to: offset + text.length });
                                offset += text.length;
                            }
                        } else if (op === 1) {
                            changes.push({ from: offset, insert: text });
                        }
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
        // Fix: Validate chunk size does not exceed MAX_CHUNK_SIZE to prevent OOM / heap memory allocation exploits
        if (payload.data.byteLength > MAX_CHUNK_SIZE) {
            this.log(`Received chunk exceeding MAX_CHUNK_SIZE (${payload.data.byteLength} bytes). Aborting transfer.`);
            this.pendingFileChunks.delete(payload.transferId);
            this.activeTransfers.delete(payload.transferId);
            return;
        }
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
                    this.sendData(conn.peer, { type: 'nack', transferId: payload.transferId, reason: 'integrity-failure' });
                    return;
                }

                await this.applyFileUpdate({ type: 'file-update', path: transfer.path, content: reassembled.buffer, mtime: transfer.mtime, encoding: 'binary', transferId: payload.transferId, compressed: transfer.compressed, versionVector: transfer.versionVector });
                this.sendData(conn.peer, { type: 'ack', transferId: payload.transferId }); this.log(`Reassembly complete for ${transfer.path}, sent ack.`);
            } catch (e) {
                this.log(`Failed to apply chunked file update: ${transfer.path}`, e);
                if (e instanceof Error && e.message.includes('IntegrityError')) {
                    this.sendData(conn.peer, { type: 'nack', transferId: payload.transferId, reason: 'integrity-failure' });
                } else {
                    this.sendData(conn.peer, { type: 'nack', transferId: payload.transferId, reason: 'write-error' });
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
                // Clean up any associated pending ACK to prevent unhandled rejections
                if (this.pendingAcks.has(id)) {
                    this.pendingAcks.get(id)!.resolve();
                    this.pendingAcks.delete(id);
                }
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
            } else if (data.mtime <= existingFile.stat.mtime + this.settings.mtimeTolerance &&
                       data.mtime >= existingFile.stat.mtime - this.settings.mtimeTolerance) {
                // Within mtime tolerance — fall through to baseHash check below instead of
                // silently dropping the delta. If baseHash matches, the delta is valid and
                // should be applied; if not, IntegrityError is thrown and triggers full resend.
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
                this.debouncedSaveState();
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
                    this.debouncedSaveState();
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
                    this.debouncedSaveState();
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
                    this.debouncedSaveState();
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
                    
                    // Debounce re-send to prevent tight conflict resolution loops:
                    // if we just resolved this path, skip the immediate re-send.
                    // The file will be sent on next edit or full sync.
                    const lastResolved = this.ignoreEvents.get(`conflict:${data.path}`);
                    if (!lastResolved || Date.now() > lastResolved) {
                        this.ignoreEvents.set(`conflict:${data.path}`, Date.now() + 5000);
                        if (this.twoDevicePeerId) {
                            this.sendFileUpdate(existingFile, this.twoDevicePeerId, true);
                        }
                    } else {
                        this.log(`Skipping re-send for ${data.path} — conflict cooldown active`);
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

    async applyFileDelete(data: FileDeletePayload) {
        if (!this.isPathSyncable(data.path)) return;
        await this.runLocked(data.path, async () => {
            if (this.isTwoDeviceMode() && data.versionVector) {
                const localVV = this.twoDeviceState.fileVersions[data.path] || {};
                const remoteVV = data.versionVector;
                const isRemoteNewer = this.isNewerThan(remoteVV, localVV);

                if (!isRemoteNewer) {
                    // Local edit wins (local is strictly newer, or there's a concurrent conflict).
                    // We merge the remote vector, increment local version, and push the local file back to the peer.
                    this.log(`Edit-vs-delete conflict: local edit wins for ${data.path}`);
                    const merged = this.mergeVersions(localVV, remoteVV);
                    merged[this.settings.deviceId] = (merged[this.settings.deviceId] || 0) + 1;
                    this.twoDeviceState.fileVersions[data.path] = merged;
                    this.debouncedSaveState();

                    const file = this.app.vault.getAbstractFileByPath(data.path);
                    if (file instanceof TFile && this.twoDevicePeerId) {
                        this.sendFileUpdate(file, this.twoDevicePeerId, true);
                    }
                    return;
                } else {
                    // Remote delete dominates. Update version vector to reflect the deletion.
                    this.twoDeviceState.fileVersions[data.path] = remoteVV;
                    this.debouncedSaveState();
                }
            }

            this.tombstones[data.path] = Date.now();
            this.debouncedSaveState();
            this.syncedHashes.delete(data.path);
            const existingFile = this.app.vault.getAbstractFileByPath(data.path);
            if (existingFile) {
                try {
                    this.log(`Deleting file: ${data.path}`);
                    this.ignoreNextEventForPath(data.path);
                    await this.app.vault.delete(existingFile);
                } catch (e) {
                    console.error(`Error deleting file: ${data.path}`, e);
                    this.showNotice(`Failed to delete file: ${data.path}`, 'error');
                }
            }
        });
    }

    async applyFileRename(data: FileRenamePayload) { 
        if (!this.isPathSyncable(data.oldPath) && !this.isPathSyncable(data.newPath)) return; 
        const [firstLock, secondLock] = [data.oldPath, data.newPath].sort();
        await this.runLocked(firstLock, async () => {
            await this.runLocked(secondLock, async () => {
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
            });
        });
    }

    async applyFolderCreate(data: FolderCreatePayload) { 
        if (!this.isPathSyncable(data.path)) return; 
        await this.runLocked(data.path, async () => {
            if (this.app.vault.getAbstractFileByPath(data.path)) return; 
            this.log(`Creating folder: ${data.path}`); 
            this.ignoreNextEventForPath(data.path); 
            try { 
                await this.app.vault.createFolder(data.path); 
            } catch (e) { 
                console.error(`Failed to create folder ${data.path}`, e); 
            } 
        });
    }

    async applyFolderDelete(data: FolderDeletePayload) { 
        if (!this.isPathSyncable(data.path)) return; 
        await this.runLocked(data.path, async () => {
            const folder = this.app.vault.getAbstractFileByPath(data.path); 
            if (folder instanceof TFolder) { 
                this.log(`Deleting folder: ${data.path}`); 
                this.ignoreNextEventForPath(data.path, 5000); 
                try { 
                    await this.app.vault.delete(folder, true); 
                } catch (e) { 
                    console.error(`Failed to delete folder ${data.path}`, e); 
                } 
            } 
        });
    }

    async applyFolderRename(data: FolderRenamePayload) { 
        if (!this.isPathSyncable(data.oldPath) && !this.isPathSyncable(data.newPath)) return; 
        const [firstLock, secondLock] = [data.oldPath, data.newPath].sort();
        await this.runLocked(firstLock, async () => {
            await this.runLocked(secondLock, async () => {
                const folder = this.app.vault.getAbstractFileByPath(data.oldPath); 
                if (folder instanceof TFolder) { 
                    this.log(`Renaming folder: ${data.oldPath} -> ${data.newPath}`); 
                    this.ignoreNextEventForPath(data.oldPath); 
                    this.ignoreNextEventForPath(data.newPath); 
                    try { 
                        await this.app.vault.rename(folder, data.newPath); 
                    } catch (e) { 
                        console.error(`Failed to rename folder ${data.oldPath}`, e); 
                    } 
                } 
            });
        });
    }

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
        if (this.syncState.isSyncing) { 
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
                        // Tombstone mtime = deletion time; file mtime = last modification time.
                        // Comparing directly is intentional: if the file was modified AFTER it
                        // was deleted on the other side, the newer modification takes precedence.
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
            }
            
            await this.sendSyncMessage(conn.peer, { type: 'sync-plan', filesReceiverWillSend, filesInitiatorMustSend, filesReceiverMustDelete, filesInitiatorMustDelete, fileSizes }); ; 
            
            for (const path of filesReceiverMustDelete) {
                await this.runLocked(path, async () => {
                    const file = this.app.vault.getAbstractFileByPath(path);
                    if (file) {
                        try {
                            this.ignoreNextEventForPath(path);
                            await this.app.vault.delete(file);
                            this.syncedHashes.delete(path);
                            if (this.isTwoDeviceMode()) {
                                this.incrementVersion(path);
                            }
                            this.tombstones[path] = Date.now();
                            this.debouncedSaveState();
                        } catch (e) {
                            this.log(`Failed to delete file ${path}:`, e);
                        }
                    }
                });
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
        if (this.syncState.currentPhase !== SyncPhase.PLANNING && this.syncState.currentPhase !== SyncPhase.REQUESTING) {
            this.log(`Received sync plan but current phase is ${this.syncState.currentPhase}. Ignoring.`);
            return;
        }
        this.transitionToPhase(SyncPhase.PLANNING);
        this.resetIdleTimeout();
        try {
            if (!data.filesReceiverWillSend || !data.filesInitiatorMustSend) throw new SyncError(SyncErrorCategory.PROTOCOL_ERROR, "Invalid sync plan received.", false, "Update plugin.");
            
            this.showNotice("Received sync plan. Exchanging files...", 'verbose'); 
            this.log(`Sync plan: I must pull ${data.filesReceiverWillSend.length}, They pull ${data.filesInitiatorMustSend.length}`); 
            this.syncState.filesTotal = data.filesReceiverWillSend.length + data.filesInitiatorMustSend.length;
            
            for (const path of data.filesInitiatorMustDelete || []) {
                await this.runLocked(path, async () => {
                    const file = this.app.vault.getAbstractFileByPath(path);
                    if (file) {
                        try {
                            this.ignoreNextEventForPath(path);
                            await this.app.vault.delete(file);
                            this.syncedHashes.delete(path);
                            if (this.isTwoDeviceMode()) {
                                this.incrementVersion(path);
                            }
                            this.tombstones[path] = Date.now();
                            this.debouncedSaveState();
                        } catch (e) {
                            this.log(`Failed to delete file ${path}:`, e);
                        }
                    }
                });
            }
            
            for (const [path, size] of Object.entries(data.fileSizes)) {
                this.peerFileSizes[path] = size;
                if (data.filesReceiverWillSend.includes(path)) this.syncState.bytesTotal += size;
            }
            
            this.syncState.allowedPulls = new Set(data.filesInitiatorMustSend);
            this.syncState.pendingPulls = new Set(data.filesReceiverWillSend);
            
            this.requestNextBatch(conn.peer);
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
                    } else if (file instanceof TFolder) {
                        this.addToQueueTask(conn.peer, { taskType: 'send-folder-create', path, batchId });
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
        const activeBatches = this.syncState.activeBatches;
        
        // Only declare complete when no pulls are pending, no pulls are allowed, AND
        // no batches are still in-flight (being sent by the peer).
        if ((!pending || pending.size === 0) && (!allowed || allowed.size === 0) && (!activeBatches || activeBatches.size === 0)) {
            if (this.syncState.currentPhase !== SyncPhase.COMPLETING) {
                this.transitionToPhase(SyncPhase.COMPLETING);
            }
            if (!this.localSyncComplete.get(peerId)) {
                this.localSyncComplete.set(peerId, true);
                this.sendSyncMessage(peerId, { type: 'full-sync-complete' }).catch(e => this.abortSync(e));
            }       
        }
        
        if (this.localSyncComplete.get(peerId) && this.peerSyncComplete.get(peerId) && (!activeBatches || activeBatches.size === 0)) {
            this.transitionToPhase(SyncPhase.COMPLETING);
            this.handleFullSyncComplete();
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
    public async connectToDirectIpHost(config: DirectIpConfig) {
        this.reinitializeConnectionManager();
        this.directIpClient = new DirectIpClient(this, config);
        this.clusterPeers.set('direct-ip-host', { deviceId: 'direct-ip-host', friendlyName: `Host (${config.host})`, ip: config.host });
        
        const mockConn = {
            send: (data: any) => this.directIpClient?.send(data),
            peer: 'direct-ip-host',
            open: true
        } as any;
        this.connections.set('direct-ip-host', mockConn);
        this.updateStatus();

        // Initiate handshake
        await this.directIpClient.send({ type: 'handshake', peerInfo: this.getMyPeerInfo(), pin: config.pin });
    }
    
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


