/**
 * Sync of Obsidian's own settings folder (`.obsidian`, or whatever the vault's config folder
 * is called on each device).
 *
 * The config folder is never part of the vault index, so none of the note machinery sees it.
 * This module scans an allowlist of files in it, remembers what it last saw (the baseline,
 * persisted in state.json), and exchanges changes with connected devices:
 *
 *   config-manifest  what this device has and has deleted — sent to each device on connect
 *   config-request   the files a device wants after comparing manifests
 *   config-file      one file, deflated, with its hash and modification time
 *   config-delete    a file this device deleted
 *
 * The more recent change wins (a deletion's time is when it happened); identical times go to
 * the smaller hash, then the lower device ID, so both ends agree. Settings are not notes: the
 * losing version is replaced, not kept as a copy. Files written here are recorded in the
 * baseline with the sender's time, so they are never sent back as a local change.
 *
 * Scope:
 *   appearance (Automatic mode)  appearance.json, snippets/*.css, themes/<name>/{manifest.json,theme.css}
 *   full (manual, opt-in)        also every top-level *.json except workspace*.json (the window
 *                                layout is per device), and plugins/<id>/{manifest.json,main.js,
 *                                styles.css,data.json} — never this plugin's own folder, whose
 *                                data.json holds this device's ID and pairing keys.
 *
 * Everything beyond appearance can run code (plugin files) or configure plugins that do, so it
 * is accepted only from devices sharing a pairing key, or over authenticated Offline Mode.
 */
import type { ConfigFileState, ConfigManifestPayload, ConfigRequestPayload, ConfigFilePayload, ConfigDeletePayload } from '../types';
import { newerVersion } from '../utils/versions';
import { compressBytes, decompressBytes } from '../utils';

export type ConfigScope = 'off' | 'appearance' | 'full';

/** Larger files are left alone (a plugin bundle is a few MB at most). */
export const MAX_CONFIG_FILE_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 5000;
const PLUGIN_FILES = new Set(['manifest.json', 'main.js', 'styles.css', 'data.json']);
const THEME_FILES = new Set(['manifest.json', 'theme.css']);

export interface ConfigSyncState {
    baseline: Record<string, ConfigFileState>;
    tombstones: Record<string, number>;
}

/** The parts of the adapter this uses — Obsidian's DataAdapter satisfies it. */
export interface ConfigAdapter {
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<{ type: 'file' | 'folder'; mtime: number; size: number } | null>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
    readBinary(path: string): Promise<ArrayBuffer>;
    writeBinary(path: string, data: ArrayBuffer, options?: { mtime?: number }): Promise<void>;
    mkdir(path: string): Promise<void>;
    trashSystem(path: string): Promise<boolean>;
    trashLocal(path: string): Promise<void>;
}

export interface ConfigSyncHost {
    adapter: ConfigAdapter;
    configDir(): string;
    /** This plugin's own folder, relative to the config folder (e.g. plugins/obsidian-decentralized). */
    ownPluginFolder(): string;
    scope(): ConfigScope;
    deviceId(): string;
    /** The real device ID behind a connection key. */
    peerDeviceId(peer: string): string;
    peerName(peer: string): string;
    /** Whether settings that can run code may be taken from this device. */
    trustedForCode(peer: string): boolean;
    connectedPeers(): string[];
    send(peer: string, message: ConfigManifestPayload | ConfigRequestPayload | ConfigFilePayload | ConfigDeletePayload): void;
    hash(data: ArrayBuffer): Promise<string>;
    notify(message: string): void;
    log(...args: any[]): void;
    stateChanged(): void;
}

/**
 * Whether `rel` (relative to the config folder) is a file this scope syncs. Anything odd —
 * `..`, backslashes, hidden segments — is out.
 */
