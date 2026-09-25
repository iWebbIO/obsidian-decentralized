import { Notice, Plugin, TFile, TFolder, TAbstractFile, Platform, debounce, Debouncer, MarkdownView, setIcon } from 'obsidian';
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
import { ConfigSync, ConfigScope } from './core/ConfigSync';
import { compareVectors, mergeVectors, newerVersion, pickVersion, hasOwnUnseenEdit, sanitizeVersionVector, VersionInfo } from './utils/versions';

// Types & Constants imports
import {
    COMPANION_RECONNECT_INTERVAL_MS,
    TARGET_CHUNK_TIME_MS,
    MIN_CHUNK_SIZE,
    MAX_CHUNK_SIZE,
    MAX_BANDWIDTH_SAMPLES,
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
    FileManifestEntry,
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
    SETTINGS_VERSION,
    ILANDiscovery,
    FileBatchBinaryPayload
} from './types';

// Utils imports
import {
    compressText,
    decompressText,
    arrayBufferToBase64,
    base64ToArrayBuffer,
    packFilesToTLV,
    unpackTLVToFiles,
    PackedFile,
    mapWithConcurrency,
    PROTOCOL_VERSION,
    splitBinaryPayload,
    joinBinaryPayload,
    packFrame,
    unpackFrame,
    sanitizeVaultPath,
    taskQueueId,
    toExactArrayBuffer,
    parseFolderList,
    isWithinFolders,
    hasHiddenSegment
} from './utils';

import { TimeoutManager } from './utils/Timeouts';
import { persistablePeerInfo, sanitizePeerInfo } from './utils/pairing';
import { isGenericDeviceName, suggestedDeviceName } from './utils/device-name';
import { collectLocalIpv4, preferLocalIpv4, type LocalIpv4 } from './utils/net';
import { peerErrorUserMessage, shouldTearDownPeer } from './utils/peer-error';
import { QueueManager } from './core/QueueManager';
import { ConnectionManager } from './core/ConnectionManager';

/** Extensions treated as text (everything else is binary). */
const TEXT_EXTENSIONS = new Set(['md', 'txt', 'json', 'css', 'js', 'html', 'xml', 'csv', 'yaml', 'toml']);

/** Extensions still synced when 'syncAllFileTypes' is off. */
const TEXT_WHITELIST = new Set(['md', 'css', 'js', 'json']);

/**
 * Single shared diff-match-patch instance. It holds no per-call state across the
 * operations used here, and it was previously constructed fresh at four call sites,
 * including the per-file delta path.
 */
const dmp = new DiffMatchPatch();

export default class ObsidianDecentralizedPlugin extends Plugin {
    settings: ObsidianDecentralizedSettings;
    peer: Peer | null = null;
    connections: Map<string, DataConnection> = new Map();
    clusterPeers: Map<string, PeerInfo> = new Map();
    lanDiscovery: ILANDiscovery;
    private fileLocks: Map<string, Promise<void>> = new Map();

