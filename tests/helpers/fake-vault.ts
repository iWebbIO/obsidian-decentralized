/**
 * In-memory Obsidian vault for driving the real plugin class in tests.
 *
 * Mirrors the behaviour the plugin relies on:
 * - Vault events fire synchronously inside the write that causes them, so the plugin's
 *   ignoreNextEventForPath() (set just before a write) suppresses the echo, as in Obsidian.
 * - Paths with a hidden segment (`.obsidian/…`) are stored but never indexed: they are
 *   invisible to getAbstractFileByPath/getAllLoadedFiles and fire no vault events, and are
 *   reachable only through the adapter — exactly why config sync needs the adapter.
 * - create()/rename() need the parent folder to exist; createFolder() creates intermediates.
 */
import { TAbstractFile, TFile, TFolder } from 'obsidian';

type Stored = { data: Uint8Array; ctime: number; mtime: number };
type Listener = (...args: any[]) => any;
type WriteOptions = { ctime?: number; mtime?: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBytes(data: string | ArrayBuffer | Uint8Array): Uint8Array {
    if (typeof data === 'string') return encoder.encode(data);
    if (data instanceof Uint8Array) return new Uint8Array(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    throw new TypeError(`FakeVault: unsupported data ${Object.prototype.toString.call(data)}`);
}

function normalize(path: string): string {
    const cleaned = String(path).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    return cleaned;
}

export function isHiddenPath(path: string): boolean {
    return normalize(path).split('/').some(segment => segment.startsWith('.'));
}

function parentOf(path: string): string {
    const i = path.lastIndexOf('/');
    return i === -1 ? '' : path.slice(0, i);
}

class EventHub {
    private handlers = new Map<string, Listener[]>();
    on(name: string, callback: Listener) {
        const list = this.handlers.get(name) ?? [];
        list.push(callback);
        this.handlers.set(name, list);
        return { off: () => this.off(name, callback) };
    }
    off(name: string, callback: Listener) {
        const list = this.handlers.get(name);
        if (list) this.handlers.set(name, list.filter(l => l !== callback));
    }
    trigger(name: string, ...args: any[]) {
        for (const handler of [...(this.handlers.get(name) ?? [])]) handler(...args);
    }
    count(name: string): number {
        return this.handlers.get(name)?.length ?? 0;
    }
}

export class FakeVault {
    configDir = '.obsidian';
    readonly root: TFolder;
    readonly adapter: FakeAdapter;
    /** Clock for mtimes when a write passes none. */
    now: () => number = () => Date.now();
    /** Paths removed through trash()/fileManager.trashFile()/adapter trash (tests only). */
    trashed: string[] = [];

    private index = new Map<string, TAbstractFile>();
    readonly store = new Map<string, Stored>();
    readonly folders = new Set<string>();
    private events = new EventHub();

    constructor() {
        this.root = new TFolder();
        (this.root as any).setPath('/');
        this.root.vault = this as any;
        this.index.set('/', this.root);
        this.adapter = new FakeAdapter(this);
        this.folders.add(this.configDir);
        this.folders.add(`${this.configDir}/plugins`);
    }

    // --- events ---------------------------------------------------------------

    on(name: string, callback: Listener) {
        return this.events.on(name, callback);
    }
    offref(ref: { off: () => void }) {
        ref.off();
    }
    trigger(name: string, ...args: any[]) {
        this.events.trigger(name, ...args);
    }
    listenerCount(name: string): number {
        return this.events.count(name);
    }

    // --- lookup ---------------------------------------------------------------

    getAbstractFileByPath(path: string): TAbstractFile | null {
        const p = normalize(path);
        if (p === '') return this.root;
        return this.index.get(p) ?? null;
    }
    getAllLoadedFiles(): TAbstractFile[] {
        return [...this.index.values()];
    }
    getFiles(): TFile[] {
        return [...this.index.values()].filter((f): f is TFile => f instanceof TFile);
    }
    getMarkdownFiles(): TFile[] {
        return this.getFiles().filter(f => f.extension === 'md');
    }
    getRoot(): TFolder {
        return this.root;
    }

    // --- reads ----------------------------------------------------------------

    private bytesOf(file: TAbstractFile): Uint8Array {
        const stored = this.store.get(file.path);
        if (!stored) throw new Error(`File not found: ${file.path}`);
        return stored.data;
    }
    async read(file: TFile): Promise<string> {
        return decoder.decode(this.bytesOf(file));
    }
    async cachedRead(file: TFile): Promise<string> {
        return this.read(file);
    }
    async readBinary(file: TFile): Promise<ArrayBuffer> {
        const bytes = this.bytesOf(file);
        return bytes.slice().buffer;
    }

    // --- writes ---------------------------------------------------------------

    async create(path: string, data: string, options?: WriteOptions): Promise<TFile> {
        return this.createFile(path, toBytes(data), options);
    }
    async createBinary(path: string, data: ArrayBuffer, options?: WriteOptions): Promise<TFile> {
        return this.createFile(path, toBytes(data), options);
    }
    async createFolder(path: string): Promise<TFolder> {
        const p = normalize(path);
        if (this.folders.has(p) || this.store.has(p)) throw new Error('Folder already exists.');
        return this.ensureFolder(p);
    }
    async modify(file: TFile, data: string, options?: WriteOptions): Promise<void> {
        this.modifyFile(file, toBytes(data), options);
    }
    async modifyBinary(file: TFile, data: ArrayBuffer, options?: WriteOptions): Promise<void> {
        this.modifyFile(file, toBytes(data), options);
    }
    async process(file: TFile, fn: (data: string) => string, options?: WriteOptions): Promise<string> {
        const next = fn(await this.read(file));
        this.modifyFile(file, toBytes(next), options);
        return next;
    }
    async delete(file: TAbstractFile, _force?: boolean): Promise<void> {
        this.removeTree(file);
    }
    async trash(file: TAbstractFile, _system: boolean): Promise<void> {
        this.trashed.push(file.path);
        this.removeTree(file);
    }
    async rename(file: TAbstractFile, newPath: string): Promise<void> {
        this.move(file, normalize(newPath));
    }

    // --- test helpers ---------------------------------------------------------

    /** Seed a file (and its folders) without going through the plugin's event handlers. */
    seed(path: string, content: string | Uint8Array, mtime?: number) {
        const p = normalize(path);
        const bytes = toBytes(content);
        const now = mtime ?? this.now();
        if (isHiddenPath(p)) {
            this.ensureHiddenFolder(parentOf(p));
            this.store.set(p, { data: bytes, ctime: now, mtime: now });
            return;
        }
        this.ensureFolder(parentOf(p), false);
        const existing = this.index.get(p);
        if (existing instanceof TFile) {
            this.store.set(p, { data: bytes, ctime: existing.stat.ctime, mtime: now });
            existing.stat = { ctime: existing.stat.ctime, mtime: now, size: bytes.byteLength };
            return;
        }
        this.addFile(p, bytes, { mtime: now, ctime: now }, false);
    }
    /** UTF-8 content at `path`, or null (tests only). Hidden paths included. */
    text(path: string): string | null {
        const stored = this.store.get(normalize(path));
        return stored ? decoder.decode(stored.data) : null;
    }
    has(path: string): boolean {
        const p = normalize(path);
        return this.store.has(p) || this.folders.has(p);
    }

    // --- internals ------------------------------------------------------------

    private createFile(path: string, bytes: Uint8Array, options?: WriteOptions): TFile {
        const p = normalize(path);
        if (!p) throw new Error('Invalid path');
        if (this.store.has(p) || this.folders.has(p)) throw new Error('File already exists.');
        const parent = parentOf(p);
        if (parent && !this.folders.has(parent)) throw new Error(`Parent folder does not exist: ${parent}`);
        if (isHiddenPath(p)) {
            // Obsidian writes the file to disk but never indexes a dot-path.
            const now = this.now();
            this.store.set(p, { data: bytes, ctime: options?.ctime ?? now, mtime: options?.mtime ?? now });
            const detached = new TFile();
            (detached as any).setPath(p);
            return detached;
        }
        const now = this.now();
        return this.addFile(p, bytes, { ctime: options?.ctime ?? now, mtime: options?.mtime ?? now }, true);
    }

    private addFile(path: string, bytes: Uint8Array, times: { ctime: number; mtime: number }, emit: boolean): TFile {
        const file = new TFile();
        (file as any).setPath(path);
        file.vault = this as any;
        file.stat = { ctime: times.ctime, mtime: times.mtime, size: bytes.byteLength };
        const parent = this.getAbstractFileByPath(parentOf(path)) as TFolder;
        file.parent = parent;
        parent.children.push(file);
        this.index.set(path, file);
        this.store.set(path, { data: bytes, ctime: times.ctime, mtime: times.mtime });
        if (emit) this.trigger('create', file);
        return file;
    }

    private modifyFile(file: TFile, bytes: Uint8Array, options?: WriteOptions) {
        if (this.index.get(file.path) !== file) throw new Error(`File not found: ${file.path}`);
        const mtime = options?.mtime ?? this.now();
        const stored = this.store.get(file.path)!;
        this.store.set(file.path, { data: bytes, ctime: stored.ctime, mtime });
        file.stat = { ctime: stored.ctime, mtime, size: bytes.byteLength };
        this.trigger('modify', file);
    }

    private ensureFolder(path: string, emit = true): TFolder {
        const p = normalize(path);
        if (p === '') return this.root;
        if (isHiddenPath(p)) {
            this.ensureHiddenFolder(p);
            const detached = new TFolder();
            (detached as any).setPath(p);
            return detached;
        }
        const existing = this.index.get(p);
        if (existing instanceof TFolder) return existing;
        if (existing) throw new Error(`A file already exists at ${p}`);
        const parent = this.ensureFolder(parentOf(p), emit);
        const folder = new TFolder();
        (folder as any).setPath(p);
        folder.vault = this as any;
        folder.parent = parent;
        parent.children.push(folder);
        this.index.set(p, folder);
        this.folders.add(p);
        if (emit) this.trigger('create', folder);
        return folder;
    }

    ensureHiddenFolder(path: string) {
        const p = normalize(path);
        if (!p) return;
        let current = '';
        for (const segment of p.split('/')) {
            current = current ? `${current}/${segment}` : segment;
            this.folders.add(current);
        }
    }

    private detach(file: TAbstractFile) {
        const parent = file.parent;
        if (parent) parent.children = parent.children.filter(c => c !== file);
        file.parent = null;
        this.index.delete(file.path);
    }

    private removeTree(file: TAbstractFile) {
        if (file instanceof TFolder) {
            for (const child of [...file.children]) this.removeTree(child);
            this.folders.delete(file.path);
        } else {
            this.store.delete(file.path);
        }
        this.detach(file);
        this.trigger('delete', file);
    }

    private move(file: TAbstractFile, newPath: string) {
        if (this.index.get(file.path) !== file) throw new Error(`File not found: ${file.path}`);
        if (!newPath || this.store.has(newPath) || this.folders.has(newPath)) {
            throw new Error('Destination file already exists!');
        }
        const newParent = parentOf(newPath);
        if (newParent && !this.folders.has(newParent)) throw new Error(`Parent folder does not exist: ${newParent}`);
        const oldPath = file.path;

        if (isHiddenPath(newPath)) {
            // The bytes land on disk inside a dot-folder, where the vault can no longer see them.
            this.relocateBytes(file, oldPath, newPath);
            this.detachTree(file);
            this.trigger('delete', file);
            return;
        }

        this.relocateBytes(file, oldPath, newPath);
        const renamed: Array<[TAbstractFile, string]> = [];
        const retarget = (f: TAbstractFile, from: string, to: string) => {
            this.index.delete(from);
            (f as any).setPath(to);
            this.index.set(to, f);
            renamed.push([f, from]);
            if (f instanceof TFolder) {
                this.folders.delete(from);
                this.folders.add(to);
                for (const child of f.children) retarget(child, child.path, `${to}/${child.name}`);
            }
        };
        const oldParentFolder = file.parent;
        if (oldParentFolder) oldParentFolder.children = oldParentFolder.children.filter(c => c !== file);
        retarget(file, oldPath, newPath);
        const parentFolder = this.getAbstractFileByPath(newParent) as TFolder;
        file.parent = parentFolder;
        parentFolder.children.push(file);
        for (const [f, from] of renamed) this.trigger('rename', f, from);
    }

    private relocateBytes(file: TAbstractFile, oldPath: string, newPath: string) {
        if (file instanceof TFolder) {
            const prefix = `${oldPath}/`;
            for (const key of [...this.store.keys()]) {
                if (key.startsWith(prefix)) {
                    this.store.set(`${newPath}/${key.slice(prefix.length)}`, this.store.get(key)!);
                    this.store.delete(key);
                }
            }
            for (const key of [...this.folders]) {
                if (key === oldPath || key.startsWith(prefix)) {
                    this.folders.delete(key);
                    this.folders.add(newPath + key.slice(oldPath.length));
                }
            }
        } else {
            this.store.set(newPath, this.store.get(oldPath)!);
            this.store.delete(oldPath);
        }
    }

    private detachTree(file: TAbstractFile) {
        if (file instanceof TFolder) for (const child of [...file.children]) this.detachTree(child);
        this.detach(file);
    }
}

/** DataAdapter over the same byte store. Only hidden paths may be written through it. */
export class FakeAdapter {
    constructor(private vault: FakeVault) { }

    private guardHidden(path: string) {
        if (!isHiddenPath(path)) {
            throw new Error(`FakeAdapter: ${path} is an indexed vault path — use the Vault API`);
        }
    }

    async exists(path: string): Promise<boolean> {
        return this.vault.has(path);
    }
    async stat(path: string): Promise<{ type: 'file' | 'folder'; ctime: number; mtime: number; size: number } | null> {
        const p = normalize(path);
        const stored = this.vault.store.get(p);
        if (stored) return { type: 'file', ctime: stored.ctime, mtime: stored.mtime, size: stored.data.byteLength };
        if (this.vault.folders.has(p)) return { type: 'folder', ctime: 0, mtime: 0, size: 0 };
        return null;
    }
    async list(path: string): Promise<{ files: string[]; folders: string[] }> {
        const p = normalize(path);
        if (!this.vault.folders.has(p)) throw new Error(`ENOENT: no such directory ${p}`);
        const prefix = `${p}/`;
        const direct = (key: string) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/');
        return {
            files: [...this.vault.store.keys()].filter(direct).sort(),
            folders: [...this.vault.folders].filter(direct).sort(),
        };
    }
    async read(path: string): Promise<string> {
        const stored = this.vault.store.get(normalize(path));
        if (!stored) throw new Error(`ENOENT: no such file ${path}`);
        return decoder.decode(stored.data);
    }
    async readBinary(path: string): Promise<ArrayBuffer> {
        const stored = this.vault.store.get(normalize(path));
        if (!stored) throw new Error(`ENOENT: no such file ${path}`);
        return stored.data.slice().buffer;
    }
    async write(path: string, data: string, options?: WriteOptions): Promise<void> {
        this.writeBytes(path, toBytes(data), options);
    }
    async writeBinary(path: string, data: ArrayBuffer, options?: WriteOptions): Promise<void> {
        this.writeBytes(path, toBytes(data), options);
    }
    private writeBytes(path: string, bytes: Uint8Array, options?: WriteOptions) {
        const p = normalize(path);
        this.guardHidden(p);
        const parent = parentOf(p);
        if (parent && !this.vault.folders.has(parent)) throw new Error(`ENOENT: no such directory ${parent}`);
        const now = this.vault.now();
        const previous = this.vault.store.get(p);
        this.vault.store.set(p, {
            data: bytes,
            ctime: options?.ctime ?? previous?.ctime ?? now,
            mtime: options?.mtime ?? now,
        });
    }
    async mkdir(path: string): Promise<void> {
        const p = normalize(path);
        this.guardHidden(p);
        this.vault.ensureHiddenFolder(p);
    }
    async remove(path: string): Promise<void> {
        const p = normalize(path);
        this.guardHidden(p);
        if (!this.vault.store.delete(p)) throw new Error(`ENOENT: no such file ${p}`);
    }
    async rmdir(path: string, recursive: boolean): Promise<void> {
        const p = normalize(path);
        this.guardHidden(p);
        const prefix = `${p}/`;
        const hasChildren = [...this.vault.store.keys(), ...this.vault.folders].some(k => k.startsWith(prefix));
        if (hasChildren && !recursive) throw new Error(`ENOTEMPTY: ${p}`);
        for (const key of [...this.vault.store.keys()]) if (key.startsWith(prefix)) this.vault.store.delete(key);
        for (const key of [...this.vault.folders]) if (key === p || key.startsWith(prefix)) this.vault.folders.delete(key);
    }
    async rename(from: string, to: string): Promise<void> {
        const a = normalize(from);
        const b = normalize(to);
        this.guardHidden(a);
        this.guardHidden(b);
        const stored = this.vault.store.get(a);
        if (!stored) throw new Error(`ENOENT: no such file ${a}`);
        this.vault.store.set(b, stored);
        this.vault.store.delete(a);
    }
    async trashSystem(path: string): Promise<boolean> {
        await this.trashLocal(path);
        return true;
    }
    async trashLocal(path: string): Promise<void> {
        const p = normalize(path);
        this.guardHidden(p);
        this.vault.trashed.push(p);
        if (this.vault.store.has(p)) this.vault.store.delete(p);
        else await this.rmdir(p, true);
    }
}

export class FakeWorkspace {
    layoutReady = true;
    /** What getActiveViewOfType() returns (tests only). */
    activeView: any = null;
    private readyCallbacks: Listener[] = [];
    private events = new EventHub();

    onLayoutReady(callback: Listener) {
        if (this.layoutReady) callback();
        else this.readyCallbacks.push(callback);
    }
    /** Flip to ready and run queued callbacks (tests only). */
    finishLayout() {
        this.layoutReady = true;
        const queued = this.readyCallbacks;
        this.readyCallbacks = [];
        for (const cb of queued) cb();
    }
    on(name: string, callback: Listener) {
        return this.events.on(name, callback);
    }
    offref(ref: { off: () => void }) {
        ref.off();
    }
    trigger(name: string, ...args: any[]) {
        this.events.trigger(name, ...args);
    }
    getActiveViewOfType(_type: unknown) {
        return this.activeView;
    }
    getActiveFile() {
        return this.activeView?.file ?? null;
    }
}

export class FakeFileManager {
    constructor(private vault: FakeVault) { }
    async trashFile(file: TAbstractFile): Promise<void> {
        await this.vault.trash(file, true);
    }
}

export class FakeApp {
    readonly workspace = new FakeWorkspace();
    readonly fileManager: FakeFileManager;
    constructor(readonly vault: FakeVault = new FakeVault()) {
        this.fileManager = new FakeFileManager(vault);
    }
}