export function isConfigPathInScope(rel: unknown, scope: ConfigScope, ownPluginFolder: string): rel is string {
    if (scope === 'off' || typeof rel !== 'string' || rel.length === 0 || rel.length > 256) return false;
    if (rel.includes('\\') || rel.includes('\0')) return false;
    const parts = rel.split('/');
    if (parts.some(p => p === '' || p === '.' || p === '..' || p.startsWith('.'))) return false;

    if (parts.length === 1) {
        if (rel === 'appearance.json') return true;
        return scope === 'full' && rel.endsWith('.json') && !rel.toLowerCase().startsWith('workspace');
    }
    if (parts.length === 2 && parts[0] === 'snippets') return parts[1].endsWith('.css');
    if (parts.length === 3 && parts[0] === 'themes') return THEME_FILES.has(parts[2]);
    if (parts.length === 3 && parts[0] === 'plugins') {
        return scope === 'full' && `plugins/${parts[1]}` !== ownPluginFolder && PLUGIN_FILES.has(parts[2]);
    }
    return false;
}

/** Appearance files only change how Obsidian looks; everything else can change what it does. */
export function isAppearanceFile(rel: string): boolean {
    return isConfigPathInScope(rel, 'appearance', '');
}

export class ConfigSync {
    state: ConfigSyncState = { baseline: {}, tombstones: {} };
    /**
     * Scans and applied changes run one at a time: a scan landing between writing a received
     * file and recording it would take it for a local change and send it straight back.
     */
    private chain: Promise<void> = Promise.resolve();
    private pendingScan: Promise<void> | null = null;
    /** False until the first scan: what is there then is the starting point, not a change. */
    private scannedOnce = false;
    private disposed = false;
    private appliedFrom = new Set<string>();
    private noticeTimer: ReturnType<typeof setTimeout> | null = null;
    private lastScope: ConfigScope;

    constructor(private host: ConfigSyncHost) {
        this.lastScope = host.scope();
    }

    load(saved: unknown) {
        if (!saved || typeof saved !== 'object') return;
        const s = saved as Partial<ConfigSyncState>;
        if (s.baseline && typeof s.baseline === 'object') this.state.baseline = { ...s.baseline };
        if (s.tombstones && typeof s.tombstones === 'object') this.state.tombstones = { ...s.tombstones };
        // A saved baseline is a starting point too: changes since are real changes.
        this.scannedOnce = Object.keys(this.state.baseline).length > 0;
    }

    dispose() {
        this.disposed = true;
        if (this.noticeTimer) clearTimeout(this.noticeTimer);
        this.noticeTimer = null;
    }

    private abs(rel: string): string {
        return `${this.host.configDir()}/${rel}`;
    }

    private inScope(rel: unknown): rel is string {
        return isConfigPathInScope(rel, this.host.scope(), this.host.ownPluginFolder());
    }

    /**
     * May `peer` change `rel` here, or see it? Beyond appearance, settings can run code or hold
     * other plugins' secrets, so they go only to and from devices sharing a pairing key (or
     * over Offline Mode, which authenticates both ends).
     */
    private trusts(peer: string, rel: string): boolean {
        return isAppearanceFile(rel) || this.host.trustedForCode(peer);
    }

    private acceptsFrom(peer: string, rel: string): boolean {
        if (this.trusts(peer, rel)) return true;
        this.host.log(`Config sync: not taking ${rel} from ${peer} — only paired devices may change plugins and settings.`);
        return false;
    }