    // Architectural Managers
    public timeoutManager: TimeoutManager;
    public queueManager: QueueManager;
    public connectionManager: ConnectionManager;


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
        bytesTransferred: 0,
        syncStartTime: 0,
        currentFile: null,
        currentFileSize: null,
        inFlightPulls: new Set(),
        activePullBatches: new Set(),
        adaptiveConfig: {
            maxActiveBatches: 1,
            filesPerBatch: 50,
            maxBytesPerBatch: 50 * 1024 * 1024
        },
        batchStartTimes: new Map()
    };
    private pendingSyncAcks: Map<string, { resolve: () => void, reject: (e: Error) => void }> = new Map();
    private lastSuccessfulMessageTime: Map<string, number> = new Map();
    // Receiver-side dedup of retried sync control messages (insertion-ordered, capped)
    private processedMessageIds: Set<string> = new Set();

    private ignoreEvents: Map<string, number> = new Map();
    private statusBar: HTMLElement;
    // Persistent status-bar elements plus the last rendered state, so updateStatus can
    // diff instead of rebuilding the DOM on every call.
    private statusIconEl: HTMLElement | null = null;
    private statusTextEl: HTMLElement | null = null;
    private lastRenderedStatus: SyncStatusState | null = null;
    private conflictCenter: ConflictCenter;
    public activeTransfers: Map<string, TransferStatus> = new Map();
    /**
     * When the current pairing key stops being accepted for auto-enrolment. Without a
     * deadline the window stayed open for the whole session, so anyone who had seen the QR
     * code could pair at any later point.
     */
    public activePskExpiresAt: number = 0;
    /** How long a displayed pairing code stays valid for auto-enrolment. */
    public static readonly PAIRING_WINDOW_MS = 10 * 60 * 1000;

    /** The pairing key, but only while the pairing window is still open. */
    public getActivePsk(): string | null {
        if (!this.activePsk || Date.now() >= this.activePskExpiresAt) return null;
        return this.activePsk;
    }

    /** Opens (or re-opens) the pairing window, generating a key if there isn't one yet. */
    public async beginPairingWindow(): Promise<string> {
        if (!this.activePsk) this.activePsk = await this.generatePSK();
        this.activePskExpiresAt = Date.now() + ObsidianDecentralizedPlugin.PAIRING_WINDOW_MS;
        if (this.pairingWindowTimer) window.clearTimeout(this.pairingWindowTimer);
        // Re-announce so nearby devices pick up the key, then strip it when the window ends.
        this.refreshLanBeacon();
        this.pairingWindowTimer = window.setTimeout(() => {
            this.pairingWindowTimer = null;
            this.refreshLanBeacon();
        }, ObsidianDecentralizedPlugin.PAIRING_WINDOW_MS);
        return this.activePsk;
    }
    public activePsk: string | null = null;
    private pairingWindowTimer: number | null = null;

    private refreshLanBeacon() {
        if (Platform.isMobile || this.unloaded) return;
        this.lanDiscovery?.startBroadcasting(this.getMyPeerInfo());
    }
    /**
     * Set first thing in onunload. Several callbacks outlive the plugin (PeerJS and
     * DataConnection events fired by destroy(), in-flight promises, the pairing-window timer)
     * and each of them used to be able to restart networking on a disabled instance.
     */
    private unloaded = false;
    /** Fires if the current Peer never reaches the signalling server. */
    private peerOpenTimeout: number | null = null;
    private clusterConnectionInterval: number | null = null;
    public pendingConnections: Set<string> = new Set();
    private pendingFileChunks: Map<string, {
        path: string,
        mtime: number,
        /** Preallocated destination; chunks are written to their final offsets on arrival. */
        buffer: Uint8Array,
        /** received[i] = 1 once chunk i has been written, so duplicates are not double-counted. */
        received: Uint8Array,
        totalBytes: number,
        chunkSize: number,
        total: number,
        receivedCount: number,
        lastUpdated: number,
        fileHash: string,
        compressed?: boolean,
        versionVector?: VersionVector
    }> = new Map();
    
    // Timeouts and Keep-alives
    private syncIdleTimeout: number | null = null;
    private syncKeepAliveInterval: number | null = null;
    private pendingAcks: Map<string, { resolve: () => void, reject: (e: Error) => void, peerId: string }> = new Map();
    private lastStatusUpdate: number = 0;
    /** A throttled status refresh still owed (see updateStatus). */
    private statusTimer: number | null = null;
    private currentConcurrency = 16;
    private currentChunkSize = 512 * 1024;
    private targetChunkSize = 512 * 1024;
    private successfulTransfersSinceLastIncrease = 0;
    private peerInitRetryTimeout: number | null = null;
    private peerInitAttempts = 0;
    /** path -> pending debounce timer handle for that path's change event. */
    private pendingFileChanges: Map<string, number> = new Map();
    public directIpServer: DirectIpServer | null = null;
    public directIpClient: DirectIpClient | null = null;
    private lastHeard: Map<string, number> = new Map();

    // Network-change handling (Phase 3.2)
    private networkChangeHandler: (() => void) | null = null;
    private peerReconnectFallbackTimeout: number | null = null;
    // Last time each distinct notice text was shown, so a flapping network cannot
    // stack the same toast over and over.
    private recentNotices: Map<string, number> = new Map();
    private statePath: string;
    private hashCachePath: string;
    public manualPingStart: Map<string, number> = new Map();
    private debouncedSaveState: Debouncer<[], void>;
    private debouncedSaveHashCache: Debouncer<[], void>;
    private debouncedSaveQueue: Debouncer<[], void>;
    // Dirty flags: without them the debounced savers rewrote identical files on every
    // tick, since most call sites fire whether or not anything actually changed.
    private stateDirty: boolean = false;
    private hashCacheDirty: boolean = false;
    private queueDirty: boolean = false;
    private lastStateSaveAt: number = 0;
    private lastQueueSaveAt: number = 0;
    public failedSyncs: FailedSync[] = [];
    /**
     * Content-hash cache: path -> SHA-256 of the file's bytes, with the size and mtime it was
     * computed for. Manifests and the Merkle tree read it, so an entry is only trusted while
     * the file still has that size and mtime (see cachedHashFor).
     */
    private syncedHashes: Map<string, { hash: string, timestamp: number, mtime?: number, size?: number }> = new Map();
    /**
     * One-shot record of content we just wrote because a peer sent it. If the resulting
     * vault event slips past the ignore window, the send it triggers finds its own hash here
     * and is dropped as an echo. Kept apart from the content cache: a Merkle build fills that
     * cache with the CURRENT content, which made a queued genuine edit look like an echo.
     */
    private remoteEchoHashes: Map<string, { hash: string, at: number }> = new Map();

    // Bandwidth measurement & delta sync states
    private recentTransferSamples: { bytes: number, durationMs: number }[] = [];
    private currentBandwidthEstimate: number = 0;
    private lastSentContent: Map<string, { content: string, timestamp: number }> = new Map();

    // Two-Device Mode State
    public twoDeviceState: TwoDeviceState = { fileVersions: {}, merkleTreeRoot: null };
    public configSync!: ConfigSync;
    public tombstones: Record<string, number> = {};
    public currentSyncIsTwoDeviceMode: boolean | null = null;
    /** 0 means the cached Merkle tree is stale and must be rebuilt. */
    private merkleTreeBuiltAt: number = 0;
    /** Bumped by every vault change; a tree built across a change is not cached as current. */
    private merkleGeneration = 0;
    
    // Pull-based Sync State
    private pullRetries: Map<string, number> = new Map();
    // Smallest-first pull order for the active sync plan, consumed via a cursor.
    private pullOrder: string[] = [];
    private pullCursor: number = 0;
    /** Folders confirmed to exist, so batch writes stop re-walking every path segment. */
    private knownFolders: Set<string> = new Set();
    private peerFileSizes: Record<string, number> = {};
    private localSyncComplete: Map<string, boolean> = new Map();
    private peerSyncComplete: Map<string, boolean> = new Map();
    // Cached parsed folder filters — invalidated on settings change to avoid re-parsing on every vault event
    private _cachedExcludedFolders: string[] | null = null;
    private _cachedIncludedFolders: string[] | null = null;
    
    // File Locking State
    public heldLocks: Map<string, { peerId: string, expiresAt: number }> = new Map();
    public remoteLocks: Map<string, { peerId: string, expiresAt: number }> = new Map();
    private pendingLockRequests: Map<string, { resolve: (granted: boolean) => void, timeout: number }> = new Map();
    
    // Real-time Editor Sync State
    public activeEditorLocks: Map<string, string> = new Map();
    private isApplyingRemoteEdit: boolean = false;
    private debouncedEditorChange: Debouncer<[any, TFile], Promise<void>>;

    async onload() {
        // Initialize Core Managers
        this.timeoutManager = new TimeoutManager();
        this.connectionManager = new ConnectionManager(this.timeoutManager);
        this.queueManager = new QueueManager(this.timeoutManager, async (item) => {
            // processQueueItem never throws — it catches everything so its `finally` can
            // release acks and record batch completion — so it reports a retryable failure
            // by setting item.retryable instead.
            item.retryable = false;
            try {
                await this.processQueueItem(item);
                return !item.retryable;
            } catch (e) {
                console.error("Unexpected error processing queue item", e);
                return false;
            }
        });

        if (Platform.isMobile) {
            this.lanDiscovery = new DummyLANDiscovery();
        } else {
            this.lanDiscovery = new DesktopLANDiscovery();
        }

        this.statePath = `${this.manifest.dir}/state.json`;
        this.hashCachePath = `${this.manifest.dir}/hash-cache.json`;
        this.debouncedSaveState = debounce(() => { void this.saveState(); }, 1000);
        // The hash cache is rebuildable, so it tolerates a lazy cadence; it is also
        // flushed on unload.
        this.debouncedSaveHashCache = debounce(() => { void this.saveHashCache(); }, 30000);
        this.debouncedSaveQueue = debounce(() => { void this.saveQueueState(); }, 2000);
        this.debouncedEditorChange = debounce(this.handleEditorChangeDebounced.bind(this), 200);

        await this.loadSettings();
        this.applyHideNativeSync();
        this.statusBar = this.addStatusBarItem();
        this.addSettingTab(new ObsidianDecentralizedSettingTab(this.app, this));
        this.conflictCenter = new ConflictCenter(this.app, this);
        this.conflictCenter.registerRibbon();
        this.app.workspace.onLayoutReady(() => this.conflictCenter.scanVault());
        this.addRibbonIcon('users', 'Connect devices', () => new ConnectionModal(this.app, this).open());
        this.addRibbonIcon('refresh-cw', 'Force full sync', () => {
            if (this.connections.size === 0) {
                new ConnectionModal(this.app, this).open();
                return;
            }
            new SelectPeerModal(this.app, this, (peerId: string) => this.requestFullSyncFromPeer(peerId)).open();
        });

        // Mirror the ribbon actions as commands. Without these nothing the plugin does can be
        // reached from the command palette or bound to a hotkey.
        this.addCommand({
            id: 'open-connect-modal',
            name: 'Connect to a device',
            callback: () => new ConnectionModal(this.app, this).open(),
        });
        this.addCommand({
            id: 'force-full-sync',
            name: 'Force full sync with a device',
            callback: () => {
                if (this.connections.size === 0) {
                    new ConnectionModal(this.app, this).open();
                    return;
                }
                new SelectPeerModal(this.app, this, (peerId: string) => this.requestFullSyncFromPeer(peerId)).open();
            },
        });
        this.addCommand({
            id: 'show-sync-progress',
            name: 'Show sync progress',
            callback: () => new SyncProgressModal(this.app, this).open(),
        });
        this.addCommand({
            id: 'resolve-conflicts',
            name: 'Resolve sync conflicts',
            callback: () => this.conflictCenter.showConflictList(),
        });

        // Any vault mutation — local or applied from a peer — makes the cached Merkle
        // tree stale.
        const onVaultEvent = (file: TAbstractFile, kind?: 'modify') => {
            this.invalidateMerkleTree();
            this.handleEvent(file, kind);
        };
        // Obsidian reports every existing file as "created" while it loads the vault. Heard
        // here, each startup counted every file as edited on this device — and an edit that
        // never happened wins conflicts it should lose. Listen once loading is done.
        this.app.workspace.onLayoutReady(() => {
            if (this.unloaded) return;
            this.registerEvent(this.app.vault.on('create', onVaultEvent));
            this.registerEvent(this.app.vault.on('modify', (file) => onVaultEvent(file, 'modify')));
            this.registerEvent(this.app.vault.on('delete', (file) => {
                // A removed path can no longer be assumed to exist.
                this.forgetKnownFolders(file.path);
                onVaultEvent(file);
            }));
            this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
                this.invalidateMerkleTree();
                this.forgetKnownFolders(oldPath);
                this.handleRenameEvent(file, oldPath);
            }));
        });
        this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => this.handleEditorChange(editor, info)));

        this.configSync = new ConfigSync({
            adapter: this.app.vault.adapter as any,
            configDir: () => this.app.vault.configDir || '.obsidian',
            ownPluginFolder: () => {
                const configDir = this.app.vault.configDir || '.obsidian';
                const dir = this.manifest.dir || `${configDir}/plugins/${this.manifest.id}`;
                return dir.startsWith(configDir + '/') ? dir.slice(configDir.length + 1) : `plugins/${this.manifest.id}`;
            },
            scope: () => this.configScope(),
            deviceId: () => this.settings.deviceId,
            peerDeviceId: (peer) => this.realDeviceId(peer) ?? peer,
            peerName: (peer) => this.clusterPeers.get(peer)?.friendlyName || 'another device',
            // Offline Mode authenticates both ends with the join token; over the internet only
            // a device sharing a pairing key qualifies.
            trustedForCode: (peer) => this.getConnectionMode() === 'direct-ip' || !!this.peerKeyFor(peer),
            connectedPeers: () => Array.from(this.connections.entries()).filter(([, c]) => c.open).map(([id]) => id),
            send: (peer, message) => this.sendData(peer, message),
            hash: (data) => this.getHash(data),
            notify: (message) => this.showNotice(message, 'important', 15000),
            log: (...args) => this.log(...args),
            stateChanged: () => this.scheduleStateSave(),
        });
        this.registerEvent(this.app.workspace.on('css-change', () => { void this.configSync.scan(); }));
        this.registerInterval(window.setInterval(() => { void this.configSync.scan(); }, Platform.isMobile ? 60000 : 30000));

        // Durable state (version vectors, tombstones, queued work) before any device connects.
        await this.loadState();
        this.pruneTombstones();

        this.initializeConnectionManager();
        this.startHeartbeat();
        this.registerInterval(window.setInterval(() => this.cleanupPendingChunks(), 60000));
        this.registerInterval(window.setInterval(() => this.retryFailedSyncs(), 60000));
        this.registerInterval(window.setInterval(() => this.cleanupLocks(), 5000));

        // Centralized network-change listeners (Phase 3.2)
        this.networkChangeHandler = () => this.handleNetworkChange();
        window.addEventListener('online',  this.networkChangeHandler);
        window.addEventListener('offline', this.networkChangeHandler);
        this.lanDiscovery.on('network-change', this.networkChangeHandler);
    }

    onunload() {
        this.unloaded = true;

        // Remove centralized network-change listeners
        if (this.networkChangeHandler) {
            window.removeEventListener('online',  this.networkChangeHandler);
            window.removeEventListener('offline', this.networkChangeHandler);
            this.lanDiscovery.off('network-change', this.networkChangeHandler);
            this.networkChangeHandler = null;
        }

        // Plain window timers, not registerInterval/timeoutManager ones, so nothing clears
        // them for us. Left running, a disabled instance keeps calling initializePeer() and
        // races the next load for the same PeerJS id.
        if (this.peerInitRetryTimeout) { clearTimeout(this.peerInitRetryTimeout); this.peerInitRetryTimeout = null; }
        if (this.clusterConnectionInterval) { clearInterval(this.clusterConnectionInterval); this.clusterConnectionInterval = null; }
        // Re-broadcast the LAN beacon when the pairing window closes — which, on an unloaded
        // plugin, meant reopening a UDP socket that nothing would ever close again.
        if (this.pairingWindowTimer !== null) { window.clearTimeout(this.pairingWindowTimer); this.pairingWindowTimer = null; }

        // Stop a running sync quietly: its phase, idle and keep-alive timers would otherwise
        // fire into the disabled plugin and pop "Sync stopped" after the user turned it off.
        this.abortSync(undefined, { silent: true });
        this.rejectAllPendingAcks('Plugin unloaded');
        for (const request of this.pendingLockRequests.values()) {
            window.clearTimeout(request.timeout);
            request.resolve(false);
        }
        this.pendingLockRequests.clear();

        this.destroyPeer();
        this.lanDiscovery.stop();
        this.directIpServer?.stop();
        this.directIpClient?.stop();
        this.connections.clear();

        // An upload cut off here stays as a paused record so the next session re-sends the
        // file; a partial download is useless without its sender.
        for (const [id, transfer] of this.activeTransfers) {
            if (transfer.direction === 'upload') transfer.status = 'paused';
            else this.activeTransfers.delete(id);
        }

        // Save now instead of waiting out the debounce windows, and BEFORE the queue is
        // disposed: this used to clear the queue first and then persist the empty result, so
        // every change still waiting to go out was lost on each disable or restart.
        this.debouncedSaveState.cancel();
        this.debouncedSaveHashCache.cancel();
        this.debouncedSaveQueue.cancel();
        this.debouncedEditorChange.cancel();
        this.configSync?.dispose();
        this.clearStatusTimer();
        void this.saveState(true);
        void this.saveHashCache(true);
        void this.saveQueueState(true);

        this.queueManager.dispose();
        this.timeoutManager.dispose();
        document.body.classList.remove('od-hide-native-sync');
    }

    /** Fail every transfer and sync-message waiter, clearing their timers. */
    private rejectAllPendingAcks(reason: string) {
        const acks = Array.from(this.pendingAcks.values());
        this.pendingAcks.clear();
        for (const ack of acks) ack.reject(new Error(reason));
        const syncAcks = Array.from(this.pendingSyncAcks.values());
        this.pendingSyncAcks.clear();
        for (const ack of syncAcks) ack.reject(new Error(reason));
    }

    // --- Core Two-Device Infrastructure ---
    isTwoDeviceMode(): boolean {
        if (this.currentSyncIsTwoDeviceMode !== null) return this.currentSyncIsTwoDeviceMode;
        return this.settings.enableTwoDeviceOptimizations && this.connections.size === 1;
    }

    get twoDevicePeerId(): string | null {
        return this.isTwoDeviceMode() ? Array.from(this.connections.keys())[0] : null;
    }

    /**
     * Which of two paired devices leads Merkle reconciliation (the lower device ID). Compares
     * real IDs: an Offline Mode client knows its host only as 'direct-ip-host', and comparing
     * against that literal gave both ends the same role.
     */
    getMyRole(peerId: string): DeviceRole {
        const theirs = this.realDeviceId(peerId) ?? peerId;
        return this.settings.deviceId < theirs ? 'primary' : 'secondary';
    }

    // --- Version Vectors ---
    incrementVersion(path: string) {
        if (!this.twoDeviceState.fileVersions[path]) this.twoDeviceState.fileVersions[path] = {};
        this.twoDeviceState.fileVersions[path][this.settings.deviceId] = (this.twoDeviceState.fileVersions[path][this.settings.deviceId] || 0) + 1;
        this.scheduleStateSave();
    }

    // --- Merkle Tree Vault Diffing ---
    /**
     * Build the vault's Merkle tree.
     *
     * Files above MERKLE_SURROGATE_SIZE use a cheap size+mtime surrogate instead of a
     * real content hash, to avoid reading hundreds of MB just to compare trees. That
     * surrogate is deliberately NOT written into syncedHashes: doing so poisoned the
     * real hash cache, so buildVaultManifest published a fake hash and the
     * echo-suppression check in processQueueItem could never match. The visible symptom
     * was every large file re-transferring on every reconnect.
     */
    async buildMerkleTree(): Promise<MerkleNode> {
        const MERKLE_SURROGATE_SIZE = 5 * 1024 * 1024;
        const tree: MerkleNode = { hash: '', children: {} };
        const generation = this.merkleGeneration;
        const allFiles = this.app.vault.getAllLoadedFiles();

        // Two passes. The first resolves every file's hash, reading and digesting the
        // uncached ones concurrently — this used to be a strictly serial read-then-digest
        // per file, so a cold cache over a large vault spent almost all of its time with
        // one I/O request outstanding. The second pass builds the tree from the resolved
        // hashes, which is pure CPU and must stay ordered.
        const syncable: TFile[] = [];
        for (const file of allFiles) {
            if (file instanceof TFile && this.isPathSyncable(file.path)) syncable.push(file);
        }

        const hashes = new Map<string, string>();
        const uncached: TFile[] = [];
        for (const file of syncable) {
            const cached = this.cachedHashFor(file);
            if (cached) {
                hashes.set(file.path, cached);
            } else if (file.stat.size > MERKLE_SURROGATE_SIZE) {
                // Tree-local surrogate only; never cached as a content hash.
                hashes.set(file.path, `size-${file.stat.size}-mtime-${file.stat.mtime}`);
            } else {
                uncached.push(file);
            }
        }

        if (uncached.length > 0) {
            this.log(`Merkle: hashing ${uncached.length} uncached file(s).`);
            await mapWithConcurrency(uncached, 8, async (file) => {
                const stat = { mtime: file.stat.mtime, size: file.stat.size };
                const content = this.isBinary(file.extension) ? await this.app.vault.readBinary(file) : await this.app.vault.cachedRead(file);
                const hash = await this.getHash(content);
                this.updateHashCache(file.path, hash, stat);
                hashes.set(file.path, hash);
            });
        }

        let lastYield = Date.now();
        for (const file of syncable) {
            const hash = hashes.get(file.path);
            // A file that vanished mid-build has no hash; leaving it out of the tree is
            // correct — it is no longer part of the vault we are describing.
            if (!hash) continue;

            // Tree insertion is cheap but a huge vault still adds up; keep the UI alive.
            if (Date.now() - lastYield > 8) {
                await new Promise(r => setTimeout(r, 0));
                lastYield = Date.now();
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

        const computeHashes = async (root: MerkleNode): Promise<string> => {
            // Iterative post-order traversal — prevents stack overflow on deeply nested vaults
            const stack: Array<{ node: MerkleNode; phase: 'push' | 'process' }> = [{ node: root, phase: 'push' }];
            while (stack.length > 0) {
                const entry = stack.pop()!;
                if (entry.phase === 'process') {
                    const node = entry.node;
                    if (node.children && Object.keys(node.children).length > 0) {
                        const childKeys = Object.keys(node.children).sort();
                        let combined = '';
                        for (const k of childKeys) combined += node.children[k].hash;
                        node.hash = await this.getHash(combined);
                    }
                } else {
                    stack.push({ node: entry.node, phase: 'process' });
                    if (entry.node.children) {
                        for (const child of Object.values(entry.node.children)) {
                            stack.push({ node: child, phase: 'push' });
                        }
                    }
                }
            }
            return root.hash;
        };

        await computeHashes(tree);
        this.twoDeviceState.merkleTreeRoot = tree;
        // A file changed while this was being built (hashing yields): the tree may already be
        // stale, so use it this once but build afresh next time. Caching it made a deletion
        // made right after connecting invisible, and reconciliation reported "in sync".
        this.merkleTreeBuiltAt = generation === this.merkleGeneration ? Date.now() : 0;
        this.scheduleStateSave();
        return tree;
    }

    /**
     * Merkle tree, rebuilt only when the vault may have changed since the last build.
     *
     * buildMerkleTree walks and hashes the entire vault. It ran unconditionally on every
     * handshake and on every incoming merkle-root, so a flapping connection re-hashed
     * the whole vault repeatedly. Vault mutations clear the cache via
     * invalidateMerkleTree(), so a reconnect with no local edits is free.
     */
    private async getMerkleTree(): Promise<MerkleNode> {
        const cached = this.twoDeviceState.merkleTreeRoot;
        if (cached && this.merkleTreeBuiltAt > 0) return cached;
        return this.buildMerkleTree();
    }

    private invalidateMerkleTree() {
        this.merkleGeneration++;
        this.merkleTreeBuiltAt = 0;
    }

    // --- State Management ---
    //
    // Durable truth (version vectors, tombstones, failed syncs, resumable transfers)
    // lives in state.json. The SHA-256 cache is a pure rebuildable cache and lives in
    // hash-cache.json on a much slower cadence: it is by far the largest field, and
    // folding it into every save meant re-serialising megabytes of JSON roughly once a
    // second for the whole duration of a sync.

    private async readJson(path: string): Promise<any | null> {
        try {
            if (await this.app.vault.adapter.exists(path)) {
                return JSON.parse(await this.app.vault.adapter.read(path));
            }
        } catch (e) {
            console.error(`Failed to parse state from ${path}:`, e);
        }
        return null;
    }

    /**
     * Write via .tmp then rotate with renames. The previous implementation read the
     * whole existing file back just to copy it to .bak, costing a full extra read and
     * write of the largest file in the plugin on every single save.
     */
    private async writeJsonAtomic(path: string, json: string) {
        const tmpPath = path + '.tmp';
        const bakPath = path + '.bak';
        const adapter = this.app.vault.adapter;
        try {
            await adapter.write(tmpPath, json);
            if (await adapter.exists(path)) {
                if (await adapter.exists(bakPath)) {
                    try { await adapter.remove(bakPath); } catch (_) { /* best effort */ }
                }
                try {
                    await adapter.rename(path, bakPath);
                } catch (_) {
                    // Some adapters/platforms refuse the rename; the .tmp copy below is
                    // still a complete file, so fall through rather than abort the save.
                }
            }
            try {
                await adapter.rename(tmpPath, path);
            } catch (_) {
                // Rename unavailable — fall back to a direct write and clean up .tmp.
                await adapter.write(path, json);
                if (await adapter.exists(tmpPath)) await adapter.remove(tmpPath);
            }
        } catch (e) {
            console.error(`Failed to save ${path}:`, e);
        }
    }

    async loadState() {
        let state = await this.readJson(this.statePath);
        // No state.json at all is a first run, not a failure worth reporting.
        if (!state && (await this.app.vault.adapter.exists(this.statePath) || await this.app.vault.adapter.exists(this.statePath + '.bak'))) {
            console.warn('Primary state.json failed — attempting backup recovery...');
            state = await this.readJson(this.statePath + '.bak');
            if (state) this.showNotice('We restored sync info from a backup file.', 'warning');
        }

        if (state) {
            if (state.activeTransfers) {
                for (const t of state.activeTransfers) {
                    this.activeTransfers.set(t.id, { ...t, status: 'paused' });
                }
                this.updateStatus();
            }
            if (state.failedSyncs) this.failedSyncs = state.failedSyncs;
            if (state.tombstones) this.tombstones = state.tombstones;
            this.configSync?.load(state.configSync);
            if (state.twoDeviceState) {
                this.twoDeviceState = state.twoDeviceState;
                if (!this.twoDeviceState.fileVersions) this.twoDeviceState.fileVersions = {};
            }
            // Migration: 2.x kept the hash cache inside state.json.
            if (state.syncedHashes) {
                for (const [p, d] of Object.entries(state.syncedHashes)) {
                    this.syncedHashes.set(p, d as any);
                }
                this.hashCacheDirty = true;
            }
        }

        const cache = await this.readJson(this.hashCachePath);
        if (cache && cache.syncedHashes) {
            for (const [p, d] of Object.entries(cache.syncedHashes)) {
                this.syncedHashes.set(p, d as any);
            }
        }

        await this.loadQueueState();
    }

    /**
     * @param force bypass the dirty check and the during-sync rate limit (used on unload).
     */
    async saveState(force = false) {
        if (!force) {
            if (!this.stateDirty) return;
            // A sync mutates version vectors and transfer progress constantly; 1 s
            // writes there are pure overhead when the data is only needed on restart.
            const minInterval = this.syncState.isSyncing ? 5000 : 0;
            if (minInterval && Date.now() - this.lastStateSaveAt < minInterval) {
                this.scheduleStateSave();
                return;
            }
        }
        this.stateDirty = false;
        this.lastStateSaveAt = Date.now();

        const json = JSON.stringify({
            activeTransfers: Array.from(this.activeTransfers.values()),
            failedSyncs: this.failedSyncs,
            twoDeviceState: this.twoDeviceState,
            tombstones: this.tombstones,
            configSync: this.configSync?.state,
        });
        await this.writeJsonAtomic(this.statePath, json);
    }

    async saveHashCache(force = false) {
        if (!force && !this.hashCacheDirty) return;
        this.hashCacheDirty = false;
        const json = JSON.stringify({ syncedHashes: Object.fromEntries(this.syncedHashes) });
        await this.writeJsonAtomic(this.hashCachePath, json);
    }

    /** Mark durable state as needing a write and schedule the debounced save. */
    private scheduleStateSave() {
        this.stateDirty = true;
        // onunload has already written the final copy; a late write could land after the
        // next instance loaded and overwrite what it saved.
        if (this.unloaded) return;
        this.debouncedSaveState();
    }

    /** Queue contents changed. Persisted separately from state.json, on its own cadence. */
    private scheduleQueueSave() {
        this.queueDirty = true;
        if (this.unloaded) return;
        this.debouncedSaveQueue();
    }

    /**
     * @param stat size and mtime of the bytes that were hashed. Without them the entry can
     *   never be trusted by cachedHashFor(), so callers that know them should pass them.
     */
    updateHashCache(path: string, hash: string, stat?: { mtime: number; size: number }) {
        if (this.syncedHashes.has(path)) {
            this.syncedHashes.delete(path);
        }
        this.syncedHashes.set(path, { hash, timestamp: Date.now(), mtime: stat?.mtime, size: stat?.size });
        if (this.syncedHashes.size > MAX_HASH_CACHE_SIZE) {
            const oldestPath = this.syncedHashes.keys().next().value;
            if (oldestPath) this.syncedHashes.delete(oldestPath);
        }
        // Cache-only mutation: this used to trigger a full state write per hashed file.
        this.hashCacheDirty = true;
        if (!this.unloaded) this.debouncedSaveHashCache();
    }

    /**
     * The cached hash of `file`'s current content, or undefined when there is none or it was
     * computed for different bytes. The cache used to be trusted blindly, and two things put
     * wrong hashes in it: an incoming update recorded the PEER's hash even when it was then
     * rejected (local newer, conflict copy), and edits made outside Obsidian never updated
     * it. Either way a full sync or Merkle comparison then saw matching hashes for different
     * files and silently skipped them.
     */
    private cachedHashFor(file: TFile): string | undefined {
        const entry = this.syncedHashes.get(file.path);
        if (!entry || entry.mtime !== file.stat.mtime || entry.size !== file.stat.size) return undefined;
        return entry.hash;
    }

    /** Remember that `path` now holds content a peer sent, with hash `hash`. */
    private noteRemoteWrite(path: string, hash: string | undefined) {
        if (!hash) return;
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) this.updateHashCache(path, hash, file.stat);
        this.remoteEchoHashes.set(path, { hash, at: Date.now() });
    }

    /** True (once) when `hash` is exactly the content a peer just gave us for `path`. */
    private isRemoteEcho(path: string, hash: string): boolean {
        const entry = this.remoteEchoHashes.get(path);
        if (!entry) return false;
        this.remoteEchoHashes.delete(path);
        return !!hash && entry.hash === hash;
    }

    pruneTombstones() {
        const retentionMs = (this.settings.tombstoneRetentionDays || 30) * 24 * 60 * 60 * 1000;
        const now = Date.now();
        let pruned = false;
        for (const [path, timestamp] of Object.entries(this.tombstones)) {
            if (now - timestamp > retentionMs) {
                delete this.tombstones[path];
                if (this.twoDeviceState.fileVersions) delete this.twoDeviceState.fileVersions[path];
                pruned = true;
            }
        }
        if (pruned) this.scheduleStateSave();
    }

    async loadSettings() {
        // Deep-copy the defaults: a shallow merge handed out DEFAULT_SETTINGS' own nested
        // objects, so pairing keys, known peers and blocked IDs were written into the shared
        // defaults themselves and leaked into anything else that read them.
        const defaults: ObsidianDecentralizedSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        const stored = (await this.loadData()) ?? {};
        this.settings = Object.assign(defaults, stored);
        // Merge the nested server config field by field so an older data.json that lacks a
        // field keeps its default rather than an undefined.
        this.settings.customPeerServerConfig = {
            ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS.customPeerServerConfig)),
            ...(stored.customPeerServerConfig ?? {}),
        };
        // Invalidate folder filter caches whenever settings are (re-)loaded
        this._cachedExcludedFolders = null;
        this._cachedIncludedFolders = null;
        if (!this.settings.deviceId) {
            this.settings.deviceId = this.mintDeviceId();
            if (isGenericDeviceName(this.settings.friendlyName)) {
                this.settings.friendlyName = this.suggestFriendlyName();
            }
            await this.saveData(this.settings);
        }
        if (!this.settings.peerKeys) this.settings.peerKeys = {};
        if (!Array.isArray(this.settings.blockedPeers)) this.settings.blockedPeers = [];
        await this.migrateSettings(stored);
        this.applyHideNativeSync(); 
        if (this.settings.knownPeers) {
            this.settings.knownPeers.forEach(p => this.clusterPeers.set(p.deviceId, persistablePeerInfo(p)));
        }
    }
    /** One-time changes to settings saved by earlier versions. */
    private async migrateSettings(stored: Partial<ObsidianDecentralizedSettings>) {
        // A data.json without a version predates versioning (1); a fresh install has nothing
        // to migrate.
        const from = typeof stored.settingsVersion === 'number'
            ? stored.settingsVersion
            : (Object.keys(stored).length ? 1 : SETTINGS_VERSION);
        if (from >= SETTINGS_VERSION) return;
        if (from < 2) {
            // Real-time keystroke sync defaulted to on and rewrote the open editor from the
            // network; it is opt-in now, including for installs that never touched it.
            this.settings.enableRealtimeSync = false;
        }
        this.settings.settingsVersion = SETTINGS_VERSION;
        await this.saveData(this.settings);
    }

    async saveSettings() {
        await this.saveData(this.settings);
        // Invalidate folder filter caches so isPathSyncable picks up the new values immediately
        this._cachedExcludedFolders = null;
        this._cachedIncludedFolders = null;
        // A PSK may have been added, rotated or removed — drop cached CryptoKeys so a
        // stale key is never reused for a peer.
        this.invalidateCryptoKey();
        void this.configSync?.onSettingsChanged();
    }
    async saveKnownPeers() {
        this.settings.knownPeers = Array.from(this.clusterPeers.values()).map(persistablePeerInfo);
        await this.saveSettings();
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
        const newLock = existingLock.catch(() => {}).then(async () => {
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

    public showNotice(message: string, level: 'info' | 'verbose' | 'error' | 'important' | 'warning' | 'transient' = 'info', timeout?: number) {
        // Work still settling after a disable must not pop toasts for a plugin that is off.
        if (this.unloaded) {
            this.log(`[notice after unload] ${message}`);
            return;
        }
        // 'transient' is connection-lifecycle churn (dropped/reconnecting/closed). A flaky
        // network fires it in a loop, so it never reaches a toast at all — not even when
        // showToasts is on. The status bar reports the very same state continuously
        // ('Reconnecting...', 'Retrying connection...', 'Error: ...'), so nothing is lost
        // and there is no setting that can turn this spam back on.
        if (level === 'transient') {
            this.log(`[notice suppressed] ${message}`);
            return;
        }

        // Collapse repeats of the identical message. Without this a reconnect loop stacks
        // the same toast every few seconds regardless of which level it carries.
        const NOTICE_DEDUPE_MS = 15000;
        const now = Date.now();
        const lastShown = this.recentNotices.get(message);
        if (lastShown !== undefined && now - lastShown < NOTICE_DEDUPE_MS) {
            this.log(`[notice deduped] ${message}`);
            return;
        }
        if (this.recentNotices.size > 100) {
            for (const [text, at] of this.recentNotices) {
                if (now - at > NOTICE_DEDUPE_MS) this.recentNotices.delete(text);
            }
        }
        this.recentNotices.set(message, now);

        // Errors, warnings and connection/conflict events always surface, regardless of
        // showToasts — that is what the setting's own description promises, and gating them
        // left a fresh install completely mute (including failures the user must act on).
        if (level === 'error') {
            new Notice(message, timeout || 10000);
            return;
        }
        if (level === 'warning') {
            new Notice(message, timeout || 8000);
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

    /**
     * The newer version always wins. By default the device whose edit lost keeps it as a
     * conflict copy; "last write wins" (manual mode) drops it instead. A saved
     * 'create-conflict-file' means the default: it used to keep the incoming version as the
     * copy on every device, so each device kept its own version and they never converged.
     */
    public getConflictStrategy(): 'newest-with-copy' | 'last-write-wins' {
        if (this.settings.syncMode !== 'auto' && this.settings.conflictResolutionStrategy === 'last-write-wins') return 'last-write-wins';
        return 'newest-with-copy';
    }
    public shouldSyncAllFileTypes() { return this.settings.syncMode === 'auto' ? true : this.settings.syncAllFileTypes; }
    public shouldSyncObsidianConfig() { return this.configScope() !== 'off'; }
    /**
     * Which Obsidian settings sync: Automatic mode shares the look (theme, CSS snippets,
     * appearance settings); the manual opt-in adds settings, hotkeys and other plugins.
     */
    public configScope(): ConfigScope {
        if (this.settings.syncMode === 'auto') return 'appearance';
        return this.settings.syncObsidianConfig ? 'full' : 'off';
    }
    // Respect the explicit connectionMode even in 'auto' sync mode: hard-forcing
    // 'peerjs' here made the "Switch to Offline Mode" UI a no-op for default-profile
    // users — the UI showed Direct-IP while the runtime kept using PeerJS.
    public getConnectionMode() { return this.settings.connectionMode || 'peerjs'; }
    private hasPeers(): boolean {
        if (this.getConnectionMode() === 'direct-ip') {
            return !!this.directIpClient || !!this.directIpServer;
        }
        return this.connections.size > 0;
    }

    private generateTransferId(path: string): string { return `${path}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
    
    // --- File System Events ---
    private handleEvent(file: TAbstractFile, kind?: 'modify') {
        // A change right after we wrote a peer's version is either that write coming back or
        // a real edit on top of it: handleFileChange compares contents to tell. Silencing the
        // path for two seconds instead dropped any edit made in that window — it was never
        // counted or sent.
        const checkContent = kind === 'modify' && this.remoteEchoHashes.has(file.path);
        if (!checkContent && this.shouldIgnoreEvent(file.path)) return;
        if (!this.isPathSyncable(file.path)) return;

        // Record local state even with no peer connected. This used to return here first, so
        // an edit or delete made while offline left no trace: no hash invalidation, no version
        // bump, and — because the tombstone is written inside handleFileDelete — no record of
        // the deletion at all. On the next connection the stale hash made the vaults look
        // identical, and peers resurrected files that had been deleted offline.
        if (!this.hasPeers() && !checkContent) {
            if (!this.app.vault.getAbstractFileByPath(file.path)) {
                this.syncedHashes.delete(file.path);
                this.recordLocalEdit(file.path);
                this.tombstones[file.path] = Date.now();
            } else {
                this.syncedHashes.delete(file.path);
                this.recordLocalEdit(file.path);
                this.clearTombstone(file.path);
            }
            this.scheduleStateSave();
            return;
        }

        if (this.isTwoDeviceMode() && this.remoteLocks.has(file.path)) {
            const lock = this.remoteLocks.get(file.path)!;
            if (Date.now() < lock.expiresAt) {
                this.showNotice(`${file.name} is being edited on another device. Sync will wait.`, 'warning');
                // Actually delay: re-run this event once the peer's lock expires
                this.timeoutManager.setTimeout(() => this.handleEvent(file), (lock.expiresAt - Date.now()) + 250);
                return;
            } else {
                this.remoteLocks.delete(file.path);
            }
        }

        if (!this.app.vault.getAbstractFileByPath(file.path)) {
            this.handleFileDelete(file);
            return;
        }
        this.debounceFileChange(file);
    }

    /**
     * Per-path debounce for file changes.
     *
     * Obsidian's debounce() keeps a single timer and the last call's arguments win, so
     * one shared debouncer meant that editing file A and then file B inside the window
     * dropped A's sync entirely. Each path now gets its own timer.
     */
    private debounceFileChange(file: TAbstractFile) {
        const path = file.path;
        const existing = this.pendingFileChanges.get(path);
        if (existing !== undefined) this.timeoutManager.clearTimeout(existing);

        const handle = this.timeoutManager.setTimeout(() => {
            this.pendingFileChanges.delete(path);
            // Re-resolve the file: it may have been renamed or deleted while waiting.
            const current = this.app.vault.getAbstractFileByPath(path);
            if (current) void this.handleFileChange(current);
        }, this.settings.debounceDelay);

        this.pendingFileChanges.set(path, handle);
    }
    
    private async handleFileChange(file: TAbstractFile) { 
        await this.runLocked(file.path, async () => { 
            this.log(`Processing debounced change for: ${file.path}`); 
            
            if (this.isTwoDeviceMode() && !this.heldLocks.has(file.path) && file instanceof TFile && !this.isBinary(file.extension)) {
                await this.requestLock(file.path);
            }

            if (file instanceof TFile) {
                const echo = this.remoteEchoHashes.get(file.path);
                if (echo) {
                    this.remoteEchoHashes.delete(file.path);
                    const content = this.isBinary(file.extension) ? await this.app.vault.readBinary(file) : await this.app.vault.read(file);
                    if (await this.getHash(content) === echo.hash) {
                        // Our own write of a peer's version: nothing was edited here.
                        this.ignoreEvents.delete(file.path);
                        return;
                    }
                }
                this.recordLocalEdit(file.path);
                this.syncedHashes.delete(file.path);
                // Recreating a deleted file must retract our deletion record, or the next
                // manifest still advertises it as deleted and peers remove their copy.
                this.clearTombstone(file.path);
                if (!this.hasPeers()) {
                    this.scheduleStateSave();
                    return;
                }
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
                this.recordLocalEdit(file.path);
                this.tombstones[file.path] = Date.now(); 
                this.scheduleStateSave(); 
                this.addToQueueTask(null, { taskType: 'send-delete', path: file.path }); 
            } else if (file instanceof TFolder) { 
                this.broadcastData({ type: 'folder-delete', path: file.path, transferId: this.generateTransferId(file.path) }); 
            } 
        }); 
    }
    
    private async handleRenameEvent(file: TAbstractFile, oldPath: string) {
        if (oldPath === file.path) return;
        // Acquire locks in sorted order to prevent deadlock between concurrent renames (e.g. A→B and B→A)
        const [firstLock, secondLock] = [oldPath, file.path].sort();
        await this.runLocked(firstLock, async () => {
            await this.runLocked(secondLock, async () => {
                if (this.shouldIgnoreEvent(oldPath) || this.shouldIgnoreEvent(file.path)) return;
                const wasSynced = this.isPathSyncable(oldPath);
                const isSynced = this.isPathSyncable(file.path);
                if (!wasSynced && !isSynced) return;
                this.log(`Processing rename: ${oldPath} -> ${file.path}`);

                if (file instanceof TFile) {
                    // Recorded even with no peer connected: an offline rename used to return
                    // before this, leaving the file's hash and version vector under a path
                    // that no longer exists.
                    this.moveFileRecords(oldPath, file.path);
                    this.recordLocalEdit(file.path);
                    if (!this.hasPeers()) return;
                    this.ignoreNextEventForPath(file.path);
                    this.ignoreNextEventForPath(oldPath);
                    if (!wasSynced) {
                        // Moved in from a folder this device does not sync: peers have never
                        // seen it, so a rename would give them nothing to move.
                        void this.sendFileUpdate(file, undefined, true);
                    } else {
                        this.addToQueueTask(null, { taskType: 'send-rename', oldPath, newPath: file.path });
                    }
                } else if (file instanceof TFolder) {
                    // Its files each get their own rename event and follow individually.
                    if (!this.hasPeers() || !wasSynced) return;
                    this.ignoreNextEventForPath(file.path);
                    this.ignoreNextEventForPath(oldPath);
                    this.broadcastData({ type: 'folder-rename', oldPath, newPath: file.path, transferId: this.generateTransferId(file.path) });
                }
            });
        });
    }

    /**
     * Count a local change in the file's version vector — every local change, connected or
     * not, however many devices are connected. The vectors are how every device tells "made
     * with the other's change in hand" from "changed independently", and conflicts are
     * decided from them; an edit that went uncounted could lose to an older copy.
     */
    private recordLocalEdit(path: string) {
        this.incrementVersion(path);
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
            // uses the shared module-level dmp instance
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

    /**
     * Imported AES-GCM keys, cached per peer. Previously every single message —
     * including every 512 KB chunk — re-derived the key from base64 and called
     * importKey, which dominated the cost of encrypted transfers.
     */
    private cryptoKeys: Map<string, CryptoKey> = new Map();

    private async getCryptoKey(peerId: string): Promise<CryptoKey | null> {
        const cached = this.cryptoKeys.get(peerId);
        if (cached) return cached;
        const psk = this.settings.peerKeys[peerId];
        if (!psk) return null;
        const key = await window.crypto.subtle.importKey(
            'raw', base64ToArrayBuffer(psk), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
        );
        this.cryptoKeys.set(peerId, key);
        return key;
    }

    /** Drop a cached key so a rotated or removed PSK is never reused. */
    public invalidateCryptoKey(peerId?: string) {
        if (peerId) this.cryptoKeys.delete(peerId);
        else this.cryptoKeys.clear();
    }

    /**
     * The pairing key that governs traffic with `peerId`, or null when that link carries no
     * application-layer encryption. Sending and receiving both ask this one question: the
     * send side encrypting under one rule while the receive side refused plaintext under
     * another is how every paired link came to reject its own heartbeats and acks.
     *
     * Offline Mode never uses pairing keys. The host knows a client by its device ID while
     * the client knows the host as 'direct-ip-host', so a key left over from an earlier Quick
     * Pair applied on one side only and neither could read the other. Offline Mode is
     * encrypted by its own transport instead.
     */
    public peerKeyFor(peerId: string | null | undefined): string | null {
        if (!peerId || this.getConnectionMode() === 'direct-ip') return null;
        return this.settings.peerKeys[peerId] || null;
    }

    /** `payload` in the form it must travel to `peerId`: encrypted whenever a key applies. */
    private async toWire(peerId: string | null, payload: any): Promise<any> {
        return peerId && this.peerKeyFor(peerId) ? this.encryptPayload(payload, peerId) : payload;
    }

    /**
     * Send a small control message immediately, outside the queue: heartbeat pings, pongs,
     * acks, sync-acks. These used to go out as raw conn.send() — plaintext, which a paired
     * peer refuses — so an idle paired link was dropped by the heartbeat and no transfer or
     * sync step on it was ever acknowledged.
     */
    public sendDirect(conn: { peer: string; open?: boolean; send: (data: any) => void }, payload: any): void {
        void this.toWire(conn.peer, payload)
            .then(wire => {
                if (conn.open === false) return;
                conn.send(wire);
            })
            .catch(e => this.log(`Could not send ${payload?.type} to ${conn.peer}:`, e));
    }

    /**
     * Encrypt a message into the V3 wire envelope: { type:'encrypted-frame', data }
     * where data is [12B IV][AES-GCM ciphertext] and the plaintext is a single
     * packFrame buffer of [headerLen][header JSON][raw binary body].
     *
     * Binary bodies stay binary end to end. The 2.x envelope base64'd them into
     * JSON and then base64'd the ciphertext again, inflating the wire by ~33% and
     * copying the buffer three extra times per message.
     */
    async encryptPayload(data: any, peerId: string): Promise<any> {
        const key = await this.getCryptoKey(peerId);
        if (!key) throw new Error(`No encryption key for peer ${peerId}`);
        try {
            const { header, body } = splitBinaryPayload(data);
            const plaintext = packFrame(header, body);
            const iv = window.crypto.getRandomValues(new Uint8Array(12));
            const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

            const framed = new Uint8Array(12 + ciphertext.byteLength);
            framed.set(iv, 0);
            framed.set(new Uint8Array(ciphertext), 12);
            return { type: 'encrypted-frame', data: framed.buffer };
        } catch (e) {
            // Never fall back to plaintext — throw so the caller halts the send.
            this.log('Encryption failed', e);
            throw new Error(`Encryption failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    async decryptPayload(encryptedPayload: any, peerId: string): Promise<any> {
        const key = await this.getCryptoKey(peerId);
        if (!key) throw new Error(`No decryption key for peer ${peerId}`);
        // Views, not copies. This used to normalise a Uint8Array into its own ArrayBuffer
        // and then slice off the IV, so every encrypted message — including every chunk of
        // every file — was copied twice before decryption even started.
        const raw = encryptedPayload.data;
        const frame: Uint8Array = raw instanceof ArrayBuffer ? new Uint8Array(raw) : (raw as Uint8Array);
        if (frame.byteLength < 13) throw new Error('Decryption failed: frame too short');
        try {
            const iv = frame.subarray(0, 12);
            const ciphertext = frame.subarray(12);
            const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
            const { header, body } = unpackFrame(decrypted);
            return joinBinaryPayload(header, body);
        } catch (e) {
            this.log('Decryption failed', e);
            throw new Error('Decryption failed');
        }
    }

    // --- Communication Layer ---
    broadcastData(data: SyncData) { this.addToQueue(null, data); }
    sendData(peerId: string, data: SyncData) { this.addToQueue(peerId, data); }
    
    private computePriority(data: SyncData): number {
        if (data.type === 'editor-delta' || data.type === 'editor-active' || data.type.startsWith('lock-')) return 1000000; 

        const controlMessages = ['request-full-sync', 'sync-plan', 'request-batch', 'batch-complete', 'full-sync-complete', 'sync-control-binary'];
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

    /**
     * Stable identity for a queued task, so that re-queueing the same work for the same
     * peer coalesces instead of piling up. The QueueManager dedups on this id; it used
     * to receive a random id per call, which meant its dedup set never matched anything
     * and a file saved N times in quick succession was queued and sent N times.
     *
     * Only tasks get a stable id. 'data' items carry an already-built payload (often a
     * distinct chunk or transfer) and must not be collapsed.
     */
    private taskQueueId(peerId: string | null, task: SyncTask): string {
        return taskQueueId(peerId, task);
    }

    /**
     * Send one already-encoded payload to a peer, applying transport backpressure first.
     *
     * This replaces four near-identical inline blocks that each re-implemented the
     * bufferedAmount wait (and, on the WebRTC side, each stomped on
     * dc.onbufferedamountlow). Thresholds default to the small-message values; the
     * chunk loop passes its own, larger ones.
     */
    private async sendPayloadTo(peerId: string, payload: any, highWater = 2 * 1024 * 1024, lowWater = 1 * 1024 * 1024) {
        if (this.getConnectionMode() === 'direct-ip') {
            if (this.directIpClient) {
                await this.connectionManager.waitForSocketToDrain(
                    () => this.directIpClient!.getBufferedAmount(), highWater, lowWater);
                this.directIpClient.send(payload);
            } else if (this.directIpServer) {
                await this.connectionManager.waitForSocketToDrain(
                    () => this.directIpServer!.getBufferedAmount(peerId), highWater, lowWater);
                this.directIpServer.sendTo(peerId, payload);
            } else {
                throw new Error("No direct-IP transport available");
            }
            return;
        }

        const conn = this.connections.get(peerId);
        if (!conn?.open) throw new Error("Connection closed");
        const dc = (conn as any)?.dataChannel || (conn as any)?._dc;
        await this.connectionManager.waitForBufferToDrain(dc, 60000, highWater, lowWater);
        conn.send(payload);
    }

    private addToQueue(peerId: string | null, data: SyncData) {
        const priority = this.computePriority(data);
        // Keep the QueueManager's limit in step with the adaptive one. It used to be
        // synced only in processQueue(), which runs when a full sync COMPLETES — so the
        // entire transfer phase (and all day-to-day sends) drained at the QueueManager's
        // constructor default of 3 concurrent items instead of the intended 16–50.
        this.queueManager.setConcurrencyLimit(this.getConcurrencyLimit());
        this.queueManager.addToQueue({ peerId, data, retries: 0, priority });
        // 'data' items are not persisted, so only the queue file is affected here.
        this.scheduleQueueSave();
    }

    private addToQueueTask(peerId: string | null, task: SyncTask) {
        const priority = this.computePriorityTask(task);
        this.queueManager.setConcurrencyLimit(this.getConcurrencyLimit());
        this.queueManager.addToQueue({ id: this.taskQueueId(peerId, task), peerId, task, retries: 0, priority });
        this.scheduleQueueSave();
    }

    public getQueuePressure(): number {
        return this.queueManager.getQueuePressure();
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
        // Sync control messages are serialised to JSON and deflated into a binary body.
        // Two reasons: PeerJS's msgpack serializer blows the stack recursively packing
        // large nested payloads (a 20k-item manifest), and an uncompressed manifest is
        // multiple MB of highly repetitive text that compresses by roughly an order of
        // magnitude. The body rides as raw bytes, so nothing base64s it.
        const envelope = {
            type: 'sync-control-binary',
            data: compressText(JSON.stringify({ ...data, messageId })),
        };

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
            this.sendData(peerId, envelope as any);
        });
    }

    /**
     * @param opts.silent skip the user-facing notice (used on unload, where the user just
     *   turned the plugin off and a "Sync stopped" toast would be noise).
     */
    public abortSync(error?: SyncError, opts?: { silent?: boolean }) {
        if (!this.syncState.isSyncing) return;
        const syncPeer = this.syncState.peerId;
        this.transitionToPhase(SyncPhase.ABORTING);
        this.syncState.isSyncing = false;
        this.currentSyncIsTwoDeviceMode = null;
        this.queueManager.clear();
        this.scheduleQueueSave();
        this.scheduleStateSave();
        // Only this sync's transfers. Clearing them all also discarded paused uploads to
        // other devices, which are the only record that those devices still need a file.
        for (const [id, transfer] of this.activeTransfers) {
            if (transfer.peerId === syncPeer) this.activeTransfers.delete(id);
        }
        this.syncState.pendingPulls.clear();
        this.syncState.allowedPulls.clear();
        this.syncState.activeBatches.clear();
        // These two were left populated across an abort, so the next sync's batch-complete
        // messages were matched against stale ids and its in-flight bookkeeping never settled.
        this.syncState.activePullBatches?.clear();
        this.syncState.inFlightPulls?.clear();
        this.localSyncComplete.clear();
        this.peerSyncComplete.clear();
        this.pullRetries.clear();
        this.pullOrder = [];
        this.pullCursor = 0;
        this.syncState.peerId = null;
        this.peerFileSizes = {};
        this.sentManifestMtimes = new Map();
        this.timeoutManager.clearTimeout(this.syncIdleTimeout);
        this.syncIdleTimeout = null;
        if (this.syncKeepAliveInterval) { clearInterval(this.syncKeepAliveInterval); this.syncKeepAliveInterval = null; }
        if (this.syncState.phaseTimeoutHandle) { clearTimeout(this.syncState.phaseTimeoutHandle); this.syncState.phaseTimeoutHandle = null; }

        const errorMessage = error ? error.message : "Sync aborted manually.";
        this.rejectAllPendingAcks(errorMessage);

        if (opts?.silent) {
            this.log(`Sync aborted silently${error ? ` [${error.category}]: ${error.message}` : '.'}`);
        } else if (error) {
            if (error.category === SyncErrorCategory.TIMEOUT_ERROR && error.message === "Sync idle timeout reached. Connection may have dropped.") {
                this.showNotice("Sync stalled — nothing moved for a while. Try Force full sync.", "warning");
            } else {
                this.showNotice(`Sync stopped. ${error.message} ${error.suggestedAction}`, 'error', 10000);
            }
            this.log(`Sync aborted [${error.category}]: ${error.message}`);
        } else {
            this.showNotice(`Sync stopped.`, 'warning', 5000);
            this.log(`Sync aborted manually.`);
        }
        
        this.syncState.currentPhase = SyncPhase.IDLE;
        this.updateStatus();
    }

    public getConcurrencyLimit() { 
        if (this.settings.maximumConcurrentTransfers) return this.settings.maximumConcurrentTransfers;
        if (this.getConnectionMode() === 'direct-ip') return Math.max(this.currentConcurrency, 50);
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
                const maxConcurrency = this.getConnectionMode() === 'direct-ip' ? 200 : 32;
                if (this.currentConcurrency < maxConcurrency) {
                    this.currentConcurrency = Math.min(maxConcurrency, this.currentConcurrency + Math.max(1, Math.floor(this.currentConcurrency * 0.1)));
                    this.log(`Network stable. Increasing concurrency to ${this.currentConcurrency}`);
                }
                if (this.currentChunkSize < this.targetChunkSize && this.getConnectionMode() !== 'direct-ip') {
                    this.currentChunkSize = Math.min(this.targetChunkSize, Math.floor(this.currentChunkSize * 1.5));
                    this.log(`Network stable. Increasing chunk size to ${this.currentChunkSize}`);
                }
                this.successfulTransfersSinceLastIncrease = 0;
                // Apply the raised ceiling to items already sitting in the queue.
                this.queueManager.setConcurrencyLimit(this.getConcurrencyLimit());
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
            // Back off in-flight admission immediately, not on the next enqueue.
            this.queueManager.setConcurrencyLimit(this.getConcurrencyLimit());
        }
    }

    resetIdleTimeout() {
        this.timeoutManager.clearTimeout(this.syncIdleTimeout);
        if (this.syncState.isSyncing) {
            this.syncIdleTimeout = this.timeoutManager.setTimeout(() => {
                this.abortSync(new SyncError(SyncErrorCategory.TIMEOUT_ERROR, "Sync idle timeout reached. Connection may have dropped.", false, "Check network connection."));
            }, this.settings.idleTimeoutMs || 30000);
        }
    }

    private processQueue() {
        this.queueManager.setConcurrencyLimit(this.getConcurrencyLimit());
        this.queueManager.resume();
    }

    private async processQueueItem(item: { peerId: string | null, task?: SyncTask, data?: any, retries: number, priority: number, retryable?: boolean }) {
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
                        if (this.syncState.isSyncing) {
                            this.syncState.currentFile = file.path;
                            this.syncState.currentFileSize = file.stat.size;
                        }
                        // NOTE: lastSentContent eviction is handled by the 60-s cleanupPendingChunks interval
                        const statAtRead = { mtime: file.stat.mtime, size: file.stat.size };
                        let content: string | ArrayBuffer = this.isBinary(file.extension) ? await this.app.vault.readBinary(file) : await this.app.vault.read(file);
                        let encoding: 'utf8' | 'binary' | 'base64' = this.isBinary(file.extension) ? 'binary' : 'utf8';
                        let hash = '';
                        try { hash = await this.getHash(content); } catch(e) {}

                        if (!task.forceFull && this.isRemoteEcho(file.path, hash)) {
                            this.log(`Ignoring echo event for ${file.path}`);
                            success = true;
                            return;
                        }
                        if (hash) this.updateHashCache(file.path, hash, statAtRead);
                        
                        let isCompressedText = false;
                        // A snapshot taken when the send was queued wins: a conflict reply must
                        // carry the vector from before this device folded in the other side's.
                        let vv = task.versionVector ?? this.twoDeviceState.fileVersions[file.path];
                        
                        if (!this.isBinary(file.extension)) {
                            if (this.settings.enableDeltaSync && !task.forceFull) {
                                const cached = this.lastSentContent.get(file.path);
                                const newText = content as string;
                                if (cached) {
                                    // uses the shared module-level dmp instance
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
                                const encoded = ObsidianDecentralizedPlugin.textEncoder.encode(content);
                                if (encoded.byteLength > this.getChunkSize()) {
                                    content = encoded.buffer;
                                    encoding = 'binary';
                                }
                            }
                            item.data = { type: 'file-update', path: file.path, content, mtime: file.stat.mtime, encoding, transferId: this.generateTransferId(file.path), fileHash: hash, compressed: isCompressedText, versionVector: vv };
                        }
                    } else {
                        // The file is gone locally, so nothing was delivered. Reporting success
                        // put the path in the batch's receivedPaths, and the peer then dropped
                        // it from its pending pulls — the sync claimed to be complete with the
                        // file missing on both sides.
                        this.log(`Cannot send ${task.path}: no longer present in the vault.`);
                        return;
                    }
                } else if (task.taskType === 'send-delete') {
                    // The vector has to travel with the delete: handleFileDelete bumps it just
                    // before queueing this task, but it was never put on the wire, so the
                    // receiver's edit-versus-delete branch could never run and every remote
                    // delete applied unconditionally — destroying concurrent local edits.
                    if (this.app.vault.getAbstractFileByPath(task.path)) {
                        // Recreated since the deletion was queued: telling peers to delete
                        // it now would remove a file this device has.
                        this.log(`Not sending the deletion of ${task.path}: it exists again.`);
                        success = true;
                        return;
                    }
                    const vv = this.twoDeviceState.fileVersions[task.path];
                    item.data = { type: 'file-delete', path: task.path, transferId: this.generateTransferId(task.path), versionVector: vv, deletedAt: this.tombstones[task.path] };
                } else if (task.taskType === 'send-folder-create') {
                    item.data = { type: 'folder-create', path: task.path, transferId: this.generateTransferId(task.path) };
                } else if (task.taskType === 'send-rename') {
                    const vv = this.twoDeviceState.fileVersions[task.newPath];
                    item.data = { type: 'file-rename', oldPath: task.oldPath, newPath: task.newPath, transferId: this.generateTransferId(task.newPath), versionVector: vv };
                } else if (task.taskType === 'send-file-batch') {
                    // Read and compress the batch's files concurrently. Serially this was
                    // one outstanding vault read at a time for up to 500 files, and each
                    // read is I/O the renderer just waits on.
                    const settled = await mapWithConcurrency(task.paths, 8, async (path): Promise<PackedFile | null> => {
                        const file = this.app.vault.getAbstractFileByPath(path);
                        if (!(file instanceof TFile)) return null;

                        const isBinaryFile = this.isBinary(file.extension);
                        let content: string | ArrayBuffer | Uint8Array = isBinaryFile
                            ? await this.app.vault.readBinary(file)
                            : await this.app.vault.read(file);
                        let encoding: 'utf8' | 'binary' | 'base64' = isBinaryFile ? 'binary' : 'utf8';
                        let isCompressedText = false;

                        if (!isBinaryFile && this.settings.enableCompression) {
                            content = compressText(content as string);
                            encoding = 'binary';
                            isCompressedText = true;
                        }

                        if (typeof content === 'string') {
                            content = ObsidianDecentralizedPlugin.textEncoder.encode(content);
                            encoding = 'binary';
                        }

                        return {
                            path: file.path,
                            mtime: file.stat.mtime,
                            isCompressed: isCompressedText,
                            encoding,
                            content: content as ArrayBuffer
                        };
                    });

                    // A read failure has to abort the whole task, exactly as it did when
                    // these reads were awaited inline. The finally block reports every path
                    // in the task to the batch, so swallowing one file's error here would
                    // mark it delivered and the peer would drop it from its pending pulls —
                    // the sync would then claim success with the file missing on both sides.
                    const packedFiles: PackedFile[] = [];
                    for (const result of settled) {
                        if (result.status === 'rejected') throw result.reason;
                        if (result.value) packedFiles.push(result.value);
                    }
                    if (packedFiles.length > 0) {
                        item.data = {
                            type: 'file-batch-binary',
                            batchId: task.batchId,
                            transferId: this.generateTransferId('batch-' + task.batchId),
                            data: packFilesToTLV(packedFiles)
                        };
                    } else {
                        // Not one file in the batch could be read, so nothing goes out. Same
                        // reasoning as above: report the failure so the paths are re-authorized
                        // for another attempt instead of being marked delivered.
                        this.log(`Batch ${task.batchId} packed no files; reporting it as failed.`);
                        return;
                    }
                }
            }
            
            const data = item.data;
            if (!data) {
                // item.data is nulled once a send completes or fails permanently, so reaching
                // here means the item was re-entered with nothing left to send. Not retryable;
                // the `finally` below reports it to the batch so it does not hang.
                this.log(`Queue item for ${item.peerId || 'broadcast'} has no payload; treating as failed.`);
                return;
            }
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
                    // No peers right now (e.g. queue restored from disk before connections
                    // came up). Don't discard silently — park in failedSyncs so
                    // retryFailedSyncs() re-sends once a peer reconnects.
                    if (data.type === 'file-update' || data.type === 'file-delta') {
                        const existing = this.failedSyncs.find(f => f.path === data.path && !f.peerId);
                        if (!existing) {
                            this.failedSyncs.push({
                                path: data.path,
                                peerId: null,
                                timestamp: Date.now(),
                                type: data.type,
                                reason: 'No peers connected',
                                retryCount: 0
                            });
                            this.scheduleStateSave();
                        }
                    }
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
                    const ackPromise = this.expectAck(transferId, peerId, 300000);

                    // file-chunk-start.fileHash must describe the bytes actually on the
                    // wire. fileData.fileHash is the hash of the ORIGINAL content, which
                    // only matches the wire bytes when the body was not compressed.
                    const wireHash = fileData.compressed ? undefined : fileData.fileHash;
                    await this.sendFileInChunks(peerId, fileData.path, fileData.mtime, fileData.content as ArrayBuffer, transferId!, 0, fileData.compressed, fileData.versionVector, wireHash);
                    await ackPromise;
                    this.log(`Chunked transfer ${transferId} for ${fileData.path} completed successfully.`);
                    
                    // Dereference to allow GC
                    fileData.content = null as any;
                    item.data = null as any;
                }
            } else {
                const finalPayload = peerId ? await this.toWire(peerId, data) : data;

                const isBatchItem = item.task && (item.task as any).batchId;
                const isSmallFile = (data.type === 'file-update' || data.type === 'file-delta');
                const isDirectIp = this.getConnectionMode() === 'direct-ip';
                const skipAck = (isBatchItem && isSmallFile && isDirectIp) || data.type === 'file-batch-binary';

                if (isSmallFile && peerId && !skipAck) {
                    const ackPromise = this.expectAck(transferId!, peerId, 60000);

                    await this.sendPayloadTo(peerId, finalPayload);
                    await ackPromise;

                    if (data.type === 'file-update') {
                        (data as FileUpdatePayload).content = null as any;
                        item.data = null as any;
                    }
                } else if (skipAck && peerId) {
                    // Batch transfer: fire-and-forget, batch-complete handles reliability
                    await this.sendPayloadTo(peerId, finalPayload);

                    if (data.type === 'file-update' || data.type === 'file-batch-binary') {
                        (data as any).content = null;
                        (data as any).data = null;
                        item.data = null as any;
                    }
                } else if (peerId) {
                    await this.sendPayloadTo(peerId, finalPayload);
                } else if (isDirectIp) {
                    // Untargeted broadcast over direct-IP.
                    if (this.directIpClient) this.directIpClient.send(finalPayload);
                    else if (this.directIpServer) this.directIpServer.send(finalPayload);
                } else {
                    // Untargeted broadcast over PeerJS: encrypt per peer with that peer's
                    // key. This was a forEach with an async callback, so encryption
                    // failures surfaced as unhandled rejections and the sends raced.
                    for (const pId of Array.from(this.connections.keys())) {
                        try {
                            await this.sendPayloadTo(pId, await this.toWire(pId, data));
                        } catch (e) {
                            this.log(`Broadcast to ${pId} failed`, e);
                        }
                    }
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
                    // A full resend has been queued in place of the bad delta, so this item
                    // is finished — retrying it would send the same broken delta again.
                    const file = this.app.vault.getAbstractFileByPath(item.data.path);
                    if (file instanceof TFile) {
                        this.sendFileUpdate(file, item.peerId || undefined, true);
                    }
                    return;
                } else {
                    this.log(`Re-queueing.`);
                    item.retryable = true;
                }
            } else if (this.unloaded) {
                // Work cut short by unloading is saved as paused and resumed next time.
                return;
            } else {
                console.error(`Error processing queue item ${transferId}:`, e);
                item.retryable = true;
            }
            
            // QueueManager handles the retry backoff safely now.
            // We just need to record permanently failed syncs.
            if (item && item.retries >= 3) {
                const taskPath = item.task ? (item.task.taskType === 'send-rename' ? item.task.newPath : (item.task.taskType === 'send-file-batch' ? item.task.paths[0] : item.task.path)) : undefined;
                const path = item.data?.path || taskPath || 'an item';
                this.showNotice(`Could not transfer ${path}. Check the connection and try again.`, 'error', 8000);
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
                    this.scheduleStateSave();
                }
                // Dereference
                if (item.data && item.data.type === 'file-update') item.data.content = null;
                item.data = null;
            }
        } finally {
            let isFinal = false;
            if (success) {
                isFinal = true;
            } else if (!isPaused && (!item || !item.retryable || item.retries >= 3)) {
                // Either nothing will retry this, or the retries are exhausted. Either way it
                // is the last word on the item, so the batch has to hear about the failure now
                // — otherwise sentCount never reaches totalCount and the peer waits out the
                // full BATCH_TIMEOUT.
                isFinal = true;
            }

            if (transferId && !isPaused) {
                this.reportTransferResult(success);
                
                if (success) {
                    const taskPath = item.task ? (item.task.taskType === 'send-rename' ? item.task.newPath : (item.task.taskType === 'send-file-batch' ? item.task.paths[0] : item.task.path)) : undefined;
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
                this.scheduleStateSave();
            }

            if (isFinal && item.task && (item.task as any).batchId) {
                const t: any = item.task;
                // Report EVERY path the task covered, not just the first one
                const batchPaths: string[] = t.taskType === 'send-file-batch' ? t.paths : (t.path ? [t.path] : (t.newPath ? [t.newPath] : []));
                this.recordBatchTaskCompletion(t.batchId, batchPaths, success);
            }

            this.updateStatus();
        }
    }

    /**
     * Register a waiter for the peer's ack of `transferId`, failing after `timeoutMs`.
     *
     * The promise is created before the send it waits for, so if the send itself throws (the
     * link dropped mid-file) nothing ever awaits it — and the close handler then rejects it,
     * which surfaced as an "Uncaught (in promise)" error on every interrupted transfer. The
     * rejection is marked handled here; awaiting the returned promise still throws.
     */
    private expectAck(transferId: string, peerId: string, timeoutMs: number): Promise<void> {
        const ack = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingAcks.delete(transferId);
                reject(new Error(`Transfer ${transferId} timed out`));
            }, timeoutMs);
            this.pendingAcks.set(transferId, {
                resolve: () => { clearTimeout(timeout); resolve(); },
                reject: (e) => { clearTimeout(timeout); reject(e); },
                peerId,
            });
        });
        ack.catch(() => { /* observed by whoever awaits it, if anyone still does */ });
        return ack;
    }

    rejectPendingAck(transferId: string, reason: string) {
        if (this.pendingAcks.has(transferId)) {
            this.pendingAcks.get(transferId)!.reject(new Error(reason));
            this.pendingAcks.delete(transferId);
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
        if (changed) this.scheduleStateSave();
    }

    public reinitializeConnectionManager() {
        if (this.peerInitRetryTimeout) { clearTimeout(this.peerInitRetryTimeout); this.peerInitRetryTimeout = null; }
        if (this.clusterConnectionInterval) { clearInterval(this.clusterConnectionInterval); this.clusterConnectionInterval = null; }
        this.destroyPeer();
        this.directIpClient?.stop();
        this.directIpServer?.stop();
        this.directIpClient = null;
        this.directIpServer = null;
        this.connections.clear();
        this.settleTransfersAfterDisconnect();
        this.initializeConnectionManager();
    }

    /**
     * After links drop: keep interrupted uploads as paused records, so the file is sent again
     * when that device is back, and drop downloads, which cannot continue without their sender.
     * Clearing everything here used to discard the only record of what a peer still needed.
     */
    private settleTransfersAfterDisconnect(peerId?: string) {
        for (const [id, transfer] of this.activeTransfers) {
            if (peerId !== undefined && transfer.peerId !== peerId) continue;
            if (transfer.direction === 'upload') {
                transfer.status = 'paused';
                transfer.lastUpdate = Date.now();
            } else {
                this.activeTransfers.delete(id);
                // Release the preallocated reassembly buffer too. These were only ever
                // reclaimed by the five-minute sweeper, so a peer that connected and dropped
                // repeatedly could pin gigabytes of memory.
                this.pendingFileChunks.delete(id);
            }
        }
    }

    initializeConnectionManager(onOpen?: (id: string) => void) {
        if (this.unloaded) return;
        if (this.peerInitRetryTimeout) { clearTimeout(this.peerInitRetryTimeout); this.peerInitRetryTimeout = null; }

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

    /**
     * Tear down the current Peer so that none of its events can act on the plugin again.
     *
     * `this.peer` is cleared BEFORE destroy(). PeerJS's destroy() first runs disconnect(),
     * which emits 'disconnected' while `destroyed` is still false; our handler answered that
     * with reconnect(), which reopens the signalling socket — and destroy() never closes it
     * again. The orphaned socket kept this device's ID registered, so the next Peer (after a
     * mode switch, a re-enable or a plugin update) was refused with unavailable-id until
     * Obsidian restarted. Every handler now ignores events from a Peer that is not current.
     */
    private destroyPeer() {
        const peer = this.peer;
        this.peer = null;
        if (this.peerOpenTimeout !== null) { window.clearTimeout(this.peerOpenTimeout); this.peerOpenTimeout = null; }
        if (this.peerReconnectFallbackTimeout !== null) { window.clearTimeout(this.peerReconnectFallbackTimeout); this.peerReconnectFallbackTimeout = null; }
        if (!peer) return;
        try {
            peer.destroy();
        } catch (e) {
            this.log('Destroying the PeerJS peer threw', e);
        }
    }

    initializePeer(onOpen?: (id: string) => void) {
        if (this.unloaded) return;
        if (this.peer && !this.peer.destroyed) {
            if (this.peer.disconnected) {
                // A disconnected (but not destroyed) peer can be revived without a full re-init.
                // Previously this branch silently did nothing, leaving sync offline after a
                // network change until the user reloaded the plugin.
                this.log('initializePeer: reviving disconnected peer via reconnect().');
                this.peer.reconnect();
            } else if (onOpen) {
                onOpen(this.peer.id);
            }
            return;
        }
        if (this.peerInitRetryTimeout) { clearTimeout(this.peerInitRetryTimeout); this.peerInitRetryTimeout = null; }
        this.destroyPeer();
        this.updateStatus({ text: 'Connecting...', icon: 'plug', spin: true, state: 'loading' });

        let peerOptions: PeerJSOption = {};
        if (this.settings.useCustomPeerServer) { peerOptions = { ...this.settings.customPeerServerConfig }; }

        this.log(`Attempting to connect to PeerJS server (Attempt: ${this.peerInitAttempts + 1})...`);
        let peer: Peer;
        try {
            peer = new Peer(this.settings.deviceId, peerOptions);
        } catch (e) {
            this.handlePeerError(e);
            return;
        }
        this.peer = peer;
        // A replaced or destroyed Peer keeps firing events (destroy() itself emits two);
        // none of them may touch the plugin's current state.
        const isCurrent = () => this.peer === peer && !this.unloaded;

        this.peerOpenTimeout = window.setTimeout(() => {
            this.peerOpenTimeout = null;
            if (!isCurrent() || peer.open) return;
            this.log('PeerJS connection timed out.');
            this.handlePeerError(new Error("Connection timed out"));
        }, 15000);

        peer.on('open', (id) => {
            if (!isCurrent()) return;
            if (this.peerOpenTimeout !== null) { window.clearTimeout(this.peerOpenTimeout); this.peerOpenTimeout = null; }
            // Cancel the reconnect fallback timer now that the peer is back online.
            if (this.peerReconnectFallbackTimeout !== null) {
                clearTimeout(this.peerReconnectFallbackTimeout);
                this.peerReconnectFallbackTimeout = null;
            }
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

        peer.on('connection', (conn) => {
            if (!isCurrent()) {
                conn.close();
                return;
            }
            this.log("Incoming PeerJS connection from:", conn.peer);
            this.setupConnection(conn);
        });
        peer.on('error', (err) => {
            if (!isCurrent()) return;
            this.handlePeerError(err);
        });
        peer.on('disconnected', () => {
            if (!isCurrent() || peer.destroyed) return;
            this.showNotice('Sync network disconnected. Attempting to reconnect...', 'transient');
            this.updateStatus({ text: 'Reconnecting...', icon: 'plug', spin: true, state: 'loading' });
            // Attempt lightweight reconnect first
            try {
                peer.reconnect();
            } catch (e) {
                this.log('PeerJS reconnect() refused', e);
                this.handlePeerError(e);
                return;
            }
            // Arm a fallback in case peer.reconnect() stalls silently
            if (this.peerReconnectFallbackTimeout !== null) clearTimeout(this.peerReconnectFallbackTimeout);
            this.peerReconnectFallbackTimeout = window.setTimeout(() => {
                this.peerReconnectFallbackTimeout = null;
                // If still disconnected after the window, fall through to full re-init
                if (isCurrent() && peer.disconnected) {
                    this.log('PeerJS reconnect() stalled — falling back to full re-initialization.');
                    this.handlePeerError(new Error('Reconnect timed out'));
                }
            }, 15000);
        });
        peer.on('close', () => {
            if (!isCurrent()) return;
            this.showNotice('Sync connection closed permanently.', 'transient');
            this.handlePeerError(new Error("Peer closed."));
        });
    }

    private handlePeerError(err: any) {
        if (this.unloaded) return;
        // A cluster member that is simply offline surfaces as peer-unavailable every retry
        // cycle; it is routine, so it stays out of the error console.
        if (err?.type === 'peer-unavailable') this.log('PeerJS:', err?.message || err);
        else console.error("PeerJS Error:", err);

        if (!shouldTearDownPeer(err || {}, this.connections.size)) {
            this.log(`PeerJS error (${err?.type || err?.message || 'unknown'}) — keeping ${this.connections.size} live link(s).`);
            // Signaling dropped but WebRTC may still be up. Rejoin the server without
            // destroying existing DataConnections (that is what flipped status to Sync Offline).
            if ((err?.type === 'network' || err?.type === 'disconnected')
                && this.peer && !this.peer.destroyed && this.peer.disconnected) {
                this.peer.reconnect();
            }
            return;
        }

        this.destroyPeer();
        this.connections.forEach(conn => conn.close());
        this.connections.clear();
        this.settleTransfersAfterDisconnect();

        this.updateStatus({ text: peerErrorUserMessage(err), icon: 'alert-triangle', state: 'error' });

        // The old copy told people to generate an ID in settings, but no such control
        // existed — a copied vault retried forever with no way out.
        if (err?.type === 'unavailable-id' && this.peerInitAttempts === 0) {
            this.showNotice('This device ID is already in use — usually because this vault was copied from another computer. Open Settings and tap New ID on this device, then pair again.', 'warning', 12000);
        }

        this.peerInitAttempts++;
        const backoff = Math.min(30000, this.peerInitAttempts * 2000);
        this.showNotice(`Sync connection failed. Retrying in ${backoff / 1000}s...`, 'transient');

        if (this.peerInitRetryTimeout) clearTimeout(this.peerInitRetryTimeout);
        this.peerInitRetryTimeout = window.setTimeout(() => {
            this.peerInitRetryTimeout = null;
            if (this.unloaded) return;
            this.updateStatus({ text: 'Retrying connection...', icon: 'refresh-cw', spin: true, state: 'loading' });
            this.initializePeer();
        }, backoff);
    }

    setupConnection(conn: DataConnection, pin?: string) {
        this.pendingConnections.add(conn.peer);
        conn.on('open', () => {
            this.pendingConnections.delete(conn.peer);
            this.log("DataConnection open with:", conn.peer);
            // Role announcement and resuming interrupted uploads wait for handleHandshake, once
            // the connection is registered and the peer has proved who it is.
            void this.sendHandshake(conn, pin);
        });
        // Decryption is asynchronous, so messages handled independently can finish out of
        // order: a file-chunk-data that overtakes its file-chunk-start is dropped as unknown,
        // and the transfer never completes. Each message waits for the previous one from this
        // connection. Only decrypt-and-dispatch is serialised — processIncomingData runs
        // detached, so a slow handler does not hold up pings.
        let inbound: Promise<void> = Promise.resolve();
        conn.on('data', (raw: any) => {
            inbound = inbound
                .then(() => this.handleRawIncomingData(raw, conn))
                .catch(e => this.log("Unhandled error in incoming data listener", e));
        });
        conn.on('close', () => {
            const peerId = conn.peer;
            if (this.unloaded) return;
            if (this.connections.get(peerId) !== conn) {
                // A connection that never finished its handshake, or a duplicate that lost the
                // tie-break. Tearing down per-peer state here used to knock out the live link
                // to the same device — the one that is still in `connections`.
                if (!this.connections.has(peerId)) this.pendingConnections.delete(peerId);
                this.log(`Closed a non-current connection with ${peerId}.`);
                return;
            }
            this.pendingConnections.delete(peerId);
            this.log("DataConnection closed with:", peerId);
            this.connections.delete(peerId);
            this.lastHeard.delete(peerId);
            this.manualPingStart.delete(peerId);
            this.lastSuccessfulMessageTime.delete(peerId);

            // Clear remote locks from this peer
            for (const [path, lock] of this.remoteLocks.entries()) {
                if (lock.peerId === peerId) this.remoteLocks.delete(path);
            }

            this.settleTransfersAfterDisconnect(peerId);
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
                this.showNotice(`Paired Device disconnected. Will try to reconnect automatically.`, 'transient');
            }
            this.log("Connection closed, ensuring connection attempts continue.");
            this.tryToConnectToClusterPeers();
        });
        conn.on('error', (err) => { 
            this.pendingConnections.delete(conn.peer);
            console.error(`Connection error with ${conn.peer}:`, err); 
            this.showNotice(`Connection error with a peer.`, 'transient'); 
        });
    }

    /**
     * Introduce this device on `conn`: encrypted whenever a key applies, and never downgraded.
     * We hold a key for this peer, so a plaintext handshake is exactly what its receive-side
     * gate refuses — and what an impersonator would send.
     */
    private async sendHandshake(conn: DataConnection, pin?: string) {
        const payload = { type: 'handshake', peerInfo: this.getMyPeerInfo(), pin, protocolVersion: PROTOCOL_VERSION };
        if (!this.peerKeyFor(conn.peer)) {
            conn.send(payload);
            return;
        }
        try {
            // encryptPayload already returns the wire envelope { type:'encrypted-frame', data };
            // wrapping it again produces a payload the receiver can never decrypt.
            conn.send(await this.encryptPayload(payload, conn.peer));
        } catch (e) {
            this.log("Failed to encrypt handshake; closing connection instead of sending it in the clear", e);
            this.showNotice('Could not encrypt the connection to a paired device. Try re-pairing it.', 'error');
            conn.close();
        }
    }

    async handleRawIncomingData(raw: any, conn: DataConnection) {
        let data = raw;
        let wasEncrypted = false;

        // A 2.x peer sends the old base64-in-JSON envelope. It is unreadable here and
        // the version gate in handleHandshake cannot fire (the handshake itself may be
        // encrypted), so name the cause instead of silently dropping every message.
        if (raw && raw.type === 'encrypted') {
            this.showNotice(
                'Update Obsidian Decentralized on the other device to the same version.',
                'error', 10000
            );
            conn.close();
            return;
        }

        if (raw && raw.type === 'encrypted-frame') {
            if (this.peerKeyFor(conn.peer)) {
                try {
                    data = await this.decryptPayload(raw, conn.peer);
                } catch(e) {
                    this.log("Decryption failed, ignoring message", e);
                    return;
                }
            } else if (this.getConnectionMode() === 'peerjs' && this.getActivePsk()) {
                // A peer pairing via the active QR code has no stored key yet. Adopt the
                // active PSK provisionally, and roll it back if it does not decrypt.
                // getActivePsk() returns null once the pairing window has closed.
                this.settings.peerKeys[conn.peer] = this.getActivePsk()!;
                this.invalidateCryptoKey(conn.peer);
                try {
                    data = await this.decryptPayload(raw, conn.peer);
                    this.unblockPeer(conn.peer);
                    await this.saveSettings();
                    this.log(`Successfully authenticated new peer ${conn.peer} via active PSK`);
                    // Our own handshake went out when the link opened — in plaintext, since we
                    // had no key yet — and the pairing device, which does hold the key, refused
                    // it. Without a second, encrypted one it never registered this link, and
                    // its Connect screen reported a failed pairing.
                    void this.sendHandshake(conn);
                } catch(e) {
                    delete this.settings.peerKeys[conn.peer];
                    this.invalidateCryptoKey(conn.peer);
                    this.log("Received encrypted message but no PSK found for peer, and active PSK failed", conn.peer);
                    return;
                }
            } else {
                this.log("Received encrypted message but no PSK found for peer", conn.peer);
                return;
            }
            wasEncrypted = true;
        }

        // Encryption used to be opportunistic on receive: anything that simply wasn't an
        // encrypted-frame fell through and was processed as trusted, so a peer could skip the
        // envelope entirely rather than needing the key. Reject plaintext from any peer we
        // hold a key for.
        if (!wasEncrypted && this.peerKeyFor(conn.peer)) {
            this.log(`Refusing unencrypted ${raw?.type} from ${conn.peer}, which has an encryption key.`);
            // One plaintext handshake is expected while pairing: the other device sends it
            // before it has adopted the key, then repeats it encrypted. Warn about anything else.
            if (raw?.type !== 'handshake') {
                this.showNotice('Refused an unencrypted message from a paired device. If this repeats, re-pair the devices.', 'warning');
            }
            return;
        }

        // Under strict security the handshake is the only thing allowed before a key exists;
        // everything else from an unknown peer is dropped. Offline Mode is exempt: the host
        // has already checked the joining device's token, and its frames never carry a
        // pairing key.
        if (this.settings.strictSecurity && this.getConnectionMode() === 'peerjs' && !wasEncrypted && raw?.type !== 'handshake') {
            this.log(`Strict security: dropping ${raw?.type} from unauthenticated peer ${conn.peer}.`);
            return;
        }

        this.processIncomingData(data, conn);
    }
    
    /**
     * Re-send uploads to `peerId` that a dropped link or a restart interrupted.
     *
     * They restart from the first chunk, through the normal send path. Continuing mid-file
     * never worked: the receiver discards its partial reassembly when the link drops (and has
     * nothing at all after a restart), so the resumed chunks were rejected as belonging to an
     * unknown transfer — while the queue had already written the file off as sent.
     */
    resumeTransfers(peerId: string) {
        let resumed = 0;
        for (const [id, transfer] of this.activeTransfers) {
            if (transfer.peerId !== peerId || transfer.direction !== 'upload' || transfer.status !== 'paused') continue;
            this.activeTransfers.delete(id);
            const file = this.app.vault.getAbstractFileByPath(transfer.path);
            if (file instanceof TFile) {
                void this.sendFileUpdate(file, peerId, true);
                resumed++;
            }
        }
        if (resumed > 0) this.log(`Re-sending ${resumed} interrupted upload(s) to ${peerId}.`);
        this.scheduleStateSave();
        this.updateStatus();
    }

    startHeartbeat() {
        this.registerInterval(window.setInterval(() => this.heartbeatTick(), 5000));
    }

    /** One heartbeat round: ping every open link and drop any that has gone silent for 20 s. */
    heartbeatTick() {
        const now = Date.now();
        this.connections.forEach((conn, peerId) => {
            if (conn.open) {
                // Direct, bypassing the sync queue, but encrypted like everything else.
                this.sendDirect(conn, { type: 'ping' });
                const last = this.lastHeard.get(peerId);
                if (last && now - last > 20000) {
                    this.log(`Peer ${peerId} timed out (Heartbeat).`);
                    conn.close();
                }
            }
        });
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
                if (conn && conn.open) this.sendDirect(conn, { type: 'sync-ping' });
            } else {
                if (this.syncKeepAliveInterval) { clearInterval(this.syncKeepAliveInterval); this.syncKeepAliveInterval = null; }
            }
        }, 10000);
    }

    async processIncomingData(data: any, conn: DataConnection | null) {
        if (!data || !data.type) return;
        // Unwrap deflated sync control messages (see sendSyncMessage for why)
        if (data.type === 'sync-control-binary' && data.data) {
            try {
                // decompressText reads a view in place; the copy this used to make was a
                // full duplicate of every manifest, which is the largest control message.
                data = JSON.parse(decompressText(data.data));
            } catch (e) { this.log('Failed to decode sync-control-binary payload:', e); return; }
        }
        this.log("Received data:", data.type, "from", conn?.peer);
        if (conn?.peer) {
            this.lastHeard.set(conn.peer, Date.now());
            this.lastSuccessfulMessageTime.set(conn.peer, Date.now());
        }

        if (data.messageId && data.type !== 'sync-ack' && conn) {
            this.sendDirect(conn, { type: 'sync-ack', messageId: data.messageId });
            // Dedup: sendSyncMessage retries after 30s even if the first copy was merely
            // slow — re-processing a control message (e.g. request-batch) corrupts sync
            // state, so ack duplicates but process each messageId only once.
            if (this.processedMessageIds.has(data.messageId)) {
                this.log(`Ignoring duplicate delivery of ${data.type} (${data.messageId})`);
                return;
            }
            this.processedMessageIds.add(data.messageId);
            if (this.processedMessageIds.size > 500) {
                const oldest = this.processedMessageIds.values().next().value;
                if (oldest) this.processedMessageIds.delete(oldest);
            }
        }
        if (data.type === 'sync-ack') {
            const ack = this.pendingSyncAcks.get(data.messageId);
            if (ack) { ack.resolve(); this.pendingSyncAcks.delete(data.messageId); }
            return;
        }
        if (!this.canonicalizePeerPaths(data)) {
            this.log(`Dropping ${data.type} from ${conn?.peer}: it names an unsafe path.`);
            return;
        }
        
        try {
            switch (data.type) {
                case 'handshake': this.handleHandshake(data, conn!); break;
                // Retired with role-based conflict resolution; nothing on v4 sends it.
                case 'role-announcement': break;
                case 'cluster-gossip': this.handleClusterGossip(data); break;
                case 'companion-pair': void this.handleCompanionPair(data, conn); break;
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
                    this.applyFileUpdate(data, conn?.peer).then(() => {
                        if (conn && data.transferId && !data.skipAck) this.sendDirect(conn, { type: 'ack', transferId: data.transferId });
                        this.resetIdleTimeout();
                    }).catch(e => {
                        this.log(`Failed to apply file update: ${data.path}`, e);
                        if (conn && data.transferId && !data.skipAck) {
                            const reason = (e instanceof Error && e.message.includes('IntegrityError')) ? 'integrity-failure' : 'write-error';
                            this.sendDirect(conn, { type: 'nack', transferId: data.transferId, reason });
                        }
                    }); 
                    break;
                case 'file-batch-binary':
                    this.applyFileBatchBinary(data, conn?.peer).then((results) => {
                        this.resetIdleTimeout();
                        // NOTE: do NOT send 'batch-complete' from here. The batchId belongs to
                        // OUR pull batch — echoing it back would be misread by the sender's
                        // handleBatchComplete as completion of ITS OWN pull batch, corrupting
                        // its sync state. The sender emits the authoritative batch-complete
                        // via recordBatchTaskCompletion once all its tasks finish.
                        if (results.failed.length > 0) {
                            this.log(`Batch ${data.batchId}: failed to apply ${results.failed.length} file(s):`, results.failed);
                        }
                    }).catch(e => {
                        this.log(`Critical failure unpacking file batch`, e);
                    });
                    break;
                case 'file-delta':
                    this.applyFileDelta(data).then(() => {
                        if (conn && data.transferId) this.sendDirect(conn, { type: 'ack', transferId: data.transferId });
                        this.resetIdleTimeout();
                    }).catch(e => {
                        this.log(`Failed to apply delta: ${data.path}`, e);
                        if (conn && data.transferId) {
                            const reason = (e instanceof Error && e.message.includes('IntegrityError')) ? 'integrity-failure' : 'write-error';
                            this.sendDirect(conn, { type: 'nack', transferId: data.transferId, reason });
                        }
                    });
                    break;
                case 'file-delete':
                    // Unlike file-update and file-delta this had no error handling at all, so
                    // a failed delete surfaced only as an unhandled rejection.
                    this.applyFileDelete(data, conn?.peer).catch(e => {
                        this.log(`Failed to apply remote delete for ${data.path}`, e);
                        this.showNotice(`Could not delete ${data.path} — it may still exist on this device.`, 'error');
                    });
                    break;
                case 'file-rename': void this.applyFileRename(data, conn); break;
                case 'folder-create': this.applyFolderCreate(data); break;
                case 'folder-delete': this.applyFolderDelete(data); break;
                case 'folder-rename': this.applyFolderRename(data); break;
                
                // Pull-based Sync
                case 'request-full-sync': await this.handleFullSyncRequest(data, conn!); break;
                case 'sync-busy':
                    this.showNotice('The other device is already syncing. Try again in a moment.', 'important');
                    if (this.syncState.isSyncing) {
                        this.abortSync(new SyncError(SyncErrorCategory.CONNECTION_ERROR, 'The other device is already syncing.', true, 'Wait for it to finish, then try again.'));
                    }
                    break;
                case 'sync-plan': await this.handleSyncPlan(data, conn!); break;
                case 'request-batch': await this.handleRequestBatch(data, conn!); break;
                case 'batch-complete': this.handleBatchComplete(data, conn!); break;
                
                case 'full-sync-complete':
                    if (!this.syncState.isSyncing || this.syncState.peerId !== conn?.peer) break;
                    this.peerSyncComplete.set(conn.peer, true);
                    // The peer will request nothing more; what it never took is moot.
                    this.syncState.allowedPulls.clear();
                    this.checkFullSyncCompletion(conn.peer);
                    break;
                case 'request-file': this.handleRequestFile(data, conn!); break;
                case 'file-chunk-start': this.handleFileChunkStart(data, conn); break;
                case 'file-chunk-data': await this.handleFileChunkData(data, conn!); break;
                
                case 'ping': if (conn) this.sendDirect(conn, { type: 'pong' }); break;
                case 'pong': 
                    if (this.manualPingStart.has(conn!.peer)) {
                        const start = this.manualPingStart.get(conn!.peer)!;
                        const rtt = Date.now() - start;
                        this.manualPingStart.delete(conn!.peer);
                        this.showNotice(`${this.clusterPeers.get(conn!.peer)?.friendlyName || 'The other device'} replied in ${rtt} ms`, 'important');
                    }
                    break;
                case 'sync-ping': if (conn) this.sendDirect(conn, { type: 'sync-pong' }); this.resetIdleTimeout(); break;
                case 'sync-pong': this.syncState.missedPings = 0; this.resetIdleTimeout(); break;
                    
                case 'cluster-forget': this.handleClusterForget(data); break;
                case 'cluster-kick': this.handleClusterKick(data, conn!); break;
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

                // Obsidian settings
                case 'config-manifest': if (conn) void this.configSync.handleManifest(data, conn.peer).catch(e => this.log('Config sync failed', e)); break;
                case 'config-request': if (conn) void this.configSync.handleRequest(data, conn.peer).catch(e => this.log('Config sync failed', e)); break;
                case 'config-file': if (conn) void this.configSync.handleFile(data, conn.peer).catch(e => this.log('Config sync failed', e)); break;
                case 'config-delete': if (conn) void this.configSync.handleDelete(data, conn.peer).catch(e => this.log('Config sync failed', e)); break;
            }
        } catch (e) {
            this.log(`Error processing incoming data (type: ${data.type}):`, e);
            if (this.syncState.isSyncing && (data.type === 'request-full-sync' || data.type === 'sync-plan' || data.type === 'request-batch')) {
                this.abortSync(new SyncError(SyncErrorCategory.PROTOCOL_ERROR, `Sync protocol error: ${e instanceof Error ? e.message : String(e)}`, false, "Check logs."));
            }
        }
    }

    /**
     * Rewrite a peer message's path fields to canonical vault paths, once, before any handler
     * sees them. The scope checks normalised a copy while the vault calls used the raw
     * string, so `./a//b.md` passed as `a/b.md` but was written as given. Returns false when a
     * path is unusable (absolute, `..`, NUL, ...).
     */
    private canonicalizePeerPaths(data: any): boolean {
        // Version vectors from a peer are merged into our own state; one with non-numeric or
        // absurd counts would poison every later comparison for that file.
        if ('versionVector' in data) data.versionVector = sanitizeVersionVector(data.versionVector);
        if ('deletedAt' in data && !(typeof data.deletedAt === 'number' && Number.isFinite(data.deletedAt))) delete data.deletedAt;
        for (const field of ['path', 'oldPath', 'newPath']) {
            const value = data[field];
            if (value === undefined) continue;
            // Merkle traversal names the vault root with an empty path.
            if (field === 'path' && value === '' && (data.type === 'merkle-node-request' || data.type === 'merkle-node-response')) continue;
            const safe = sanitizeVaultPath(value);
            if (safe === null) return false;
            data[field] = safe;
        }
        return true;
    }

    handleHandshake(data: HandshakePayload, conn: DataConnection) {
        const peerInfo = sanitizePeerInfo(data.peerInfo);
        if (!peerInfo) {
            this.log(`Rejecting handshake from ${conn.peer}: missing or malformed device info.`);
            conn.close();
            return;
        }
        // Over PeerJS the connection itself says who dialled; a handshake claiming another
        // ID would file this device's details under someone else's entry.
        if (this.getConnectionMode() === 'peerjs') peerInfo.deviceId = conn.peer;

        // Refuse mismatched versions up front — letting them through would mean silently
        // dropped messages at best and a half-applied sync at worst.
        const theirVersion = typeof data.protocolVersion === 'number' ? data.protocolVersion : 0;
        if (theirVersion !== PROTOCOL_VERSION) {
            this.refuseIncompatiblePeer(conn, peerInfo.friendlyName, theirVersion);
            return;
        }
        // Strict security: only peers we already share a key with, or one arriving during an
        // open pairing window, may connect. Off by default because it locks out devices that
        // were paired by bare device ID. (This replaces a PIN gate that could never fire:
        // joinPin was only ever null, so both of its branches were unreachable.)
        if (this.isBlocked(conn.peer)) {
            this.log(`Ignoring handshake from removed device ${conn.peer}`);
            conn.close();
            return;
        }
        if (this.settings.strictSecurity
            && this.getConnectionMode() === 'peerjs'
            && !this.settings.peerKeys[conn.peer]
            && !this.getActivePsk()) {
            this.showNotice(
                `Refused a connection from ${data.peerInfo?.friendlyName || 'an unknown device'}: it is not paired with this vault. Open the Connect screen on both devices to pair.`,
                'warning', 10000
            );
            this.log(`Strict security: rejecting unpaired peer ${conn.peer}`);
            conn.close();
            return;
        }
        const existing = this.connections.get(conn.peer);
        if (this.getConnectionMode() === 'peerjs' && existing && existing !== conn && existing.open) {
            // Two links to the same device. Each end must keep the SAME one, or each closes
            // the link the other kept. Overwriting the map entry (as this used to) left an
            // orphan whose later close took the live link down.
            //  - Glare (each side dialled one): keep the link dialled by the lower device ID.
            //  - A re-dial (one side dialled both, e.g. pairing again): keep the newer link.
            //    Both ends see the two handshakes in the same order, so both keep this one.
            const lowerIsMe = this.settings.deviceId < conn.peer;
            const dialledThis = this.dialledConnections.has(conn);
            const keepThis = dialledThis === this.dialledConnections.has(existing)
                ? true
                : dialledThis === lowerIsMe;
            if (!keepThis) {
                this.log(`Duplicate connection with ${conn.peer}; keeping the existing one.`);
                conn.close();
                return;
            }
            this.log(`Duplicate connection with ${conn.peer}; replacing the existing one.`);
            // Swap first so the old link's close handler sees it is no longer current.
            this.connections.set(conn.peer, conn);
            existing.close();
        }
        this.showNotice(`Connected to ${peerInfo.friendlyName}`, 'important', 4000);
        this.incompatiblePeers.delete(conn.peer);
        this.lastHeard.set(conn.peer, Date.now());
        this.connections.set(conn.peer, conn);
        this.clusterPeers.set(conn.peer, peerInfo);
        this.updateStatus();
        this.saveKnownPeers();
        const existingPeers = Array.from(this.clusterPeers.values());
        
        if (this.getConnectionMode() === 'direct-ip') {
            if (!data.isResponse) {
                this.sendData(conn.peer, { type: 'handshake', peerInfo: this.getMyPeerInfo(), isResponse: true, protocolVersion: PROTOCOL_VERSION } as any);
            }
        } else {
            this.sendData(conn.peer, { type: 'cluster-gossip', peers: existingPeers.map(persistablePeerInfo) });
            this.broadcastData({ type: 'cluster-gossip', peers: [persistablePeerInfo(this.getMyPeerInfo()), peerInfo] });
        }
        
        // Auto-reconciliation: a cheap Merkle-root exchange on every (re)connection, so
        // changes made while two devices were apart reach each other and any conflict is
        // settled by the usual rule. This used to run only while exactly one device was
        // connected, so in a group of three, two devices that had been apart never compared
        // notes. The device with the lower ID starts, so each pair runs one exchange.
        if (this.settings.enableTwoDeviceOptimizations && this.getMyRole(conn.peer) === 'primary' && !this.syncState.isSyncing) {
            this.getMerkleTree()
                .then(tree => this.sendData(conn.peer, { type: 'merkle-root', rootHash: tree.hash }))
                .catch(e => this.log('Failed to build Merkle tree for auto-reconciliation', e));
        }

        this.resumeTransfers(conn.peer);
        void this.configSync.onPeerConnected(conn.peer).catch(e => this.log('Config sync failed', e));
    }

    /**
     * Peers whose handshake carried a different protocol version, with when to try them again.
     * A refused peer redials every few seconds; without this each attempt ended in another
     * error toast here, and our own reconnect loop kept dialling it too.
     */
    private incompatiblePeers: Map<string, number> = new Map();
    private static readonly INCOMPATIBLE_RETRY_MS = 10 * 60 * 1000;

    private refuseIncompatiblePeer(conn: DataConnection, name: string, theirVersion: number) {
        const firstTime = !this.incompatiblePeers.has(conn.peer);
        this.incompatiblePeers.set(conn.peer, Date.now() + ObsidianDecentralizedPlugin.INCOMPATIBLE_RETRY_MS);
        this.log(`Rejecting handshake from ${conn.peer}: protocol v${theirVersion || 'unknown'} (expected v${PROTOCOL_VERSION})`);
        if (firstTime) {
            const which = theirVersion > PROTOCOL_VERSION ? 'this device' : name;
            this.showNotice(
                `${name} runs a different version of Obsidian Decentralized. Update the plugin on ${which} so both match, then they will reconnect.`,
                'error', 12000
            );
        }
        conn.close();
    }

    handleClusterGossip(data: ClusterGossipPayload) {
        if (this.getConnectionMode() !== 'peerjs' || !Array.isArray(data.peers)) return;
        let hasNew = false;
        for (const raw of data.peers.slice(0, 256)) {
            const peerInfo = sanitizePeerInfo(raw);
            if (!peerInfo) continue;
            if (peerInfo.deviceId === this.settings.deviceId || this.connections.has(peerInfo.deviceId)) continue;
            if (this.isBlocked(peerInfo.deviceId)) continue;
            if (!this.clusterPeers.has(peerInfo.deviceId)) {
                this.clusterPeers.set(peerInfo.deviceId, peerInfo);
                hasNew = true;
            }
        }
        if (hasNew) {
            this.saveKnownPeers();
            this.updateStatus();
            this.tryToConnectToClusterPeers();
        }
    }

    async handleCompanionPair(data: CompanionPairPayload, conn?: DataConnection | null) {
        const peerInfo = sanitizePeerInfo(data.peerInfo);
        if (!peerInfo) return;
        // Only the device on the other end of this link can make itself our partner.
        if (conn && this.getConnectionMode() === 'peerjs') peerInfo.deviceId = conn.peer;
        if (this.isBlocked(peerInfo.deviceId)) return;
        this.settings.companionPeerId = peerInfo.deviceId;
        await this.saveSettings();
        this.clusterPeers.set(peerInfo.deviceId, peerInfo);
        this.showNotice(`${peerInfo.friendlyName} is now your primary sync partner.`, 'important', 4000);
        this.tryToConnectToClusterPeers();
    }

    /** Connections this device dialled, as opposed to accepted; glare resolution needs it. */
    private dialledConnections = new WeakSet<object>();

    /**
     * Dial `peerId` and wire the connection up. Every outgoing connection goes through here
     * so handleHandshake can tell which side initiated each link.
     *
     * reliable:true is required — an unordered channel lets file-chunk-data overtake
     * file-chunk-start, permanently breaking large-file transfers.
     */
    public dialPeer(peerId: string): DataConnection | null {
        if (this.unloaded || !this.peer || this.peer.disconnected || this.peer.destroyed) return null;
        const conn = this.peer.connect(peerId, { reliable: true });
        if (!conn) return null;
        this.dialledConnections.add(conn);
        this.setupConnection(conn);
        return conn;
    }

    tryToConnectToClusterPeers() {
        if (this.unloaded || this.getConnectionMode() !== 'peerjs') return;

        const attemptConnection = () => {
            if (this.unloaded || !this.peer || this.peer.disconnected) return;

            const connectToPeer = (peerId: string) => {
                if (peerId === this.settings.deviceId) return;
                if (this.isBlocked(peerId)) return;
                if (this.connections.has(peerId) || this.pendingConnections.has(peerId)) return;
                const retryIncompatibleAt = this.incompatiblePeers.get(peerId);
                if (retryIncompatibleAt !== undefined && Date.now() < retryIncompatibleAt) return;

                this.log(`Attempting to connect to cluster peer ${peerId}`);
                this.pendingConnections.add(peerId);
                const conn = this.dialPeer(peerId);
                if (!conn) {
                    this.pendingConnections.delete(peerId);
                    return;
                }
                // An offline peer never answers, and PeerJS neither opens nor closes the
                // attempt. Give up on this one after 15 s so the next round can dial again,
                // and close it so PeerJS drops its negotiator instead of accumulating one per
                // retry.
                this.timeoutManager.setTimeout(() => {
                    if (conn.open || this.connections.get(peerId) === conn) return;
                    this.log(`Pending connection to ${peerId} timed out. Removing from pending set.`);
                    this.pendingConnections.delete(peerId);
                    try { conn.close(); } catch (_) { /* never opened */ }
                }, 15000);
            };

            const companionId = this.settings.companionPeerId;
            if (companionId) connectToPeer(companionId);

            for (const peerId of this.clusterPeers.keys()) {
                if (peerId !== companionId) connectToPeer(peerId);
            }
        };

        attemptConnection();
        if (!this.clusterConnectionInterval) {
            // Deliberately not registerInterval(): this one is torn down and recreated with the
            // connection manager, and onunload clears it explicitly.
            this.clusterConnectionInterval = window.setInterval(attemptConnection, COMPANION_RECONNECT_INTERVAL_MS);
        }
    }

    /**
     * Centralized handler for all network-change signals (Phase 3.2).
     * Triggered by: browser `online`/`offline` events, and the discovery
     * `network-change` event (emitted after the LAN multicast socket restarts).
     */
    private handleNetworkChange() {
        this.log('Network change detected — checking transports...');
        const mode = this.getConnectionMode();

        if (mode === 'peerjs') {
            if (!this.peer || this.peer.destroyed || this.peer.disconnected) {
                this.log('Network change: re-initializing PeerJS peer.');
                this.initializePeer();
            } else {
                // Peer is alive; just ensure cluster peers are reconnected
                this.tryToConnectToClusterPeers();
            }
        } else if (mode === 'direct-ip') {
            if (this.directIpClient) {
                this.log('Network change: triggering DirectIpClient reconnect.');
                this.directIpClient.triggerReconnect({ resetBackoff: true });
            }
        }
    }

    handleClusterForget(data: ClusterForgetPayload) {
        if (data.targetDeviceId === this.settings.deviceId) return;
        this.log(`Received instruction to forget device: ${data.targetDeviceId}`);
        void this.forgetDevice(data.targetDeviceId, { broadcast: false });
    }

    handleClusterKick(data: ClusterKickPayload, conn?: DataConnection) {
        if (data.targetDeviceId === this.settings.deviceId) {
            const name = conn
                ? (this.clusterPeers.get(conn.peer)?.friendlyName || 'Another device')
                : 'Another device';
            this.showNotice(`${name} removed this device from the group. Open Connect devices to pair again.`, 'warning', 10000);
            void this.leaveCluster();
            return;
        }
        void this.forgetDevice(data.targetDeviceId, { broadcast: false });
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

    private mintDeviceId(): string {
        return `device-${Array.from(window.crypto.getRandomValues(new Uint8Array(4))).map(b => b.toString(16).padStart(2, '0')).join('')}`;
    }

    /** New PeerJS identity after a vault copy collided with the original device. */
    public async resetDeviceIdentity(): Promise<void> {
        this.settings.deviceId = this.mintDeviceId();
        await this.saveSettings();
        this.reinitializeConnectionManager();
        this.showNotice('This device has a new ID. Open Connect devices on the other side and pair again.', 'important', 8000);
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

    public isBlocked(deviceId: string): boolean {
        return !!this.settings.blockedPeers?.includes(deviceId);
    }

    /** Clear a Remove/Forget block so a new pairing can succeed. */
    public unblockPeer(deviceId: string): boolean {
        const list = this.settings.blockedPeers;
        if (!list?.length) return false;
        const next = list.filter(id => id !== deviceId);
        if (next.length === list.length) return false;
        this.settings.blockedPeers = next;
        return true;
    }

    /**
     * Drop a device from this vault's group. With broadcast (the default) every
     * connected member forgets it too. Kick tells that device it was removed.
     * Blocked IDs stay out of the list until the user pairs with them again —
     * otherwise handshake/gossip put them back within seconds.
     */
    public async forgetDevice(deviceId: string, opts?: { broadcast?: boolean; kick?: boolean }): Promise<void> {
        if (!deviceId || deviceId === this.settings.deviceId) return;
        if (opts?.kick) this.broadcastData({ type: 'cluster-kick', targetDeviceId: deviceId });
        if (opts?.broadcast !== false) this.broadcastData({ type: 'cluster-forget', targetDeviceId: deviceId });
        this.pendingConnections.delete(deviceId);
        this.connections.get(deviceId)?.close();
        this.connections.delete(deviceId);
        this.clusterPeers.delete(deviceId);
        // Paused uploads to it will never resume; left behind they held the status bar on
        // "Sync paused" for good.
        for (const [id, transfer] of this.activeTransfers) {
            if (transfer.peerId === deviceId) this.activeTransfers.delete(id);
        }
        this.scheduleStateSave();
        delete this.settings.peerKeys[deviceId];
        this.invalidateCryptoKey(deviceId);
        if (this.settings.companionPeerId === deviceId) this.settings.companionPeerId = undefined;
        if (!this.settings.blockedPeers) this.settings.blockedPeers = [];
        if (!this.settings.blockedPeers.includes(deviceId)) this.settings.blockedPeers.push(deviceId);
        await this.saveKnownPeers();
        this.updateStatus();
    }

    private async leaveCluster(): Promise<void> {
        const ids = Array.from(this.clusterPeers.keys());
        for (const id of ids) await this.forgetDevice(id, { broadcast: false });
    }

    private static textEncoder = new TextEncoder();
    private static textDecoder = new TextDecoder();
    private static hexTable: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

    private async getHash(buffer: ArrayBuffer | string): Promise<string> {
        const data = typeof buffer === 'string' ? ObsidianDecentralizedPlugin.textEncoder.encode(buffer) : buffer;
        const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
        const hashArray = new Uint8Array(hashBuffer);
        // Direct concat over the byte array. The previous Array.from(...).map(...).join('')
        // allocated two intermediate arrays per hash, and this runs once per file per sync.
        const hex = ObsidianDecentralizedPlugin.hexTable;
        let out = '';
        for (let i = 0; i < hashArray.length; i++) out += hex[hashArray[i]];
        return out;
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
            this.showNotice(`Another device is editing ${data.path.split('/').pop() || data.path}`, 'warning');
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
        this.showNotice(`Another device is editing ${data.path.split('/').pop() || data.path}`, 'info', 3000);
    }

    handleEditorDelta(data: EditorDeltaPayload) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view && view.file && view.file.path === data.path) {
            const cm = (view as any).editor?.cm;
            if (cm) {
                this.isApplyingRemoteEdit = true;
                this.ignoreNextEventForPath(data.path);
                
                const currentText = view.editor.getValue();
                // uses the shared module-level dmp instance
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

    async loadQueueState() {
        const items = await this.readJson(`${this.manifest.dir}/queue.json`);
        if (this.queueManager && Array.isArray(items)) {
            // Defensively drop anything without a task: an older build persisted 'data'
            // items whose ArrayBuffer bodies serialised to {}.
            this.queueManager.loadQueue(items.filter((i: any) => i && i.task && !i.data));
        }
    }

    async saveQueueState(force = false) {
        if (!this.queueManager) return;
        if (!force && !this.queueDirty) return;
        if (!force) {
            // Same reasoning as saveState: a sync enqueues and drains thousands of items,
            // and every one of them re-serialised the whole queue 2 s later. The file only
            // matters on restart, so during a sync it is written far less often.
            const minInterval = this.syncState.isSyncing ? 10000 : 0;
            if (minInterval && Date.now() - this.lastQueueSaveAt < minInterval) {
                this.debouncedSaveQueue();
                return;
            }
        }
        this.queueDirty = false;
        this.lastQueueSaveAt = Date.now();
        try {
            // Only 'task' items are persistable: they name a vault path and are re-derived
            // from the vault on replay. A built payload is dropped — it can hold an
            // ArrayBuffer, which JSON.stringify turns into {}, and reloading that produced
            // silently corrupt entries that could never be sent.
            const persistable = this.queueManager.getQueue()
                .filter(item => !!item.task)
                .map(({ data: _payload, retryable: _retryable, seq: _seq, ...task }) => task);
            await this.writeJsonAtomic(`${this.manifest.dir}/queue.json`, JSON.stringify(persistable));
        } catch (e) {
            console.error('Failed to save queue state:', e);
        }
    }

    async sendFileUpdate(file: TFile, peerId?: string, forceFull: boolean = false) {
        if (!this.isPathSyncable(file.path)) return;
        const isBinaryFile = this.isBinary(file.extension);
        if (isBinaryFile && !this.shouldSyncAllFileTypes()) { this.log(`Skipping binary file because 'syncAllFileTypes' is disabled: ${file.path}`); return; }
        if (!isBinaryFile && !this.shouldSyncAllFileTypes()) { if (!TEXT_WHITELIST.has(file.extension)) { this.log(`Skipping non-whitelisted text file: ${file.path}`); return; } }
        this.log(`Queueing file update for ${peerId || 'broadcast'}: ${file.path}`);
        
        this.addToQueueTask(peerId || null, { taskType: 'send-file', path: file.path, mtime: file.stat.mtime, forceFull });
    }

    /**
     * @param knownHash SHA-256 of fileContent if the caller already computed it.
     *   processQueueItem always has it, and re-digesting a multi-hundred-MB buffer
     *   here was a full redundant pass over the file.
     */
    async sendFileInChunks(peerId: string, path: string, mtime: number, fileContent: ArrayBuffer, transferId: string, startIndex = 0, compressed?: boolean, versionVector?: VersionVector, knownHash?: string) {
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
        
        const existingTransfer = this.activeTransfers.get(transferId);
        // A resumed transfer MUST keep its original chunk size. getChunkSize() adapts to
        // measured bandwidth, so recomputing it here made the sender re-chunk a partially
        // sent file at a different boundary than both the receiver's offsets and the
        // transfer's own recorded totalChunks.
        const chunkSize = existingTransfer?.chunkSize || this.getChunkSize();
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
        this.scheduleStateSave();

        const totalChunks = Math.ceil(fileContent.byteLength / chunkSize);
        this.log(`Sending file in ${totalChunks} chunks to ${peerId}: ${path} (ID: ${transferId})`);
        
        let chunkHash = knownHash || '';
        if (!chunkHash) {
            try { chunkHash = await this.getHash(fileContent); } catch(e) {}
        }

        const YIELD_THRESHOLD_MS = 100;
        let lastYieldTime = Date.now();
        const transferStartTime = Date.now();
        
        const encryptFor = !!this.peerKeyFor(peerId);

        if (startIndex === 0) {
            const startPayload: FileChunkStartPayload = { type: 'file-chunk-start', path, mtime, totalChunks, transferId, fileHash: chunkHash, compressed, versionVector, totalBytes: fileContent.byteLength, chunkSize };
            const encPayload = encryptFor ? await this.encryptPayload(startPayload, peerId) : startPayload;
            await this.sendPayloadTo(peerId, encPayload);
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
                    this.scheduleStateSave();
                    throw new Error("Paused");
                }
            } else if (!conn!.open) {
                this.log(`Connection to ${peerId} closed mid-transfer. Pausing.`);
                const t = this.activeTransfers.get(transferId);
                if (t) { t.status = 'paused'; t.lastUpdate = Date.now(); }
                this.updateStatus();
                this.scheduleStateSave();
                throw new Error("Paused");
            }
            try {
                const start = i * chunkSize;
                const end = Math.min(start + chunkSize, fileContent.byteLength);
                // When encrypting, a view suffices: the encrypt step copies into the
                // ciphertext anyway, so slicing here was a wasted copy of every chunk.
                // The plaintext path still needs a detached buffer, because the transport
                // serialises it asynchronously and must not observe a moving window.
                const chunk: ArrayBuffer | Uint8Array = encryptFor
                    ? new Uint8Array(fileContent, start, end - start)
                    : fileContent.slice(start, end);
                const chunkPayload: FileChunkDataPayload = { type: 'file-chunk-data', transferId, index: i, data: chunk };

                const encPayload: any = encryptFor ? await this.encryptPayload(chunkPayload, peerId) : chunkPayload;

                this.syncState.bytesTransferred += chunk.byteLength;

                // Larger high/low water marks than small messages: the chunk loop wants
                // to keep the pipe full rather than round-trip per chunk.
                if (isDirectIp) {
                    await this.sendPayloadTo(peerId, encPayload, 32 * 1024 * 1024, 16 * 1024 * 1024);
                } else {
                    await this.sendPayloadTo(peerId, encPayload, 16 * 1024 * 1024, 8 * 1024 * 1024);
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
                
                // No per-chunk state save: resumable progress is reconstructed from
                // activeTransfers, which is written whenever a transfer starts, pauses
                // or finishes. Saving inside the send loop rewrote state.json hundreds
                // of times per large file for no recovery benefit.
                this.resetIdleTimeout();
            } catch (e) {
                this.log(`Error sending chunk ${i} for ${path}. Aborting.`, e);
                throw e;
            }
        }
        this.recordTransferSample(fileContent.byteLength, Date.now() - transferStartTime);
        this.log(`Finished sending all chunks for ${path} to ${peerId}. Waiting for ack.`);
    }

    handleFileChunkStart(payload: FileChunkStartPayload, conn: DataConnection | null) {
        // Everything here is peer-supplied and drives a preallocation, so validate before
        // allocating anything.
        const MAX_REASSEMBLY_SIZE = 512 * 1024 * 1024;
        /** Concurrent inbound reassemblies. Each one holds a fully preallocated buffer. */
        const MAX_CONCURRENT_REASSEMBLIES = 16;

        if (!this.isPathSyncable(payload.path)) {
            this.log(`Rejecting chunked transfer for an out-of-scope path: ${payload.path}`);
            return;
        }

        const totalChunks = payload.totalChunks;
        // Integer check first: NaN and negatives both compare false against the ceiling
        // below, so a bare `> max` test let them straight through.
        if (!Number.isSafeInteger(totalChunks) || totalChunks <= 0 || totalChunks > MAX_REASSEMBLY_SIZE / MAX_CHUNK_SIZE) {
            this.log(`Rejecting chunked transfer for ${payload.path}: invalid totalChunks (${totalChunks}).`);
            return;
        }
        const totalBytes = payload.totalBytes;
        const chunkSize = payload.chunkSize;
        if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > MAX_REASSEMBLY_SIZE) {
            this.log(`Rejecting chunked transfer for ${payload.path}: invalid totalBytes (${totalBytes}).`);
            return;
        }
        if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_CHUNK_SIZE) {
            this.log(`Rejecting chunked transfer for ${payload.path}: invalid chunkSize (${chunkSize}).`);
            return;
        }
        // The three must agree. Without this a peer could claim 512 MB in a single chunk and
        // force the whole allocation with one small message.
        if (totalChunks !== Math.max(1, Math.ceil(totalBytes / chunkSize))) {
            this.log(`Rejecting chunked transfer for ${payload.path}: totalChunks (${totalChunks}) does not match totalBytes/chunkSize.`);
            return;
        }
        if (!this.pendingFileChunks.has(payload.transferId) && this.pendingFileChunks.size >= MAX_CONCURRENT_REASSEMBLIES) {
            this.log(`Rejecting chunked transfer for ${payload.path}: too many concurrent transfers in progress.`);
            return;
        }

        this.pendingFileChunks.set(payload.transferId, {
            path: payload.path,
            mtime: payload.mtime,
            // One preallocated buffer; chunks are written straight to their offsets.
            buffer: new Uint8Array(totalBytes),
            received: new Uint8Array(payload.totalChunks),
            totalBytes,
            chunkSize,
            total: payload.totalChunks,
            receivedCount: 0,
            lastUpdated: Date.now(),
            fileHash: payload.fileHash || '',
            compressed: payload.compressed,
            versionVector: payload.versionVector,
        });
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
        const offset = payload.index * transfer.chunkSize;
        if (offset + payload.data.byteLength > transfer.totalBytes) {
            this.log(`Chunk ${payload.index} for ${transfer.path} overruns the declared size. Aborting transfer.`);
            this.pendingFileChunks.delete(payload.transferId);
            this.activeTransfers.delete(payload.transferId);
            return;
        }
        if (!transfer.received[payload.index]) {
            transfer.received[payload.index] = 1;
            // The frame decoder hands back a view; wrapping a view in `new Uint8Array()`
            // would copy it a second time on the way into the reassembly buffer.
            const bytes = payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data);
            transfer.buffer.set(bytes, offset);
            transfer.receivedCount++;
            this.syncState.bytesTransferred += payload.data.byteLength;
        }
        transfer.lastUpdated = Date.now();
        const active = this.activeTransfers.get(payload.transferId);
        if (active) { active.processedChunks = transfer.receivedCount; active.lastUpdate = Date.now(); }
        this.resetIdleTimeout();
        
        if (transfer.receivedCount === transfer.total) {
            this.log(`All chunks received for ${transfer.path}. Reassembling...`);
            this.pendingFileChunks.delete(payload.transferId);
            this.activeTransfers.delete(payload.transferId);
            
            // Already contiguous: chunks were written to their final offsets on arrival.
            const reassembled = transfer.buffer;

            try {
                const computedHash = await this.getHash(reassembled.buffer);
                if (transfer.fileHash && computedHash && transfer.fileHash !== computedHash) {
                    this.log(`Integrity check failed for chunked transfer ${transfer.path}. Rejecting.`);
                    this.sendDirect(conn, { type: 'nack', transferId: payload.transferId, reason: 'integrity-failure' });
                    return;
                }

                await this.applyFileUpdate({ type: 'file-update', path: transfer.path, content: reassembled.buffer, mtime: transfer.mtime, encoding: 'binary', transferId: payload.transferId, compressed: transfer.compressed, versionVector: transfer.versionVector }, conn.peer);
                // Replies go out directly: through the queue they waited at the lowest priority
                // behind bulk transfers, long enough for the sender's ack timer to expire.
                this.sendDirect(conn, { type: 'ack', transferId: payload.transferId });
                this.log(`Reassembly complete for ${transfer.path}, sent ack.`);
            } catch (e) {
                this.log(`Failed to apply chunked file update: ${transfer.path}`, e);
                const reason = e instanceof Error && e.message.includes('IntegrityError') ? 'integrity-failure' : 'write-error';
                this.sendDirect(conn, { type: 'nack', transferId: payload.transferId, reason });
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
                // Reject (not resolve) the pending ACK — resolving would falsely signal success to the sender
                if (this.pendingAcks.has(id)) {
                    this.pendingAcks.get(id)!.reject(new Error('Transfer timed out and was cleaned up'));
                    this.pendingAcks.delete(id);
                }
                statusChanged = true;
            }
        }
        
        this.pruneTombstones();

        // Evict stale and excess entries from lastSentContent cache (moved here from the per-item hot path)
        const MAX_SENT_CONTENT_CACHE = 200;
        const contentCacheTtl = 10 * 60 * 1000; // 10 minutes
        for (const [p, cacheData] of this.lastSentContent.entries()) {
            if (now - cacheData.timestamp > contentCacheTtl) this.lastSentContent.delete(p);
        }
        if (this.lastSentContent.size > MAX_SENT_CONTENT_CACHE) {
            const sorted = Array.from(this.lastSentContent.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
            for (const [p] of sorted.slice(0, this.lastSentContent.size - MAX_SENT_CONTENT_CACHE)) {
                this.lastSentContent.delete(p);
            }
        }

        for (const [p, echo] of this.remoteEchoHashes) {
            if (now - echo.at > 60000) this.remoteEchoHashes.delete(p);
        }

        // Sweep expired ignore markers. shouldIgnoreEvent only deletes an entry when the
        // path is read again, so paths that never receive another event — and every
        // 'conflict:<path>' cooldown key, which is never read through that helper — leaked
        // for the lifetime of the session.
        for (const [p, ignoreUntil] of this.ignoreEvents.entries()) {
            if (now >= ignoreUntil) this.ignoreEvents.delete(p);
        }

        if (statusChanged) this.updateStatus();
    }

    async applyFileDelta(data: FileDeltaPayload) {
        // Deltas reached the vault without ever consulting the folder filters or the path
        // guard, unlike every other apply* path.
        if (!this.isPathSyncable(data.path)) return;
        await this.runLocked(data.path, async () => {
            const existingFile = this.app.vault.getAbstractFileByPath(data.path);
            if (!(existingFile instanceof TFile)) {
                throw new Error("IntegrityError: File not found for delta sync");
            }
            
            // A delta applies only on top of exactly the content it was made from (the base
            // hash check below); anything else fails over to a full send, where conflicts are
            // decided. One made from an older version than ours is simply stale.
            const localVV = this.twoDeviceState.fileVersions[data.path] || {};
            if (compareVectors(data.versionVector, localVV) === 'before') {
                this.log(`Ignoring a delta for ${data.path}: this device's version already includes it.`);
                return;
            }

            const localContent = await this.app.vault.read(existingFile);
            const localHash = await this.getHash(localContent);
            
            if (localHash !== data.baseHash) {
                throw new Error("IntegrityError: Base hash mismatch for delta sync");
            }
            
            // uses the shared module-level dmp instance
            const patches = dmp.patch_fromText(data.patches);
            const [newContent, results] = dmp.patch_apply(patches, localContent);
            
            const success = results.every((r: boolean) => r === true);
            if (!success) {
                throw new Error("IntegrityError: Patch apply failed");
            }
            
            this.ignoreNextEventForPath(data.path);
            await this.app.vault.modify(existingFile, newContent, { mtime: data.mtime });
            this.adoptVector(data.path, mergeVectors(localVV, data.versionVector));

            this.noteRemoteWrite(data.path, await this.getHash(newContent));
        });
    }

    /**
     * @param fromPeer the device that sent the update, when known. Needed to answer a stale
     *   copy of a file we deleted, and to break ties between concurrent edits.
     */
    async applyFileUpdate(data: FileUpdatePayload, fromPeer?: string) {
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
        // From here on fileHash is the verified hash of the content we hold. It is recorded
        // only if that content actually lands in the vault: this used to cache it up front,
        // so an update that was then rejected (local newer, conflict copy) left the peer's
        // hash filed against our different content.
        data.fileHash = computedHash || data.fileHash;

        await this.runLocked(data.path, async () => {
            const existingFile = this.app.vault.getAbstractFileByPath(data.path);
            if (!existingFile) {
                if (this.deletionOutranks(data, fromPeer)) return;
                await this.handleNewFileCreation(data, fromPeer);
                this.adoptVector(data.path, mergeVectors(this.twoDeviceState.fileVersions[data.path], data.versionVector));
            } else if (existingFile instanceof TFile) {
                await this.handleFileModification(data, existingFile, fromPeer);
            } else {
                this.log(`Received file update for a path that is a folder: ${data.path}. Ignoring.`);
            }
        });
    }

    /**
     * True when this device's deletion of `data.path` beats the copy a peer just sent, so the
     * copy must not come back. Deletions made while offline were resurrected exactly this way:
     * reconciliation on reconnect pushed the other device's older copy, and it was recreated
     * here and its tombstone cleared. Same rule as edits: the vectors decide when one side
     * saw the other's change (a copy edited after the peer learned of the deletion wins; a
     * copy the deletion already covered loses), and otherwise the later of deletion and edit.
     * The sender is then told to delete its copy too.
     */
    private deletionOutranks(data: FileUpdatePayload, fromPeer?: string): boolean {
        const deletedAt = this.tombstones[data.path];
        if (deletedAt === undefined) return false;
        const localVV = this.twoDeviceState.fileVersions[data.path] || {};
        const remoteVV = data.versionVector || {};
        const deletion: VersionInfo = { mtime: deletedAt, vv: localVV, deviceId: this.settings.deviceId };
        const copy: VersionInfo = { mtime: data.mtime, vv: remoteVV, hash: data.fileHash, deviceId: this.realDeviceId(fromPeer) };
        if (pickVersion(deletion, copy) === 'b') return false;
        this.log(`Not recreating ${data.path}: it was deleted here after that copy was last changed.`);
        if (fromPeer) {
            this.adoptVector(data.path, mergeVectors(localVV, remoteVV));
            this.addToQueueTask(fromPeer, { taskType: 'send-delete', path: data.path });
        }
        return true;
    }

    /** Write a peer's version over `file`, preserving its mtime, and remember we did. */
    private async writeRemoteVersion(file: TFile, data: FileUpdatePayload) {
        this.ignoreNextEventForPath(file.path);
        if (data.encoding === 'binary' || data.encoding === 'base64') {
            await this.app.vault.modifyBinary(file, data.content as ArrayBuffer, { mtime: data.mtime });
        } else {
            await this.app.vault.modify(file, data.content as string, { mtime: data.mtime });
        }
        this.noteRemoteWrite(file.path, data.fileHash);
    }

    /** The device ID behind a connection key ('direct-ip-host' names the host's real ID). */
    private realDeviceId(peerKey?: string | null): string | null {
        if (!peerKey) return null;
        return this.clusterPeers.get(peerKey)?.deviceId || peerKey;
    }

    private async handleNewFileCreation(data: FileUpdatePayload, fromPeer?: string) {
        this.log(`Creating new file: ${data.path}`);
        // The path exists again, so any deletion record for it is stale. Left in place it
        // would keep being advertised in our manifest and make peers delete their copy.
        this.clearTombstone(data.path);
        this.ignoreNextEventForPath(data.path);
        try {
            const folderPath = data.path.substring(0, data.path.lastIndexOf('/'));
            if (folderPath) {
                await this.ensureFolderExists(folderPath);
            }
            if (data.encoding === 'binary' || data.encoding === 'base64') {
                await this.app.vault.createBinary(data.path, data.content as ArrayBuffer, { mtime: data.mtime });
            } else {
                await this.app.vault.create(data.path, data.content as string, { mtime: data.mtime });
            }
            this.noteRemoteWrite(data.path, data.fileHash);
        } catch (e) {
            if (e instanceof Error && e.message.includes("File already exists")) {
                this.log(`File ${data.path} already exists, falling back to modification.`);
                const file = this.app.vault.getAbstractFileByPath(data.path);
                if (file instanceof TFile) await this.handleFileModification(data, file, fromPeer);
            } else {
                console.error("File creation error:", e);
                this.showNotice(`Could not create ${data.path} on this device.`, 'error');
                throw e;
            }
        }
    }

    /**
     * Create every missing folder along `path`.
     *
     * Confirmed folders are memoized: a batch of 500 files in one directory otherwise
     * re-resolved every path segment 500 times. The cache only ever records folders we
     * know exist, so a stale entry cannot cause a missing-folder write to be skipped —
     * and it is dropped whenever a folder is deleted or renamed.
     */
    private async ensureFolderExists(path: string) {
        if (!path || this.knownFolders.has(path)) return;

        const folders = path.split('/');
        let currentPath = '';
        for (const folder of folders) {
            currentPath = currentPath === '' ? folder : `${currentPath}/${folder}`;
            if (this.knownFolders.has(currentPath)) continue;
            if (!this.app.vault.getAbstractFileByPath(currentPath)) {
                try {
                    await this.app.vault.createFolder(currentPath);
                } catch (e) { /* Ignore if created concurrently */ }
            }
            this.knownFolders.add(currentPath);
        }
    }

    /** Forget memoized folders under `path` (inclusive) after a delete or rename. */
    private forgetKnownFolders(path: string) {
        this.knownFolders.delete(path);
        const prefix = path + '/';
        for (const known of this.knownFolders) {
            if (known.startsWith(prefix)) this.knownFolders.delete(known);
        }
    }

    private async handleFileModification(data: FileUpdatePayload, existingFile: TFile, fromPeer?: string) {
        try {
            const localContent = (data.encoding === 'binary' || data.encoding === 'base64')
                ? await this.app.vault.readBinary(existingFile)
                : await this.app.vault.cachedRead(existingFile);

            const contentIsSame = (data.encoding === 'binary' || data.encoding === 'base64')
                ? await this.areArrayBuffersEqual(localContent as ArrayBuffer, data.content as ArrayBuffer)
                : localContent === data.content;

            const localVV = this.twoDeviceState.fileVersions[data.path] || {};
            const remoteVV = data.versionVector || {};

            if (contentIsSame) {
                this.log(`Ignoring update (content is identical): ${data.path}`);
                if (data.fileHash) this.updateHashCache(data.path, data.fileHash, existingFile.stat);
                this.adoptVector(data.path, mergeVectors(localVV, remoteVV));
                return;
            }

            // Version vectors order edits causally, which beats comparing two devices'
            // clocks: the version made with the other already in hand wins.
            const order = compareVectors(remoteVV, localVV);
            if (order === 'after') {
                this.log(`Applying update (it includes this device's version): ${data.path}`);
                await this.writeRemoteVersion(existingFile, data);
                this.adoptVector(data.path, mergeVectors(localVV, remoteVV));
                return;
            }
            if (order === 'before') {
                this.log(`Ignoring update (this device's version already includes it): ${data.path}`);
                // The sender is behind; offer it ours rather than leave it stale until the
                // next full sync.
                this.replyWithOurVersion(existingFile, fromPeer, localVV);
                return;
            }

            // Changed on both sides independently, or no record tells the versions apart.
            await this.resolveConflict(data, existingFile, localContent, fromPeer);
        } catch (e) {
            if (e instanceof Error && (e.message.includes("File not found") || e.message.includes("no such file"))) {
                this.log(`File ${data.path} not found during modification, falling back to creation.`);
                await this.handleNewFileCreation(data, fromPeer);
            } else {
                console.error(`Error modifying file ${data.path}:`, e);
                throw e;
            }
        }
    }

    /**
     * Both devices changed the file without seeing each other's change (or nothing records
     * which came first). The more recent change wins on every device — see pickVersion, which
     * every device evaluates identically — and the losing version is not thrown away: the
     * device whose own edit lost saves it as a conflict copy first. "Last write wins" (a
     * manual-mode opt-out) skips the copy.
     *
     * This used to depend on how many devices happened to be connected: with one, the device
     * "role" decided and the other edit was silently overwritten; with two or more, a newer
     * copy overwrote without a copy and near-simultaneous edits left each device keeping its
     * own version.
     */
    private async resolveConflict(data: FileUpdatePayload, existingFile: TFile, localContent: string | ArrayBuffer, fromPeer: string | undefined) {
        const localVV = this.twoDeviceState.fileVersions[data.path] || {};
        const remoteVV = data.versionVector || {};
        const merged = mergeVectors(localVV, remoteVV);
        const local: VersionInfo = { mtime: existingFile.stat.mtime, vv: localVV, hash: await this.getHash(localContent).catch(() => undefined), deviceId: this.settings.deviceId };
        const remote: VersionInfo = { mtime: data.mtime, vv: remoteVV, hash: data.fileHash, deviceId: this.realDeviceId(fromPeer) };

        if (newerVersion(remote, local) === 'b') {
            this.log(`Conflicting versions of ${data.path}: this device's is newer. Sending it back.`);
            // Sent with our vector from BEFORE merging theirs, so the other device sees the
            // same conflict, reaches the same verdict and keeps its own version as a copy.
            // Merging first made ours look like a plain successor, and it overwrote its edit.
            this.replyWithOurVersion(existingFile, fromPeer, localVV);
            this.adoptVector(data.path, merged);
            return;
        }

        // Only an edit made on this device is worth a copy here. A version that came from
        // another device is kept by the device that made it, if it lost there; and content
        // no edit here ever touched (vaults that differed before the plugin was installed)
        // simply takes the newer version, so a first sync does not litter copies.
        const keepCopy = this.getConflictStrategy() === 'newest-with-copy'
            && hasOwnUnseenEdit(localVV, remoteVV, this.settings.deviceId);
        this.log(`Conflicting versions of ${data.path}: the other device's is newer.${keepCopy ? ' Keeping ours as a conflict copy.' : ''}`);
        const copy = keepCopy ? await this.createConflictCopy(data.path, localContent) : null;
        await this.writeRemoteVersion(existingFile, data);
        this.adoptVector(data.path, merged);
        if (copy) {
            const from = this.clusterPeers.get(fromPeer ?? '')?.friendlyName || 'another device';
            this.showNotice(`${existingFile.name} was also changed on ${from}. The newer version was kept; this device's version is saved as ${copy.split('/').pop()} — use “Resolve sync conflicts” to compare them.`, 'important', 12000);
        }
    }

    /**
     * Send our version of `file` to `peer` (the device that just sent an older or losing one),
     * with `vector` rather than whatever the file's vector is by the time the send runs.
     * Rate-limited per path and peer: two devices answering each other must not loop.
     */
    private replyWithOurVersion(file: TFile, peer: string | undefined, vector: VersionVector) {
        if (!peer) return;
        const key = `${peer}\0${file.path}`;
        const now = Date.now();
        if ((this.replyCooldowns.get(key) ?? 0) > now) {
            this.log(`Not answering ${peer} about ${file.path} again so soon.`);
            return;
        }
        for (const [k, until] of this.replyCooldowns) if (until <= now) this.replyCooldowns.delete(k);
        this.replyCooldowns.set(key, now + 5000);
        this.addToQueueTask(peer, { taskType: 'send-file', path: file.path, mtime: file.stat.mtime, forceFull: true, versionVector: { ...vector } });
    }

    private replyCooldowns = new Map<string, number>();

    private adoptVector(path: string, vector: VersionVector) {
        this.twoDeviceState.fileVersions[path] = vector;
        this.scheduleStateSave();
    }

    async applyFileBatchBinary(data: FileBatchBinaryPayload, fromPeer?: string): Promise<{ succeeded: string[], failed: string[] }> {
        const results = { succeeded: [] as string[], failed: [] as string[] };
        // A Uint8Array body is parsed in place; unpackTLVToFiles slices out each file's
        // content, so nothing keeps the batch alive afterwards.
        const packed: ArrayBuffer | Uint8Array = typeof data.data === 'string'
            ? base64ToArrayBuffer(data.data)
            : data.data;

        let unpacked: PackedFile[];
        try {
            unpacked = unpackTLVToFiles(packed);
        } catch (e) {
            this.log("Failed to unpack TLV binary batch", e);
            throw e;
        }

        // Bounded concurrency: filesPerBatch grows to 500, and mapping all of them into
        // Promise.allSettled meant up to 500 simultaneous vault writes, which starves the
        // renderer and can exhaust file handles.
        const BATCH_WRITE_CONCURRENCY = 8;
        const settled = await mapWithConcurrency(unpacked, BATCH_WRITE_CONCURRENCY, async (fileData) => {
            const safePath = sanitizeVaultPath(fileData.path);
            if (safePath === null) {
                this.log(`Batch ${data.batchId}: dropping an entry with an unsafe path.`);
                throw String(fileData.path);
            }
            fileData.path = safePath;
            try {
                let contentStr = '';
                let contentBuf: ArrayBuffer | null = null;

                if (fileData.encoding === 'binary') {
                    if (fileData.isCompressed) {
                        contentStr = decompressText(fileData.content);
                    } else {
                        contentBuf = toExactArrayBuffer(fileData.content);
                    }
                } else if (fileData.encoding === 'base64') {
                    // For Base64 encoded ArrayBuffers (fallback/DirectIP)
                    contentBuf = typeof fileData.content === 'string'
                        ? base64ToArrayBuffer(fileData.content)
                        : toExactArrayBuffer(fileData.content);
                } else {
                    contentStr = ObsidianDecentralizedPlugin.textDecoder.decode(fileData.content);
                }

                // Delegate to the normal single-file receive path rather than writing here.
                // This inline write skipped the path guard, the folder filters, the
                // existing-is-a-folder check, conflict resolution, mtime preservation and the
                // hash-cache update — so a batch could silently overwrite a locally edited
                // note, and every batch-received file was re-transferred on the next sync
                // because neither its mtime nor its hash was ever recorded.
                //
                // Note: applyFileUpdate takes its own runLocked on the same path, so this must
                // NOT be wrapped in one — runLocked chains per path and would deadlock.
                await this.applyFileUpdate({
                    type: 'file-update',
                    path: fileData.path,
                    content: contentBuf ?? contentStr,
                    mtime: fileData.mtime,
                    encoding: contentBuf ? 'binary' : 'utf8',
                    transferId: this.generateTransferId(fileData.path),
                    // Already decompressed above; the TLV format carries no hash or version
                    // vector, so conflict resolution falls back to mtime comparison.
                    compressed: false,
                } as FileUpdatePayload, fromPeer);

                // Progress is counted once, in handleBatchComplete, which is authoritative for
                // the batch. Counting here too made the UI report up to twice filesTotal.
                return fileData.path;
            } catch (e) {
                this.log(`Failed to write batched file ${fileData.path}`, e);
                throw fileData.path; // throw path on failure to track it
            }
        });

        for (const result of settled) {
            if (result.status === 'fulfilled') {
                results.succeeded.push(result.value);
            } else {
                results.failed.push(result.reason);
            }
        }

        return results;
    }

    /**
     * Write `content` to a fresh "(conflict on DATE)" path next to `originalPath` and list it in
     * the Conflict Center. Returns the copy's path, or null if none could be made.
     */
    private async createConflictCopy(originalPath: string, content: string | ArrayBuffer | Uint8Array): Promise<string | null> {
        // getConflictPath is string surgery on a peer-supplied path, so validate before it
        // is used to create anything.
        if (!this.isPathSyncable(originalPath)) return null;
        const conflictPath = this.getConflictPath(originalPath);
        if (!sanitizeVaultPath(conflictPath)) return null;
        // Not silenced: the copy syncs like any note, so the losing edit is kept on every
        // device and the conflict can be resolved from any of them.
        const folderPath = conflictPath.substring(0, conflictPath.lastIndexOf('/'));
        if (folderPath) await this.ensureFolderExists(folderPath);
        if (typeof content === 'string') {
            await this.app.vault.create(conflictPath, content);
        } else {
            await this.app.vault.createBinary(conflictPath, toExactArrayBuffer(content));
        }
        this.conflictCenter.addConflict(originalPath, conflictPath);
        return conflictPath;
    }

    /**
     * Remove something because a peer asked to, into whichever trash the user configured
     * (Settings → Files and links → Deleted files), so a mistaken or hostile request is
     * recoverable. These used to be permanent vault.delete() calls.
     */
    private async trashForPeer(file: TAbstractFile) {
        this.ignoreNextEventForPath(file.path);
        await this.app.fileManager.trashFile(file);
    }

    /** Every file and folder below `folder`, split by whether this device syncs it. */
    private collectFolderContents(folder: TFolder) {
        const files: TFile[] = [];
        const folders: TFolder[] = [];
        let hasOutOfScope = false;
        const walk = (current: TFolder) => {
            for (const child of current.children) {
                if (child instanceof TFile) {
                    if (this.isPathSyncable(child.path)) files.push(child);
                    else hasOutOfScope = true;
                } else if (child instanceof TFolder) {
                    folders.push(child);
                    if (!this.isPathSyncable(child.path)) hasOutOfScope = true;
                    walk(child);
                }
            }
        };
        walk(folder);
        return { files, folders, hasOutOfScope };
    }

    async applyFileDelete(data: FileDeletePayload, fromPeer?: string) {
        if (!this.isPathSyncable(data.path)) return;
        await this.runLocked(data.path, async () => {
            const existingFile = this.app.vault.getAbstractFileByPath(data.path);
            // A file-delete names one file. If a folder sits at that path, deleting it would
            // take its whole contents along.
            if (existingFile && !(existingFile instanceof TFile)) {
                this.log(`Ignoring file-delete for ${data.path}: it is a folder here.`);
                return;
            }

            const localVV = this.twoDeviceState.fileVersions[data.path] || {};
            const remoteVV = data.versionVector || {};
            const merged = mergeVectors(localVV, remoteVV);

            if (!existingFile) {
                // Already gone here (the same deletion arriving twice, or deleted on both
                // sides): nothing to defend, just record what the peer knows.
                this.adoptVector(data.path, merged);
                if (this.tombstones[data.path] === undefined) {
                    this.tombstones[data.path] = data.deletedAt ?? Date.now();
                    this.scheduleStateSave();
                }
                return;
            }

            // Edit versus delete: the vectors decide when one side saw the other's change;
            // otherwise the later of the edit and the deletion wins, on both devices. Only a
            // deletion from an older peer, which says neither when nor what it deleted, is
            // applied as it stands.
            const deletion: VersionInfo = { mtime: data.deletedAt ?? 0, vv: remoteVV, deviceId: this.realDeviceId(fromPeer) };
            const ours: VersionInfo = { mtime: existingFile.stat.mtime, vv: localVV, deviceId: this.settings.deviceId };
            const legacy = data.deletedAt === undefined && compareVectors(remoteVV, localVV) !== 'before';
            if (!legacy && pickVersion(deletion, ours) === 'b') {
                this.log(`Keeping ${data.path}: it was changed here after the other device deleted it.`);
                this.replyWithOurVersion(existingFile, fromPeer, localVV);
                this.adoptVector(data.path, merged);
                return;
            }
            if (hasOwnUnseenEdit(localVV, remoteVV, this.settings.deviceId)) {
                const from = this.clusterPeers.get(fromPeer ?? '')?.friendlyName || 'another device';
                this.showNotice(`${existingFile.name} was deleted on ${from} after it was changed here. This device's version is in the trash.`, 'important', 12000);
            }
            this.adoptVector(data.path, merged);

            this.tombstones[data.path] = data.deletedAt ?? Date.now();
            this.scheduleStateSave();
            this.syncedHashes.delete(data.path);
            if (existingFile) {
                try {
                    this.log(`Deleting file: ${data.path}`);
                    await this.trashForPeer(existingFile);
                } catch (e) {
                    console.error(`Error deleting file: ${data.path}`, e);
                    this.showNotice(`Could not delete ${data.path} on this device.`, 'error');
                }
            }
        });
    }

    async applyFileRename(data: FileRenamePayload, conn?: DataConnection | null) {
        // Both ends must be in scope here. Requiring only one let a peer move a synced note
        // into the config folder (plugin code), or move an excluded note into a synced folder
        // and then simply ask for it.
        if (!this.isPathSyncable(data.oldPath) || !this.isPathSyncable(data.newPath)) {
            this.log(`Ignoring rename ${data.oldPath} -> ${data.newPath}: outside this device's sync scope.`);
            return;
        }
        const [firstLock, secondLock] = [data.oldPath, data.newPath].sort();
        await this.runLocked(firstLock, async () => {
            await this.runLocked(secondLock, async () => {
                const fileToRename = this.app.vault.getAbstractFileByPath(data.oldPath);
                const target = this.app.vault.getAbstractFileByPath(data.newPath);
                if (fileToRename instanceof TFile && !target) {
                    try {
                        this.log(`Renaming file: ${data.oldPath} -> ${data.newPath}`);
                        this.ignoreNextEventForPath(data.oldPath);
                        this.ignoreNextEventForPath(data.newPath);
                        this.moveFileRecords(data.oldPath, data.newPath, data.versionVector);
                        const parent = data.newPath.substring(0, data.newPath.lastIndexOf('/'));
                        if (parent) await this.ensureFolderExists(parent);
                        await this.app.vault.rename(fileToRename, data.newPath);
                    } catch (e) {
                        console.error(`Error renaming file: ${data.oldPath} -> ${data.newPath}`, e);
                        this.showNotice(`Could not rename ${data.oldPath} on this device.`, 'error');
                    }
                } else if (target instanceof TFile) {
                    // Already renamed here (or the rename arrived after the file itself).
                    if (data.versionVector) {
                        this.adoptVector(data.newPath, mergeVectors(this.twoDeviceState.fileVersions[data.newPath], data.versionVector));
                        delete this.twoDeviceState.fileVersions[data.oldPath];
                    }
                } else if (!fileToRename && !target && conn) {
                    // We never had the file under its old name, so there is nothing to move.
                    // Ask for it under the new one instead of silently missing it.
                    this.sendDirect(conn, { type: 'request-file', path: data.newPath });
                }
            });
        });
    }

    /**
     * Carry a file's cached hash and version vector over to its new path, and record the old
     * path as deleted. Without that tombstone a device that missed the rename still had the
     * old name, nothing said it was gone, and a full sync sent it back as a duplicate.
     */
    private moveFileRecords(oldPath: string, newPath: string, versionVector?: VersionVector) {
        const cached = this.syncedHashes.get(oldPath);
        if (cached) {
            this.syncedHashes.set(newPath, cached);
            this.syncedHashes.delete(oldPath);
            this.hashCacheDirty = true;
        }
        const vector = versionVector ?? this.twoDeviceState.fileVersions[oldPath];
        if (vector) this.twoDeviceState.fileVersions[newPath] = vector;
        delete this.twoDeviceState.fileVersions[oldPath];
        this.tombstones[oldPath] = Date.now();
        delete this.tombstones[newPath];
        this.scheduleStateSave();
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

    /**
     * Delete a folder the peer deleted — but only what this device syncs. The peer never saw
     * anything this device keeps out of sync (an excluded subfolder, say), and a recursive
     * delete used to destroy that local-only content along with the rest.
     */
    async applyFolderDelete(data: FolderDeletePayload) {
        if (!this.isPathSyncable(data.path)) return;
        await this.runLocked(data.path, async () => {
            const folder = this.app.vault.getAbstractFileByPath(data.path);
            if (!(folder instanceof TFolder) || folder.isRoot()) return;
            const { files, folders, hasOutOfScope } = this.collectFolderContents(folder);
            this.log(`Deleting folder: ${data.path}${hasOutOfScope ? ' (keeping content this device does not sync)' : ''}`);

            const now = Date.now();
            for (const file of files) {
                // Record each deletion, so a third device still holding the file cannot bring
                // it back through a later full sync.
                this.tombstones[file.path] = now;
                this.syncedHashes.delete(file.path);
            }
            this.scheduleStateSave();

            try {
                if (hasOutOfScope) {
                    for (const file of files) await this.trashForPeer(file);
                } else {
                    for (const sub of folders) this.ignoreNextEventForPath(sub.path, 5000);
                    for (const file of files) this.ignoreNextEventForPath(file.path, 5000);
                    this.ignoreNextEventForPath(folder.path, 5000);
                    await this.app.fileManager.trashFile(folder);
                }
            } catch (e) {
                console.error(`Failed to delete folder ${data.path}`, e);
                this.showNotice(`Could not delete the folder ${data.path} on this device.`, 'error');
            }
        });
    }

    async applyFolderRename(data: FolderRenamePayload) {
        if (!this.isPathSyncable(data.oldPath) || !this.isPathSyncable(data.newPath)) {
            this.log(`Ignoring folder rename ${data.oldPath} -> ${data.newPath}: outside this device's sync scope.`);
            return;
        }
        const [firstLock, secondLock] = [data.oldPath, data.newPath].sort();
        await this.runLocked(firstLock, async () => {
            await this.runLocked(secondLock, async () => {
                const folder = this.app.vault.getAbstractFileByPath(data.oldPath);
                if (!(folder instanceof TFolder) || folder.isRoot()) return;
                if (this.app.vault.getAbstractFileByPath(data.newPath)) {
                    this.log(`Not renaming folder ${data.oldPath}: ${data.newPath} already exists.`);
                    return;
                }
                const { files, folders, hasOutOfScope } = this.collectFolderContents(folder);
                const moved = (path: string) => data.newPath + path.slice(data.oldPath.length);
                this.log(`Renaming folder: ${data.oldPath} -> ${data.newPath}`);
                try {
                    if (hasOutOfScope) {
                        // Moving the whole folder would carry content this device keeps out of
                        // sync into the new location — possibly one it does sync. Move only
                        // what the peer knows about.
                        for (const file of files) {
                            const target = moved(file.path);
                            const parent = target.substring(0, target.lastIndexOf('/'));
                            if (parent) await this.ensureFolderExists(parent);
                            this.ignoreNextEventForPath(file.path);
                            this.ignoreNextEventForPath(target);
                            this.moveFileRecords(file.path, target);
                            await this.app.vault.rename(file, target);
                        }
                    } else {
                        this.ignoreNextEventForPath(data.oldPath);
                        this.ignoreNextEventForPath(data.newPath);
                        for (const item of [...files, ...folders]) {
                            this.ignoreNextEventForPath(item.path);
                            this.ignoreNextEventForPath(moved(item.path));
                        }
                        for (const file of files) this.moveFileRecords(file.path, moved(file.path));
                        const parent = data.newPath.substring(0, data.newPath.lastIndexOf('/'));
                        if (parent) await this.ensureFolderExists(parent);
                        await this.app.vault.rename(folder, data.newPath);
                    }
                    this.forgetKnownFolders(data.oldPath);
                } catch (e) {
                    console.error(`Failed to rename folder ${data.oldPath}`, e);
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
        this.syncState.syncStartTime = Date.now();
        this.syncState.currentFile = null;
        this.syncState.currentFileSize = null;
        this.syncState.inFlightPulls = new Set();
        this.syncState.activePullBatches = new Set();
        this.syncState.adaptiveConfig = {
            maxActiveBatches: 1,
            filesPerBatch: 50,
            maxBytesPerBatch: 50 * 1024 * 1024
        };
        this.syncState.batchStartTimes = new Map();
        this.currentSyncIsTwoDeviceMode = this.isTwoDeviceMode();
        this.localSyncComplete.set(peerId, false);
        this.peerSyncComplete.set(peerId, false);
        this.transitionToPhase(SyncPhase.REQUESTING);
        this.startSyncKeepAlive();
        this.resetIdleTimeout();
        
        try {
            const localManifest = await this.buildVaultManifest();
            // Remember what we advertised: the plan may only delete files named here, and only
            // while they are unchanged since.
            this.sentManifestMtimes = new Map(
                localManifest.filter(e => e.type === 'file').map(e => [e.path, (e as FileManifestEntry).mtime])
            );
            this.log(`Sending sync request with ${localManifest.length} items.`); 
            await this.sendSyncMessage(peerId, { type: 'request-full-sync', manifest: localManifest }); 
        } catch (e) {
            this.abortSync(e instanceof SyncError ? e : new SyncError(SyncErrorCategory.PROTOCOL_ERROR, String(e), false, "Check network connection."));
        }
    }
    
    // --- Merkle Handlers ---
    async handleMerkleRoot(data: MerkleRootPayload, conn: DataConnection) {
        // Merkle reconciliation runs as BACKGROUND convergence over the normal queue —
        // it must not claim the full-sync state machine: the traversal has no completion
        // signal, so claiming isSyncing here left the plugin stuck in "Starting sync..."
        // until the phase timeout aborted with an error.
        if (this.syncState.isSyncing) return;
        const tree = await this.getMerkleTree();
        if (tree.hash === data.rootHash) {
            this.log("Merkle roots match — vaults already in sync.");
        } else {
            this.log(`Merkle roots differ. Initiating tree traversal.`);
            this.sendData(conn.peer, { type: 'merkle-node-request', path: '' });
        }
    }
    
    /** The node at `path` in a Merkle tree ('' is the root), or null if the tree has none. */
    private merkleNodeAt(tree: MerkleNode, path: string): MerkleNode | null {
        if (path === '') return tree;
        let node: MerkleNode = tree;
        for (const part of path.split('/')) {
            const next = node.children?.[part];
            if (!next) return null;
            node = next;
        }
        return node;
    }

    async handleMerkleNodeRequest(data: MerkleNodeRequestPayload, conn: DataConnection) {
        this.resetIdleTimeout();
        const tree = this.twoDeviceState.merkleTreeRoot;
        if (!tree || typeof data.path !== 'string') return;
        const targetNode = this.merkleNodeAt(tree, data.path);
        if (!targetNode) return;

        const childHashes: Record<string, string> = {};
        const folders: string[] = [];
        if (targetNode.children) {
            for (const [key, node] of Object.entries(targetNode.children)) {
                childHashes[key] = node.hash;
                if (node.children) folders.push(key);
            }
        }
        this.sendData(conn.peer, { type: 'merkle-node-response', path: data.path, children: childHashes, folders });
    }

    async handleMerkleNodeResponse(data: MerkleNodeResponsePayload, conn: DataConnection) {
        this.resetIdleTimeout();
        const tree = this.twoDeviceState.merkleTreeRoot;
        if (!tree || typeof data.path !== 'string' || !data.children || typeof data.children !== 'object') return;

        // A folder we do not have compares against nothing. This used to stop at the deepest
        // folder we DID have and compare the peer's children against that folder's, sending
        // requests for paths that exist on neither side.
        const myChildren = this.merkleNodeAt(tree, data.path)?.children ?? {};
        const remoteChildren = data.children;
        // Which of the peer's children are folders. Older peers do not say, and the fallback
        // guessed from a dot in the name — so a folder like "v1.2" was requested as a file
        // and an extension-less file as a folder, and neither ever synced.
        const remoteFolders = Array.isArray(data.folders) ? new Set(data.folders) : null;

        const allKeys = new Set([...Object.keys(myChildren), ...Object.keys(remoteChildren)]);

        for (const key of allKeys) {
            const myNode = myChildren[key];
            const myHash = myNode?.hash;
            const remoteHash = remoteChildren[key];
            if (myHash === remoteHash) continue;
            const fullPath = data.path ? `${data.path}/${key}` : key;
            if (sanitizeVaultPath(fullPath) !== fullPath || !this.isPathSyncable(fullPath)) continue;

            const file = this.app.vault.getAbstractFileByPath(fullPath);
            const isFolder = file instanceof TFolder
                || !!myNode?.children
                || (remoteFolders ? remoteFolders.has(key) : (!file && !fullPath.includes('.')));
            if (isFolder) {
                this.sendData(conn.peer, { type: 'merkle-node-request', path: fullPath });
            } else if (!myHash && remoteHash) {
                if (!file && this.tombstones[fullPath] !== undefined) {
                    // Deleted here while the devices were apart. Pulling it back would undo
                    // the deletion; send the deletion instead and let the peer's version
                    // vectors decide whether an edit it made since outranks it.
                    this.addToQueueTask(conn.peer, { taskType: 'send-delete', path: fullPath });
                } else {
                    this.sendData(conn.peer, { type: 'request-file', path: fullPath });
                }
            } else if (file instanceof TFile) {
                // Exchange BOTH directions: push ours and pull theirs. Each side's conflict
                // resolution then picks the same winner deterministically. Pushing only our
                // copy left the peer stale whenever its version vector dominated ours.
                //
                // forceFull: the peer asked for this state explicitly, so it must never be
                // dropped as an echo.
                this.sendFileUpdate(file, conn.peer, true);
                if (remoteHash) {
                    this.sendData(conn.peer, { type: 'request-file', path: fullPath });
                }
            }
        }
    }

    async handleFullSyncRequest(data: FullSyncRequestPayload, conn: DataConnection) {
        if (this.syncState.isSyncing) {
            this.log(`Received a sync request from ${conn.peer}, but a sync is already in progress in phase ${this.syncState.currentPhase}. Declining.`);
            // Say so rather than going quiet. If both devices start a sync at the same moment
            // each was left waiting on the other until the 120 s planning timeout fired.
            this.sendDirect(conn, { type: 'sync-busy' });
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
            this.syncState.syncStartTime = Date.now();
            this.syncState.currentFile = null;
            this.syncState.currentFileSize = null;
            this.syncState.inFlightPulls = new Set();
            this.syncState.activePullBatches = new Set();
            this.syncState.adaptiveConfig = {
                maxActiveBatches: 1,
                filesPerBatch: 50,
                maxBytesPerBatch: 50 * 1024 * 1024
            };
            this.syncState.batchStartTimes = new Map();
            this.currentSyncIsTwoDeviceMode = this.isTwoDeviceMode();
            this.localSyncComplete.set(conn.peer, false);
            this.peerSyncComplete.set(conn.peer, false);
            this.transitionToPhase(SyncPhase.PLANNING);
            this.startSyncKeepAlive();
            this.resetIdleTimeout();
        
            const remoteManifest = this.scopeRemoteManifest(data.manifest);
            const localManifest = await this.buildVaultManifest(); 
            const remoteIndex = new Map(remoteManifest.map(item => [item.path, item])); 
            const localIndex = new Map(localManifest.map(item => [item.path, item])); 
            
            const filesReceiverWillSend: string[] = []; 
            const filesInitiatorMustSend: string[] = []; 
            const filesReceiverMustDelete: string[] = [];
            const filesInitiatorMustDelete: string[] = [];
            const fileSizes: Record<string, number> = {};
            // When, and with what vector, each side's winning deletions happened: recorded as
            // the tombstone on the device that applies them, so a later comparison against an
            // edit elsewhere uses the real deletion time rather than "when the sync ran".
            const deletions: Record<string, { at: number; vv?: VersionVector }> = {};
            const myDeletions = new Map<string, { at: number; vv?: VersionVector }>();
            
            const allPaths = new Set([...localIndex.keys(), ...remoteIndex.keys()]);
            
            let peerPotentiallyStale = false;
            const retentionMs = (this.settings.tombstoneRetentionDays || 30) * 24 * 60 * 60 * 1000;
            const now = Date.now();

            // Pre-resolve the hashes the diff below needs but does not have cached.
            // Doing this inside the loop meant a serial read+digest per ambiguous file,
            // all of it counting against the 120 s PLANNING_TIMEOUT.
            const needsHash: string[] = [];
            for (const path of allPaths) {
                const localItem = localIndex.get(path);
                const remoteItem = remoteIndex.get(path);
                if (!localItem || !remoteItem) continue;
                if (localItem.type !== 'file' || remoteItem.type !== 'file') continue;
                if (localItem.hash) continue;
                if (localItem.size !== remoteItem.size) continue;
                // Close times with no recorded edits on either side are taken as the same
                // file below; everything else of equal size needs the hash to tell.
                if (Math.abs(localItem.mtime - remoteItem.mtime) <= this.settings.mtimeTolerance
                    && compareVectors(localItem.versionVector, remoteItem.versionVector) === 'equal') continue;
                needsHash.push(path);
            }

            if (needsHash.length > 0) {
                this.log(`Planning: hashing ${needsHash.length} ambiguous file(s) before diffing.`);
                await mapWithConcurrency(needsHash, 8, async (path) => {
                    const file = this.app.vault.getAbstractFileByPath(path);
                    if (!(file instanceof TFile)) return;
                    const stat = { mtime: file.stat.mtime, size: file.stat.size };
                    const content = this.isBinary(file.extension) ? await this.app.vault.readBinary(file) : await this.app.vault.cachedRead(file);
                    const hash = await this.getHash(content);
                    this.updateHashCache(path, hash, stat);
                    const item = localIndex.get(path);
                    if (item && item.type === 'file') item.hash = hash;
                });
            }

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
                    if (localItem.type === 'folder' || remoteItem.type === 'folder') continue;
                    // One rule for every pair, the same one each device applies on receipt:
                    // the vectors decide when one side saw the other's change, otherwise the
                    // more recent change wins (a deletion's time is when it happened). The
                    // device receiving the winner keeps its own losing edit as a copy.
                    const local: VersionInfo = { mtime: localItem.mtime, vv: localItem.versionVector, hash: localItem.hash, deviceId: this.settings.deviceId };
                    const remote: VersionInfo = { mtime: remoteItem.mtime, vv: remoteItem.versionVector, hash: remoteItem.hash, deviceId: this.realDeviceId(conn.peer) };
                    if (localItem.type === 'file' && remoteItem.type === 'file') {
                        if (localItem.hash && remoteItem.hash && localItem.hash === remoteItem.hash) continue;
                        // No recorded change on either side, same size, (nearly) the same time
                        // and nothing to show the contents differ: the same file.
                        if (compareVectors(localItem.versionVector, remoteItem.versionVector) === 'equal'
                            && localItem.size === remoteItem.size
                            && !(localItem.hash && remoteItem.hash)
                            && Math.abs(localItem.mtime - remoteItem.mtime) <= this.settings.mtimeTolerance) continue;
                        if (pickVersion(local, remote) === 'a') { filesReceiverWillSend.push(path); fileSizes[path] = localItem.size; }
                        else { filesInitiatorMustSend.push(path); this.peerFileSizes[path] = remoteItem.size; }
                    } else if (localItem.type === 'deleted' && remoteItem.type === 'file') {
                        if (pickVersion(local, remote) === 'a') {
                            filesInitiatorMustDelete.push(path);
                            deletions[path] = { at: localItem.mtime, vv: localItem.versionVector };
                        } else { filesInitiatorMustSend.push(path); this.peerFileSizes[path] = remoteItem.size; }
                    } else if (localItem.type === 'file' && remoteItem.type === 'deleted') {
                        if (pickVersion(local, remote) === 'b') {
                            filesReceiverMustDelete.push(path);
                            myDeletions.set(path, { at: remoteItem.mtime, vv: remoteItem.versionVector });
                        } else { filesReceiverWillSend.push(path); fileSizes[path] = localItem.size; }
                    }
                }
            }
            
            if (peerPotentiallyStale) {
                this.showNotice("The other device has been offline longer than this vault remembers deletions. Files you deleted here might reappear from that device.", 'warning', 15000);
            }
            
            this.log(`Sync plan: They pull ${filesReceiverWillSend.length}, I pull ${filesInitiatorMustSend.length}, They delete ${filesInitiatorMustDelete.length}, I delete ${filesReceiverMustDelete.length}`); 
            this.syncState.filesTotal = filesReceiverWillSend.length + filesInitiatorMustSend.length;
            if (filesReceiverWillSend.length === 0 && filesInitiatorMustSend.length === 0 && filesReceiverMustDelete.length === 0 && filesInitiatorMustDelete.length === 0) {
                this.log("Vaults are completely identical. No sync needed.");
            }
            
            await this.sendSyncMessage(conn.peer, { type: 'sync-plan', filesReceiverWillSend, filesInitiatorMustSend, filesReceiverMustDelete, filesInitiatorMustDelete, fileSizes, deletions });
            
            for (const path of filesReceiverMustDelete) {
                const entry = localIndex.get(path);
                await this.deleteForSyncPlan(path, entry && entry.type !== 'folder' ? entry.mtime : undefined, myDeletions.get(path));
            }

            this.syncState.allowedPulls = new Set(filesReceiverWillSend);
            this.syncState.pendingPulls = new Set(filesInitiatorMustSend);
            this.initPullOrder(this.syncState.pendingPulls);
            this.requestNextBatch(conn.peer);
            
        } catch (e) {
            this.abortSync(e instanceof SyncError ? e : new SyncError(SyncErrorCategory.PROTOCOL_ERROR, String(e), false, "Check logs for error details."));
        }
    }
    
    /** Paths and mtimes of the files in the manifest we last sent with request-full-sync. */
    private sentManifestMtimes: Map<string, number> = new Map();

    /**
     * The peer's manifest, reduced to well-formed entries inside this device's sync scope.
     * Anything else would be pulled only to be refused on arrival — and counted as synced.
     */
    private scopeRemoteManifest(manifest: unknown): VaultManifest {
        if (!Array.isArray(manifest)) {
            throw new SyncError(SyncErrorCategory.PROTOCOL_ERROR, "Received an invalid manifest.", false, "Update the plugin on both devices.");
        }
        const scoped: VaultManifest = [];
        for (const item of manifest) {
            if (!item || typeof item !== 'object') continue;
            const path = sanitizeVaultPath(item.path);
            if (path === null || !this.isPathSyncable(path)) continue;
            if (item.type === 'folder') {
                scoped.push({ type: 'folder', path });
            } else if (item.type === 'file' || item.type === 'deleted') {
                const mtime = Number(item.mtime);
                const size = Number(item.size);
                if (!Number.isFinite(mtime) || !Number.isFinite(size)) continue;
                const hash = typeof item.hash === 'string' && item.hash.length <= 256 ? item.hash : undefined;
                scoped.push({ type: item.type, path, mtime, size, hash, versionVector: sanitizeVersionVector(item.versionVector) });
            }
        }
        return scoped;
    }

    /**
     * Delete a file because a sync plan says it was deleted elsewhere — only if it is a file
     * this device syncs and it still has the mtime the plan was computed from, so an edit
     * made while the plan was in flight survives.
     */
    private async deleteForSyncPlan(path: string, expectedMtime: number | undefined, deletion?: { at: number; vv?: VersionVector }) {
        await this.runLocked(path, async () => {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile) || !this.isPathSyncable(path)) {
                this.log(`Sync plan: not deleting ${path} (not a synced file here).`);
                return;
            }
            if (expectedMtime === undefined || file.stat.mtime !== expectedMtime) {
                this.log(`Sync plan: not deleting ${path} (changed since the manifest, or never advertised).`);
                return;
            }
            try {
                this.syncedHashes.delete(path);
                // Record the deletion as the other device made it, not as a new one here.
                if (deletion?.vv) this.adoptVector(path, mergeVectors(this.twoDeviceState.fileVersions[path], deletion.vv));
                else this.incrementVersion(path);
                this.tombstones[path] = deletion?.at ?? Date.now();
                this.scheduleStateSave();
                await this.trashForPeer(file);
            } catch (e) {
                this.log(`Failed to delete file ${path}:`, e);
            }
        });
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
            
            // The plan is the peer's word, so each deletion is checked against what WE
            // advertised: a path we never sent, a folder, anything outside our scope, or a file
            // edited since the manifest went out is left alone. These deletes used to run
            // unchecked — any path, folders included.
            for (const raw of Array.isArray(data.filesInitiatorMustDelete) ? data.filesInitiatorMustDelete : []) {
                const path = sanitizeVaultPath(raw);
                const deletion = path && data.deletions && typeof data.deletions === 'object' ? data.deletions[raw] : undefined;
                if (path) await this.deleteForSyncPlan(path, this.sentManifestMtimes.get(path),
                    deletion && Number.isFinite(deletion.at) ? { at: deletion.at, vv: sanitizeVersionVector(deletion.vv) } : undefined);
            }

            // Pull only what this device syncs: anything else would be refused on arrival yet
            // counted as received.
            const inScope = (paths: unknown): string[] => (Array.isArray(paths) ? paths : [])
                .map(p => sanitizeVaultPath(p))
                .filter((p): p is string => p !== null && this.isPathSyncable(p));
            const willPull = inScope(data.filesReceiverWillSend);
            const willServe = inScope(data.filesInitiatorMustSend);
            this.syncState.filesTotal = willPull.length + willServe.length;

            const willPullSet = new Set(willPull);
            const sizes = data.fileSizes && typeof data.fileSizes === 'object' ? data.fileSizes : {};
            for (const [path, size] of Object.entries(sizes)) {
                if (typeof size !== 'number' || !Number.isFinite(size)) continue;
                this.peerFileSizes[path] = size;
                if (willPullSet.has(path)) this.syncState.bytesTotal += size;
            }

            this.syncState.allowedPulls = new Set(willServe);
            this.syncState.pendingPulls = willPullSet;
            this.initPullOrder(this.syncState.pendingPulls);

            this.requestNextBatch(conn.peer);
        } catch (e) {
            this.log('Error processing sync plan:', e);
            this.abortSync(e instanceof SyncError ? e : new SyncError(SyncErrorCategory.PROTOCOL_ERROR, String(e), false, "Check logs for details."));
        }
    }
    
    private recordBatchTaskCompletion(batchId: string | undefined, paths: string[] | undefined, success: boolean, reauthorizeOnFailure = true) {
        if (!batchId || !paths || paths.length === 0) return;
        const batch = this.syncState.activeBatches.get(batchId);
        if (!batch) return;

        // Count every path covered by the completed task. A 'send-file-batch' task
        // covers many paths but completes as ONE queue item — counting it as 1 while
        // totalCount counts paths would leave sentCount < totalCount forever, so the
        // batch-complete message would never be sent and the sync would deadlock.
        batch.sentCount += paths.length;
        if (success) {
            batch.succeededPaths.push(...paths);
        } else {
            batch.failedPaths.push(...paths);
            // Re-authorize failed paths so the peer's retry request isn't rejected as "unauthorized"
            if (reauthorizeOnFailure) {
                for (const p of paths) this.syncState.allowedPulls.add(p);
            }
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
            
            let currentBatchPaths: string[] = [];
            let currentBatchSize = 0;
            // Batches are packed then deflated, so the budget is measured against the
            // estimated ON-WIRE size. Budgeting against raw file.stat.size systematically
            // under-filled every batch. The 60 KB cap also predated V3: the old envelope
            // base64'd bodies (+33%), so the effective ceiling was far below the ~256 KB
            // a data channel actually accepts.
            const MAX_BATCH_BYTES = 192 * 1024;

            for (const path of data.paths) {
                if (allowed.has(path)) {
                    allowed.delete(path);
                    const file = this.app.vault.getAbstractFileByPath(path);
                    if (file instanceof TFile) {
                        const estimatedOverhead = 16 + path.length * 3; // Approx 3 bytes per char for UTF8 safety
                        // Text is compressed before packing and typically lands near a
                        // third of its original size; binary is assumed incompressible.
                        const compressionFactor = (this.settings.enableCompression && !this.isBinary(file.extension)) ? 0.4 : 1;
                        const estimatedSize = Math.ceil(file.stat.size * compressionFactor) + estimatedOverhead;

                        if (estimatedSize >= MAX_BATCH_BYTES) {
                            // Too large for binary batch, send normally (will chunk if needed)
                            this.addToQueueTask(conn.peer, { taskType: 'send-file', path, mtime: file.stat.mtime, forceFull: true, batchId });
                        } else {
                            if (currentBatchSize + estimatedSize >= MAX_BATCH_BYTES) {
                                // Flush current batch
                                this.addToQueueTask(conn.peer, { taskType: 'send-file-batch', paths: currentBatchPaths, batchId });
                                currentBatchPaths = [];
                                currentBatchSize = 0;
                            }
                            currentBatchPaths.push(path);
                            currentBatchSize += estimatedSize;
                        }
                    } else if (file instanceof TFolder) {
                        this.addToQueueTask(conn.peer, { taskType: 'send-folder-create', path, batchId });
                    } else {
                        this.log(`Failed to read ${path} for batch, marking failed.`);
                        this.recordBatchTaskCompletion(batchId, [path], false);
                    }
                } else {
                    this.log(`Peer requested unauthorized path ${path}. Marking failed.`);
                    this.recordBatchTaskCompletion(batchId, [path], false, false);
                }
            }

            if (currentBatchPaths.length > 0) {
                this.addToQueueTask(conn.peer, { taskType: 'send-file-batch', paths: currentBatchPaths, batchId });
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
        // Only accept completions for pull batches WE initiated; anything else is a
        // stray/echoed batchId and processing it would corrupt pull-tracking state.
        if (!this.syncState.activePullBatches?.has(data.batchId)) {
            this.log(`Ignoring batch-complete for unknown batch ${data.batchId}`);
            return;
        }
        this.transitionToPhase(SyncPhase.TRANSFERRING); // Reset timeout
        this.resetIdleTimeout();
        
        try {
            if (!data.receivedPaths || !data.failedPaths) throw new SyncError(SyncErrorCategory.PROTOCOL_ERROR, "Invalid batch complete payload.", false, "Update plugin.");
            const pending = this.syncState.pendingPulls;
            if (this.syncState.activePullBatches) this.syncState.activePullBatches.delete(data.batchId);
            
            const startTime = this.syncState.batchStartTimes?.get(data.batchId);
            this.syncState.batchStartTimes?.delete(data.batchId);
            const durationSec = startTime ? (Date.now() - startTime) / 1000 : 0;
            let batchBytes = 0;
            
            for (const path of data.receivedPaths) {
                pending.delete(path);
                if (this.syncState.inFlightPulls) this.syncState.inFlightPulls.delete(path);
                this.syncState.filesTransferred++;
                const size = this.peerFileSizes[path] || 0;
                this.syncState.bytesTransferred += size;
                batchBytes += size;
                this.pullRetries.delete(path);
            }
            
            for (const path of data.failedPaths) {
                if (this.syncState.inFlightPulls) this.syncState.inFlightPulls.delete(path);
                const retries = this.pullRetries.get(path) || 0;
                if (retries < 3) {
                    this.pullRetries.set(path, retries + 1);
                    // The pull cursor only moves forward, so a path being retried has to
                    // be re-appended or it would never be requested again.
                    this.pullOrder.push(path);
                } else {
                    pending.delete(path);
                    this.pullRetries.delete(path);
                    this.log(`Failed to pull ${path} after 3 attempts. Giving up on this file.`);
                }
            }
            
            if (data.failedPaths.length > 0) {
                this.syncState.adaptiveConfig.maxActiveBatches = Math.max(1, Math.floor(this.syncState.adaptiveConfig.maxActiveBatches / 2));
                this.syncState.adaptiveConfig.filesPerBatch = Math.max(10, Math.floor(this.syncState.adaptiveConfig.filesPerBatch / 2));
                this.log(`AdaptiveSync: Network issues detected (${data.failedPaths.length} failed). Decreasing limits to ${this.syncState.adaptiveConfig.maxActiveBatches} batches, ${this.syncState.adaptiveConfig.filesPerBatch} files/batch.`);
            } else if (durationSec > 0 && data.receivedPaths.length > 0) {
                const throughput = batchBytes / durationSec;
                if (throughput > 100 * 1024 || durationSec < 0.5) {
                    this.syncState.adaptiveConfig.maxActiveBatches = Math.min(5, this.syncState.adaptiveConfig.maxActiveBatches + 1);
                    this.syncState.adaptiveConfig.filesPerBatch = Math.min(500, this.syncState.adaptiveConfig.filesPerBatch + 50);
                    this.log(`AdaptiveSync: Good transfer (${(throughput / 1024 / 1024).toFixed(2)} MB/s). Increasing limits to ${this.syncState.adaptiveConfig.maxActiveBatches} batches, ${this.syncState.adaptiveConfig.filesPerBatch} files/batch.`);
                }
            }
            
            this.requestNextBatch(conn.peer);
        } catch (e) {
            this.abortSync(e instanceof SyncError ? e : new SyncError(SyncErrorCategory.PROTOCOL_ERROR, String(e), false, "Check logs."));
        }
    }
    
    /**
     * Establish the smallest-first pull order for a sync plan, once.
     *
     * requestNextBatch used to rebuild an array from pendingPulls and re-sort it on every
     * iteration of its own while loop AND again on every batch-complete — O(n log n) over
     * the entire pending set per batch. The order is now computed once and consumed
     * through a cursor.
     */
    private initPullOrder(paths: Iterable<string>) {
        this.pullOrder = Array.from(paths);
        this.pullOrder.sort((a, b) => (this.peerFileSizes[a] || 0) - (this.peerFileSizes[b] || 0));
        this.pullCursor = 0;
    }

    requestNextBatch(peerId: string) {
        if (this.syncState.currentPhase !== SyncPhase.TRANSFERRING && this.syncState.currentPhase !== SyncPhase.PLANNING) return;
        const pending = this.syncState.pendingPulls;
        if (!pending || pending.size === 0) {
            this.checkFullSyncCompletion(peerId);
            return;
        }

        if (!this.syncState.activePullBatches) this.syncState.activePullBatches = new Set();
        if (!this.syncState.inFlightPulls) this.syncState.inFlightPulls = new Set();

        while (this.syncState.activePullBatches.size < this.syncState.adaptiveConfig.maxActiveBatches) {
            const inFlight = this.syncState.inFlightPulls;

            // Skip entries the cursor has passed that are no longer eligible: already
            // received (dropped from pending), or currently in flight in another batch.
            while (this.pullCursor < this.pullOrder.length) {
                const p = this.pullOrder[this.pullCursor];
                if (pending.has(p) && !inFlight.has(p)) break;
                this.pullCursor++;
            }

            if (this.pullCursor >= this.pullOrder.length) {
                if (this.syncState.activePullBatches.size === 0) {
                    this.checkFullSyncCompletion(peerId);
                }
                break;
            }

            this.transitionToPhase(SyncPhase.TRANSFERRING);
            const paths: string[] = [];
            let totalSize = 0;

            while (this.pullCursor < this.pullOrder.length) {
                const path = this.pullOrder[this.pullCursor];
                if (!pending.has(path) || inFlight.has(path)) { this.pullCursor++; continue; }

                const size = this.peerFileSizes[path] || 0;
                if (paths.length >= this.syncState.adaptiveConfig.filesPerBatch || (totalSize + size > this.syncState.adaptiveConfig.maxBytesPerBatch && paths.length > 0)) {
                    break;
                }
                paths.push(path);
                totalSize += size;
                inFlight.add(path);
                this.pullCursor++;
            }

            this.log(`Requesting batch of ${paths.length} files (${formatBytes(totalSize)}). Active batches: ${this.syncState.activePullBatches.size + 1}/${this.syncState.adaptiveConfig.maxActiveBatches}`);
            const batchId = this.generateTransferId('batch');
            this.syncState.activePullBatches.add(batchId);
            this.syncState.batchStartTimes?.set(batchId, Date.now());
            this.sendSyncMessage(peerId, { type: 'request-batch', paths, batchId }).catch(e => {
                this.syncState.activePullBatches?.delete(batchId);
                this.syncState.batchStartTimes?.delete(batchId);
                for (const p of paths) this.syncState.inFlightPulls?.delete(p);
                this.abortSync(e);
            });
            this.resetIdleTimeout();
        }
    }
    
    /**
     * `full-sync-complete` means "I will request nothing more". Each side sends it once its own
     * pulls are settled, and the sync ends when both have said so and nothing is still being
     * served. It used to wait until the peer had also taken everything we allowed — but a
     * file the peer gave up on after three failures stayed allowed forever, so neither side
     * ever finished and one bad file ended every full sync in a timeout error.
     */
    checkFullSyncCompletion(peerId: string) {
        if (!this.syncState.isSyncing) return;
        const pending = this.syncState.pendingPulls;
        const activeBatches = this.syncState.activeBatches;

        if ((!pending || pending.size === 0) && !this.localSyncComplete.get(peerId)) {
            this.localSyncComplete.set(peerId, true);
            this.sendSyncMessage(peerId, { type: 'full-sync-complete' }).catch(e => this.abortSync(e));
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
        this.syncState.inFlightPulls?.clear();
        this.syncState.allowedPulls.clear();
        this.pullRetries.clear();
        this.pullOrder = [];
        this.pullCursor = 0;
        this.syncState.activeBatches.clear();
        this.syncState.activePullBatches?.clear();
        this.localSyncComplete.clear();
        this.peerSyncComplete.clear();
        this.syncState.peerId = null;
        this.peerFileSizes = {};
        this.sentManifestMtimes = new Map();
        this.processQueue();
        this.updateStatus(); 
        this.showNotice(`Sync complete. Transferred ${this.syncState.filesTransferred} files.`, 'important'); 
    }

    handleRequestFile(data: RequestFilePayload, conn: DataConnection) {
        // Without this a peer could request any path at all — including
        // .obsidian/plugins/*/data.json, which holds other plugins' credentials.
        if (!this.isPathSyncable(data.path)) {
            this.log(`Peer ${conn.peer} requested a path outside the sync scope: ${data.path}`);
            return;
        }
        const file = this.app.vault.getAbstractFileByPath(data.path);
        if (file instanceof TFile) {
            // A peer asked for this file explicitly, so it must never be echo-suppressed:
            // syncedHashes reflects our own content, not what the peer already holds.
            this.sendFileUpdate(file, conn.peer, true);
        }
    }
    
    private async buildVaultManifest(): Promise<VaultManifest> { 
        const manifest: VaultManifest = []; 
        const allFiles = this.app.vault.getAllLoadedFiles(); 

        // Yield on a time budget rather than every 50 files. A 20k-file vault produced
        // ~400 macrotask yields, and browser timer clamping turned that into seconds of
        // pure scheduling latency inside a phase that has a 120 s timeout.
        let count = 0;
        let lastYield = Date.now();
        for (const file of allFiles) {
            if (this.isPathSyncable(file.path)) {
                if (file instanceof TFolder) {
                    if (file.path !== '/') manifest.push({ type: 'folder', path: file.path });
                } else if (file instanceof TFile) {
                    const hash = this.cachedHashFor(file);
                    const vv = this.twoDeviceState.fileVersions[file.path];
                    manifest.push({ type: 'file', path: file.path, mtime: file.stat.mtime, size: file.stat.size, hash, versionVector: vv });
                    count++;

                    if (Date.now() - lastYield > 8) {
                        this.updateStatus({ text: `Building manifest (${count}/${allFiles.length})...`, icon: 'loader', spin: true, state: 'loading' });
                        await new Promise(r => setTimeout(r, 0));
                        lastYield = Date.now();
                    }
                }
            }
        }
        // Only advertise a deletion for paths that are actually gone. The peer indexes this
        // manifest by path and keeps the LAST entry per path, so a stale tombstone for a file
        // that has since been recreated overwrote its live entry — and the peer then deleted
        // its own copy outright.
        const livePaths = new Set(manifest.map(entry => entry.path));
        for (const [path, timestamp] of Object.entries(this.tombstones)) {
            if (livePaths.has(path)) continue;
            manifest.push({ type: 'deleted', path, mtime: timestamp, size: 0, versionVector: this.twoDeviceState.fileVersions[path] });
        }
        return manifest;
    }

    /** Forget a deletion record, because the path exists again. */
    public clearTombstone(path: string) {
        if (this.tombstones[path] === undefined) return;
        delete this.tombstones[path];
        this.scheduleStateSave();
    }

    public isPathSyncable(path: string): boolean {
        // Evaluate the rules against the normalised path: './.obsidian/plugins/x' must not slip
        // past a prefix check while resolving into the config folder, and '../' must never
        // escape the vault. sanitizeVaultPath rejects the latter outright.
        const safePath = sanitizeVaultPath(path);
        if (safePath === null) {
            this.log(`Rejected unsafe path: ${JSON.stringify(path)}`);
            return false;
        }
        path = safePath;

        // Hidden paths never sync as notes. Obsidian does not index them, so nothing
        // legitimate is lost, and accepting them let a peer write into `.git/hooks` or the
        // config folder. Obsidian settings sync through ConfigSync instead, which reads and
        // writes them through the adapter under its own allow-list.
        if (hasHiddenSegment(path)) return false;
        // The config folder can be renamed to something without a leading dot.
        const configDir = this.app.vault.configDir || '.obsidian';
        if (path === configDir || path.startsWith(configDir + '/')) return false;

        // Cached, and invalidated on settings change, to avoid re-parsing on every vault event.
        if (this._cachedExcludedFolders === null) {
            this._cachedExcludedFolders = parseFolderList(this.settings.excludedFolders);
        }
        if (isWithinFolders(path, this._cachedExcludedFolders)) return false;

        if (this.settings.syncMode === 'manual' || this.settings.syncMode === 'advanced') {
            if (this._cachedIncludedFolders === null) {
                this._cachedIncludedFolders = parseFolderList(this.settings.includedFolders);
            }
            if (this._cachedIncludedFolders.length > 0 && !isWithinFolders(path, this._cachedIncludedFolders)) return false;
        }
        return true;
    }
    // Set lookup against a module-level constant. This allocated a fresh 10-element
    // array literal on every call, and it is called several times per file per sync.
    public isBinary(extension: string): boolean { return !TEXT_EXTENSIONS.has((extension || '').toLowerCase()); }
    private async areArrayBuffersEqual(buf1: ArrayBuffer, buf2: ArrayBuffer): Promise<boolean> {
        if (buf1.byteLength !== buf2.byteLength) return false;
        if (buf1.byteLength < 50 * 1024) {
            // Compare 4 bytes at a time. Identical files are the common case here — this
            // runs on every incoming update — so the loop almost always runs to the end.
            const words = buf1.byteLength >>> 2;
            const w1 = new Uint32Array(buf1, 0, words);
            const w2 = new Uint32Array(buf2, 0, words);
            for (let i = 0; i < words; i++) {
                if (w1[i] !== w2[i]) return false;
            }
            const b1 = new Uint8Array(buf1);
            const b2 = new Uint8Array(buf2);
            for (let i = words << 2; i < buf1.byteLength; i++) {
                if (b1[i] !== b2[i]) return false;
            }
            return true;
        }
        const hash1 = await this.getHash(buf1);
        const hash2 = await this.getHash(buf2);
        return hash1 === hash2;
    }
    private shouldIgnoreEvent(path: string): boolean { const ignoreUntil = this.ignoreEvents.get(path); if (ignoreUntil && Date.now() < ignoreUntil) { return true; } this.ignoreEvents.delete(path); return false; }
    public ignoreNextEventForPath(path: string, durationMs = 2000) { this.ignoreEvents.set(path, Date.now() + durationMs); }
    /**
     * Path for a conflict copy. Suffixed with a counter when needed: the date alone meant
     * a second conflict on the same file the same day overwrote the first copy, losing
     * the very content the conflict file exists to preserve.
     */
    getConflictPath(originalPath: string): string {
        const date = new Date().toISOString().split('T')[0];
        const lastDot = originalPath.lastIndexOf('.');
        const lastSlash = originalPath.lastIndexOf('/');
        const hasExtension = lastDot > lastSlash;
        const base = hasExtension ? originalPath.substring(0, lastDot) : originalPath;
        const extension = hasExtension ? originalPath.substring(lastDot + 1) : '';

        const build = (suffix: string) => hasExtension
            ? `${base} (conflict on ${date}${suffix}).${extension}`
            : `${base} (conflict on ${date}${suffix})`;

        let candidate = build('');
        for (let n = 2; this.app.vault.getAbstractFileByPath(candidate) && n < 1000; n++) {
            candidate = build(` ${n}`);
        }
        return candidate;
    }
    getLocalIps(): LocalIpv4[] {
        if (Platform.isMobile) return [];
        try {
            const os = require('os');
            return collectLocalIpv4(os.networkInterfaces() || {});
        } catch (e) {
            console.warn("Could not get local IP address.", e);
            return [];
        }
    }
    getLocalIp(): string | null {
        return preferLocalIpv4(this.getLocalIps());
    }
    getMyPeerInfo(): PeerInfo {
        const mode = this.getConnectionMode();
        let port: number | undefined;
        if (mode === 'direct-ip' && this.directIpServer) {
            port = this.settings.directIpHostPort;
        }
        const pairingKey = this.getActivePsk() || undefined;
        return { 
            deviceId: this.peer?.id || this.settings.deviceId, 
            friendlyName: this.settings.friendlyName, 
            ip: this.getLocalIp(),
            mode: mode,
            port: port,
            pairingKey,
        }; 
    }

    public suggestFriendlyName(): string {
        let hostname: string | null = null;
        if (!Platform.isMobile) {
            try {
                const os = require('os');
                hostname = typeof os.hostname === 'function' ? String(os.hostname() || '') : null;
            } catch {
                hostname = null;
            }
        }
        return suggestedDeviceName(Platform.isMobile, hostname);
    }

    public async setFriendlyName(name: string): Promise<boolean> {
        const trimmed = name.trim();
        if (!trimmed || trimmed.length > 64) return false;
        if (trimmed === this.settings.friendlyName) return true;
        this.settings.friendlyName = trimmed;
        await this.saveSettings();
        this.broadcastData({ type: 'cluster-rename', targetDeviceId: this.settings.deviceId, newName: trimmed });
        this.refreshLanBeacon();
        this.updateStatus();
        return true;
    }

    /** Starts the offline host. Resolves with the access token, or null if it could not bind. */
    public async startDirectIpHost(): Promise<string | null> {
        if (Platform.isMobile) return null;
        // Re-opening Connect after Start Hosting used to call this again, which tore
        // down the live server and minted a new token the other device no longer had.
        if (this.directIpServer) return this.directIpServer.getPin();
        this.reinitializeConnectionManager();
        const pin = Array.from(window.crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
        const server = new DirectIpServer(this, this.settings.directIpHostPort, pin);
        this.directIpServer = server;
        try {
            await server.listening;
        } catch (e: any) {
            this.directIpServer = null;
            this.updateStatus();
            this.showNotice(e?.message || 'Could not start the offline host.', 'error');
            return null;
        }
        // Re-announce now the port is known. getMyPeerInfo() only fills in a port once
        // directIpServer is set, and reinitializeConnectionManager above broadcast before
        // that — leaving peers with a cached beacon advertising no port at all.
        if (!Platform.isMobile) this.lanDiscovery.startBroadcasting(this.getMyPeerInfo());
        this.updateStatus();
        return pin;
    }
    public async connectToDirectIpHost(config: DirectIpConfig) {
        this.reinitializeConnectionManager();
        // The handshake goes out first on every authenticated link, reconnects included: the
        // host forgets this device when a socket closes, and without a fresh handshake it
        // never sent it anything again. The token itself is never sent — the transport
        // proves it instead.
        const client = new DirectIpClient(this, config,
            () => ({ type: 'handshake', peerInfo: this.getMyPeerInfo(), protocolVersion: PROTOCOL_VERSION }));
        this.directIpClient = client;
        this.clusterPeers.set('direct-ip-host', { deviceId: 'direct-ip-host', friendlyName: `Host (${config.host})`, ip: config.host });

        const mockConn = {
            send: (data: any) => client.send(data),
            peer: 'direct-ip-host',
            // Only once the host has proved it holds the token and the link is encrypted.
            get open() { return client.isOpen; },
            close: () => client.triggerReconnect()
        } as any;
        this.connections.set('direct-ip-host', mockConn);
        this.updateStatus();
    }

    /** True when Sync Progress has something to show (not merely "Connecting…"). */
    public hasVisibleSyncWork(): boolean {
        return this.syncState.isSyncing
            || this.activeTransfers.size > 0
            || this.failedSyncs.length > 0
            || this.queueManager.getQueueSize() > 0
            || this.queueManager.getActiveTransfers() > 0;
    }

    public calculateStatus(): SyncStatusState {
        if (this.syncState.isSyncing) {
            let text = "Syncing...";
            if (this.syncState.currentPhase === SyncPhase.REQUESTING) text = "Starting sync...";
            else if (this.syncState.currentPhase === SyncPhase.PLANNING) text = "Looking for changes...";
            else if (this.syncState.currentPhase === SyncPhase.TRANSFERRING) text = `Syncing (${this.syncState.filesTransferred}/${this.syncState.filesTotal})...`;
            else if (this.syncState.currentPhase === SyncPhase.COMPLETING) text = "Finishing sync...";
            return { text, icon: "refresh-cw", spin: true, state: 'loading' };
        }
        if (this.activeTransfers.size > 0) {
            const count = Array.from(this.activeTransfers.values()).filter(t => t.status === 'active').length;
            if (count === 0 && this.activeTransfers.size > 0) return { text: "Sync paused", icon: "pause-circle", state: 'neutral' };
            return { text: `Syncing ${count} file${count > 1 ? 's' : ''}...`, icon: "arrow-up-down", spin: false, state: 'loading' };
        }
        if (this.queueManager.getActiveTransfers() > 0 || this.queueManager.getQueueSize() > 0) {
            const queueSize = this.queueManager.getQueueSize() + this.queueManager.getActiveTransfers();
            return { text: `Syncing (${queueSize} item${queueSize > 1 ? 's' : ''})`, icon: "hourglass", state: 'loading' };
        }
        if (this.getConnectionMode() === 'direct-ip') {
            const isAuto = this.settings.syncMode === 'auto';
            if (this.directIpServer) {
                const clientCount = this.directIpServer.getClients().length;
                return {
                    text: clientCount > 0
                        ? `Hosting (${clientCount} device${clientCount > 1 ? 's' : ''})`
                        : 'Hosting — waiting for devices',
                    icon: "server",
                    state: 'success'
                };
            }
            if (this.directIpClient) {
                const client = this.directIpClient;
                // Fatal error (e.g. PIN rejection) — non-recoverable
                if (client.isFatalError) {
                    return { text: 'Host rejected the token', icon: 'shield-off', state: 'error' };
                }
                // Backoff-reconnect in progress
                if (!client.isOpen) {
                    return { text: 'Reconnecting to host…', icon: 'refresh-cw', spin: true, state: 'loading' };
                }
                // Socket open but liveness not yet confirmed (waiting for first message)
                if (!client.isLive) {
                    return { text: 'Checking connection…', icon: 'plug', spin: true, state: 'loading' };
                }
                // Confirmed live connection
                return { text: isAuto ? 'Connected in Offline Mode' : 'Connected to offline host', icon: 'smartphone', state: 'success' };
            }
            return { text: "Offline Mode", icon: "network", state: 'neutral' };
        }
        // Not Offline Mode — that is the LAN-only connection. This is the signaling
        // server being unreachable; "Sync Offline" made people think they were already
        // in Offline Mode, or that they should switch to it.
        if (!this.peer || this.peer.disconnected) return { text: "Can't reach the sync network", icon: "wifi-off", state: 'error' };
        if (!this.peer.id) return { text: "Connecting...", icon: "plug", spin: true, state: 'loading' };
        if (this.connections.size > 0) {
            if (this.isTwoDeviceMode()) {
                const other = this.clusterPeers.get(Array.from(this.connections.keys())[0]);
                return { text: other ? `Synced with ${other.friendlyName}` : 'Synced', icon: "link", state: 'success' };
            }
            return { text: `Connected to ${this.connections.size} device${this.connections.size > 1 ? 's' : ''}`, icon: "users", state: 'success' };
        }
        return { text: "No devices connected", icon: "globe", state: 'neutral' };
    }

    private static readonly STATUS_COLORS: Record<SyncStatusState['state'], string> = {
        error: 'var(--text-error)',
        success: 'var(--text-success)',
        loading: 'var(--interactive-accent)',
        neutral: 'var(--text-muted)',
    };

    /**
     * Update the status bar, rebuilding DOM only when something actually changed.
     *
     * This is called from ~26 sites, including inside the chunk send loop. It used to
     * empty() the status bar item and re-run setIcon() (which parses and injects an SVG)
     * on every single call, and the 200 ms throttle did not apply when idle. Now the
     * elements are created once and only the changed parts are touched.
     */
    private clearStatusTimer() {
        if (this.statusTimer !== null) window.clearTimeout(this.statusTimer);
        this.statusTimer = null;
    }

    updateStatus(customStatus?: SyncStatusState) {
        if (this.unloaded) return;
        const now = Date.now();
        if (customStatus) {
            // Shown as given; a refresh owed from before must not paint over it.
            this.clearStatusTimer();
        } else {
            // At most one refresh per 200 ms — but the last one always happens. Dropping it
            // left the bar on whatever it said mid-burst ("Syncing 1 file…") until something
            // unrelated refreshed it.
            const wait = this.lastStatusUpdate + 200 - now;
            if (wait > 0) {
                if (this.statusTimer === null) {
                    this.statusTimer = window.setTimeout(() => {
                        this.statusTimer = null;
                        this.updateStatus();
                    }, wait);
                }
                return;
            }
            this.clearStatusTimer();
        }
        this.lastStatusUpdate = now;

        const status = customStatus || this.calculateStatus();

        // Build the container once.
        if (!this.statusIconEl || !this.statusTextEl) {
            this.statusBar.empty();
            const container = this.statusBar.createDiv({ cls: 'od-status-container' });
            container.onclick = () => {
                // 'loading' also covers Connecting / Reconnecting / Checking connection, which
                // used to open an empty Sync Progress modal. Only open it when the modal
                // actually has transfers, a full sync, or failed retries to show.
                if (this.hasVisibleSyncWork()) new SyncProgressModal(this.app, this).open();
                else new ConnectionModal(this.app, this).open();
            };
            container.addClass('mod-clickable');
            this.statusIconEl = container.createDiv({ cls: 'od-status-icon' });
            this.statusTextEl = container.createSpan();
            this.lastRenderedStatus = null;
        }

        const prev = this.lastRenderedStatus;
        if (prev && prev.text === status.text && prev.icon === status.icon
            && prev.spin === status.spin && prev.state === status.state) {
            return;
        }

        // setIcon replaces the element's children, so only re-run it on a real change.
        if (!prev || prev.icon !== status.icon) {
            setIcon(this.statusIconEl, status.icon);
        }
        if (!prev || prev.spin !== status.spin) {
            this.statusIconEl.toggleClass('lucide-spin', !!status.spin);
        }
        if (!prev || prev.state !== status.state) {
            this.statusIconEl.style.color = ObsidianDecentralizedPlugin.STATUS_COLORS[status.state];
        }
        if (!prev || prev.text !== status.text) {
            this.statusTextEl.setText(status.text);
        }

        this.lastRenderedStatus = status;
    }
}