    private exclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.chain.then(fn, fn);
        this.chain = run.then(() => undefined, () => undefined);
        return run;
    }

    // --- Local changes ---

    /**
     * Every in-scope file in the config folder, relative paths. Throws when a folder that
     * exists cannot be listed: read as "empty", that would look like every file in it had
     * been deleted, and the deletions would be sent to every other device.
     */
    private async listLocal(): Promise<string[]> {
        const { adapter } = this.host;
        const root = this.host.configDir();
        const found: string[] = [];
        const list = async (dir: string) => {
            if (!(await adapter.exists(dir))) return { files: [] as string[], folders: [] as string[] };
            return await adapter.list(dir);
        };
        const rel = (p: string) => p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
        const take = (paths: string[]) => { for (const p of paths) { const r = rel(p); if (this.inScope(r)) found.push(r); } };

        take((await list(root)).files);
        take((await list(`${root}/snippets`)).files);
        for (const theme of (await list(`${root}/themes`)).folders) take((await list(theme)).files);
        if (this.host.scope() === 'full') {
            for (const plugin of (await list(`${root}/plugins`)).folders) take((await list(plugin)).files);
        }
        return found;
    }

    /**
     * Compare the config folder with the baseline and send what changed. Runs on a timer, on
     * Obsidian's css-change, and before each manifest. Concurrent calls share one scan.
     */
    scan(): Promise<void> {
        if (!this.pendingScan) {
            this.pendingScan = this.exclusive(async () => {
                // Cleared as the scan starts, so a request made during it gets a fresh one.
                this.pendingScan = null;
                await this.doScan();
            });
        }
        return this.pendingScan;
    }

    private async doScan() {
        if (this.disposed || this.host.scope() === 'off') return;
        const announce = this.scannedOnce;
        const seen = new Set<string>();
        let changed = false;

        let local: string[];
        try {
            local = await this.listLocal();
        } catch (e) {
            this.host.log('Config sync: could not list the config folder; skipping this scan.', e);
            return;
        }
        for (const rel of local) {
            if (this.disposed) return;
            seen.add(rel);
            if (await this.refresh(rel, announce)) changed = true;
        }
        for (const rel of Object.keys(this.state.baseline)) {
            if (!seen.has(rel) && this.inScope(rel) && await this.refresh(rel, announce)) changed = true;
        }

        this.scannedOnce = true;
        if (changed) this.host.stateChanged();
    }

    /**
     * Bring one path's baseline up to date with the disk, sending a change (or deletion) to
     * connected devices when `announce` is set. True when the baseline changed.
     */
    private async refresh(rel: string, announce: boolean): Promise<boolean> {
        const { adapter } = this.host;
        const known = this.state.baseline[rel];
        let stat: Awaited<ReturnType<ConfigAdapter['stat']>>;
        try {
            stat = await adapter.stat(this.abs(rel));
        } catch (e) {
            // Unknown is not "deleted": a deletion would be sent to every other device.
            this.host.log(`Config sync: could not check ${rel}`, e);
            return false;
        }

        if (!stat || stat.type !== 'file') {
            if (!known) return false;
            // Gone since it was last seen: deleted here.
            delete this.state.baseline[rel];
            const at = Date.now();
            this.state.tombstones[rel] = at;
            if (announce) {
                for (const peer of this.host.connectedPeers()) {
                    if (this.trusts(peer, rel)) this.host.send(peer, { type: 'config-delete', configPath: rel, at });
                }
            }
            return true;
        }
        if (stat.size > MAX_CONFIG_FILE_BYTES) return false;
        if (known && known.mtime === stat.mtime && known.size === stat.size) return false;

        let hash: string;
        try {
            hash = await this.host.hash(await adapter.readBinary(this.abs(rel)));
        } catch (e) {
            this.host.log(`Config sync: could not read ${rel}`, e);
            return false;
        }
        this.state.baseline[rel] = { hash, mtime: stat.mtime, size: stat.size };
        delete this.state.tombstones[rel];
        // Touched without a change in content is not worth sending.
        if (announce && (!known || known.hash !== hash)) {
            for (const peer of this.host.connectedPeers()) await this.sendFile(peer, rel);
        }
        return true;
    }

    /** Refresh just `rel` before deciding about it — a full scan per received file is slow. */
    private async refreshOne(rel: string) {
        if (await this.refresh(rel, this.scannedOnce)) this.host.stateChanged();
    }

    // --- Talking to other devices ---

    /** A device connected: tell it what we have, so each side can take what it is missing. */
    onPeerConnected(peer: string): Promise<void> {
        return this.exclusive(async () => {
            if (this.host.scope() === 'off') return;
            await this.doScan();
            this.sendManifest(peer);
        });
    }

    /** Settings changed: a newly widened scope has files to offer. */
    onSettingsChanged(): Promise<void> {
        const scope = this.host.scope();
        if (scope === this.lastScope) return Promise.resolve();
        this.lastScope = scope;
        if (scope === 'off') return Promise.resolve();
        return this.exclusive(async () => {
            await this.doScan();
            for (const peer of this.host.connectedPeers()) this.sendManifest(peer);
        });
    }

    private sendManifest(peer: string) {
        const files = Object.entries(this.state.baseline)
            .filter(([rel]) => this.inScope(rel) && this.trusts(peer, rel))
            .slice(0, MAX_MANIFEST_ENTRIES)
            .map(([configPath, s]) => ({ configPath, ...s }));
        const deleted = Object.entries(this.state.tombstones)
            .filter(([rel]) => this.inScope(rel) && this.trusts(peer, rel))
            .slice(0, MAX_MANIFEST_ENTRIES)
            .map(([configPath, at]) => ({ configPath, at }));
        this.host.send(peer, { type: 'config-manifest', files, deleted });
    }

    private async sendFile(peer: string, rel: string) {
        if (!this.inScope(rel) || !this.trusts(peer, rel)) return;
        try {
            const stat = await this.host.adapter.stat(this.abs(rel));
            if (!stat || stat.type !== 'file' || stat.size > MAX_CONFIG_FILE_BYTES) return;
            const content = await this.host.adapter.readBinary(this.abs(rel));
            // Hashed as read, so the receiver's check matches what it gets.
            const hash = await this.host.hash(content);
            this.host.send(peer, { type: 'config-file', configPath: rel, mtime: stat.mtime, hash, data: compressBytes(new Uint8Array(content)) });
        } catch (e) {
            this.host.log(`Config sync: could not send ${rel}`, e);
        }
    }

    /** Does the remote version (at `remoteMtime`) beat what this device has for `rel`? */
    private remoteWins(peer: string, rel: string, remote: { mtime: number; hash?: string }, local: { mtime: number; hash?: string }): boolean {
        return newerVersion(
            { mtime: remote.mtime, hash: remote.hash, deviceId: this.host.peerDeviceId(peer) },
            { mtime: local.mtime, hash: local.hash, deviceId: this.host.deviceId() },
        ) === 'a';
    }

    handleManifest(msg: ConfigManifestPayload, peer: string): Promise<void> {
        return this.exclusive(() => this.applyManifest(msg, peer));
    }

    private async applyManifest(msg: ConfigManifestPayload, peer: string) {
        if (this.host.scope() === 'off') return;
        await this.doScan();
        const wanted: string[] = [];
        const files = Array.isArray(msg.files) ? msg.files.slice(0, MAX_MANIFEST_ENTRIES) : [];
        for (const entry of files) {
            const rel = entry?.configPath;
            if (!this.inScope(rel) || typeof entry.hash !== 'string' || !Number.isFinite(entry.mtime)) continue;
            if (!this.acceptsFrom(peer, rel)) continue;
            const local = this.state.baseline[rel];
            if (local) {
                if (local.hash !== entry.hash && this.remoteWins(peer, rel, entry, local)) wanted.push(rel);
                continue;
            }
            const deletedAt = this.state.tombstones[rel];
            if (deletedAt !== undefined && !this.remoteWins(peer, rel, entry, { mtime: deletedAt })) {
                // Deleted here after their copy last changed: they should delete it too.
                this.host.send(peer, { type: 'config-delete', configPath: rel, at: deletedAt });
                continue;
            }
            wanted.push(rel);
        }
        const deleted = Array.isArray(msg.deleted) ? msg.deleted.slice(0, MAX_MANIFEST_ENTRIES) : [];
        for (const entry of deleted) {
            if (entry && this.inScope(entry.configPath) && Number.isFinite(entry.at)) {
                await this.applyDelete(entry.configPath, entry.at, peer);
            }
        }
        if (wanted.length) this.host.send(peer, { type: 'config-request', configPaths: wanted });
    }

    handleRequest(msg: ConfigRequestPayload, peer: string): Promise<void> {
        return this.exclusive(async () => {
            const paths = Array.isArray(msg.configPaths) ? msg.configPaths.slice(0, MAX_MANIFEST_ENTRIES) : [];
            for (const rel of paths) {
                // Only what this device syncs and actually has — never its own folder.
                if (this.inScope(rel) && this.state.baseline[rel]) await this.sendFile(peer, rel);
            }
        });
    }

    handleFile(msg: ConfigFilePayload, peer: string): Promise<void> {
        return this.exclusive(() => this.applyFile(msg, peer));
    }

    private async applyFile(msg: ConfigFilePayload, peer: string) {
        const rel = msg.configPath;
        if (!this.inScope(rel) || !this.acceptsFrom(peer, rel)) return;
        if (typeof msg.hash !== 'string' || !Number.isFinite(msg.mtime) || !msg.data) return;
        let bytes: Uint8Array;
        try {
            bytes = decompressBytes(msg.data, MAX_CONFIG_FILE_BYTES);
        } catch (e) {
            this.host.log(`Config sync: unreadable ${rel} from ${peer}`, e);
            return;
        }
        const content = bytes.slice().buffer;
        if (await this.host.hash(content) !== msg.hash) {
            this.host.log(`Config sync: ${rel} from ${peer} did not match its hash; ignored.`);
            return;
        }

        await this.refreshOne(rel);
        const local = this.state.baseline[rel];
        if (local) {
            if (local.hash === msg.hash) return;
            if (!this.remoteWins(peer, rel, msg, local)) {
                // Ours is newer: make sure they get it.
                await this.sendFile(peer, rel);
                return;
            }
        } else {
            const deletedAt = this.state.tombstones[rel];
            if (deletedAt !== undefined && !this.remoteWins(peer, rel, msg, { mtime: deletedAt })) {
                this.host.send(peer, { type: 'config-delete', configPath: rel, at: deletedAt });
                return;
            }
        }

        try {
            await this.ensureParents(rel);
            await this.host.adapter.writeBinary(this.abs(rel), content, { mtime: msg.mtime });
        } catch (e) {
            this.host.log(`Config sync: could not write ${rel}`, e);
            return;
        }
        // Recorded as it is on disk now, so the next scan does not send it back.
        const stat = await this.host.adapter.stat(this.abs(rel)).catch(() => null);
        this.state.baseline[rel] = { hash: msg.hash, mtime: stat?.mtime ?? msg.mtime, size: bytes.byteLength };
        delete this.state.tombstones[rel];
        this.host.stateChanged();
        this.noteApplied(peer);
    }

    handleDelete(msg: ConfigDeletePayload, peer: string): Promise<void> {
        return this.exclusive(async () => {
            if (!this.inScope(msg.configPath) || !Number.isFinite(msg.at)) return;
            await this.refreshOne(msg.configPath);
            await this.applyDelete(msg.configPath, msg.at, peer);
        });
    }

    private async applyDelete(rel: string, at: number, peer: string) {
        if (!this.acceptsFrom(peer, rel)) return;
        const local = this.state.baseline[rel];
        if (!local) {
            if ((this.state.tombstones[rel] ?? -Infinity) < at) {
                this.state.tombstones[rel] = at;
                this.host.stateChanged();
            }
            return;
        }
        if (!this.remoteWins(peer, rel, { mtime: at }, local)) {
            // Changed here after they deleted it: offer ours back.
            await this.sendFile(peer, rel);
            return;
        }
        const path = this.abs(rel);
        try {
            const trashed = await this.host.adapter.trashSystem(path).catch(() => false);
            if (!trashed) await this.host.adapter.trashLocal(path);
        } catch (e) {
            this.host.log(`Config sync: could not remove ${rel}`, e);
            return;
        }
        delete this.state.baseline[rel];
        this.state.tombstones[rel] = at;
        this.host.stateChanged();
        this.noteApplied(peer);
    }

    private async ensureParents(rel: string) {
        const parts = rel.split('/');
        let dir = this.host.configDir();
        for (const part of parts.slice(0, -1)) {
            dir = `${dir}/${part}`;
            if (!(await this.host.adapter.exists(dir))) await this.host.adapter.mkdir(dir);
        }
    }

    /** One notice per burst of applied settings, naming where they came from. */
    private noteApplied(peer: string) {
        this.appliedFrom.add(this.host.peerName(peer));
        if (this.noticeTimer) return;
        this.noticeTimer = setTimeout(() => {
            this.noticeTimer = null;
            if (this.disposed) return;
            const from = Array.from(this.appliedFrom).join(', ');
            this.appliedFrom.clear();
            this.host.notify(`Obsidian settings from ${from} were copied to this device. Restart Obsidian, or run “Reload app without saving”, to use them.`);
        }, 1500);
    }
}
