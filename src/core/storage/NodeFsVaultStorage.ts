import * as fs from 'fs/promises';
import * as path from 'path';
import {
    IVaultStorage,
    VaultFileEntry,
    VaultChangeEvent,
    FileStat,
    isBinaryPath
} from './IVaultStorage';

/**
 * Real filesystem storage adapter backed by Node.js fs/promises.
 * Used for end-to-end tests in temporary directories and standalone node daemons.
 */
export class NodeFsVaultStorage implements IVaultStorage {
    private readonly rootDir: string;
    private listeners: Set<(event: VaultChangeEvent) => void> = new Set();

    constructor(rootDir: string) {
        this.rootDir = path.resolve(rootDir);
    }

    /** The vault-relative key a path refers to: backslashes are separators, slashes at either end are noise. */
    private normalizeRel(relPath: string): string {
        return relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    }

    private resolveSafePath(relPath: string): string {
        const normalized = this.normalizeRel(relPath);
        // '' (and 'a/..') resolve to the vault root itself, where a delete would remove
        // every file at once and a write is meaningless.
        const target = path.resolve(this.rootDir, normalized);
        // The prefix check needs a separator boundary: 'C:\vault-old\x'.startsWith('C:\vault')
        // is true, so a plain startsWith let a sibling directory whose name extends the
        // root through — a path traversal into it. The boundary also rejects the root.
        if (!target.startsWith(this.rootDir + path.sep)) {
            throw new Error(`Path outside the vault: ${relPath}`);
        }
        return target;
    }

    public async read(relPath: string): Promise<string> {
        const fullPath = this.resolveSafePath(relPath);
        return await fs.readFile(fullPath, 'utf8');
    }

    public async readBinary(relPath: string): Promise<ArrayBuffer> {
        const fullPath = this.resolveSafePath(relPath);
        const buf = await fs.readFile(fullPath);
        const copy = new Uint8Array(buf.length);
        copy.set(buf);
        return copy.buffer;
    }

    public async write(relPath: string, content: string, mtime?: number): Promise<void> {
        const fullPath = this.resolveSafePath(relPath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });

        const existed = await this.exists(relPath);
        await fs.writeFile(fullPath, content, 'utf8');
        this.emit(existed ? 'modify' : 'create', this.normalizeRel(relPath), await this.observedMtime(fullPath, mtime));
    }

    public async writeBinary(relPath: string, content: ArrayBuffer, mtime?: number): Promise<void> {
        const fullPath = this.resolveSafePath(relPath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });

        const existed = await this.exists(relPath);
        await fs.writeFile(fullPath, Buffer.from(content));
        this.emit(existed ? 'modify' : 'create', this.normalizeRel(relPath), await this.observedMtime(fullPath, mtime));
    }

    /**
     * The mtime the file actually carries after a write: utimes is best-effort (platforms
     * truncate it or reject out-of-range values), and the surrogate hashes MerkleManager
     * builds for large files compare mtimes — an event reporting a requested-but-not-set
     * mtime made two identical files look eternally different.
     */
    private async observedMtime(fullPath: string, requested: number | undefined): Promise<number> {
        if (requested !== undefined) {
            const timeSec = requested / 1000;
            await fs.utimes(fullPath, timeSec, timeSec).catch(() => { /* best effort; stat below reports the truth */ });
        }
        const stats = await fs.stat(fullPath).catch(() => null);
        return stats ? Math.floor(stats.mtimeMs) : (requested ?? Date.now());
    }

    public async delete(relPath: string): Promise<void> {
        const fullPath = this.resolveSafePath(relPath);
        // One delete event per file the tree actually loses — the same shape the
        // InMemory adapter emits — and nothing at all when the path was already gone.
        const lost = await this.subtreeFiles(fullPath);
        await fs.rm(fullPath, { recursive: true, force: true });
        for (const rel of lost) this.emit('delete', rel, undefined);
    }

    /** Vault-relative paths of the files at or below `fullPath`, empty when it does not exist. */
    private async subtreeFiles(fullPath: string): Promise<string[]> {
        const stats = await fs.stat(fullPath).catch(() => null);
        if (!stats) return [];
        const out: string[] = [];
        const relOf = (p: string) => p.slice(this.rootDir.length + 1).replace(/\\/g, '/');
        if (!stats.isDirectory()) {
            out.push(relOf(fullPath));
            return out;
        }
        const walk = async (dir: string) => {
            let dirents;
            try {
                dirents = await fs.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const dirent of dirents) {
                const child = path.join(dir, dirent.name);
                if (dirent.isDirectory()) await walk(child);
                else if (dirent.isFile()) out.push(relOf(child));
            }
        };
        await walk(fullPath);
        return out;
    }

    public async rename(oldRelPath: string, newRelPath: string): Promise<void> {
        const oldFullPath = this.resolveSafePath(oldRelPath);
        const newFullPath = this.resolveSafePath(newRelPath);

        await fs.mkdir(path.dirname(newFullPath), { recursive: true });
        await fs.rename(oldFullPath, newFullPath);

        this.emit('rename', this.normalizeRel(newRelPath), undefined, this.normalizeRel(oldRelPath));
    }

    public async exists(relPath: string): Promise<boolean> {
        try {
            const fullPath = this.resolveSafePath(relPath);
            await fs.access(fullPath);
            return true;
        } catch {
            return false;
        }
    }

    public async stat(relPath: string): Promise<FileStat | null> {
        try {
            const fullPath = this.resolveSafePath(relPath);
            const stats = await fs.stat(fullPath);
            // A folder is not a file: the InMemory adapter has no stat for folders, and a
            // caller deciding "file versus folder" must see the same answer everywhere.
            if (stats.isDirectory()) return null;
            return {
                size: stats.size,
                mtime: Math.floor(stats.mtimeMs)
            };
        } catch {
            return null;
        }
    }

    public async listFiles(): Promise<VaultFileEntry[]> {
        const entries: VaultFileEntry[] = [];

        const walk = async (currentDir: string, relBase: string) => {
            let dirents;
            try {
                dirents = await fs.readdir(currentDir, { withFileTypes: true });
            } catch {
                return;
            }

            for (const dirent of dirents) {
                const subRel = relBase ? `${relBase}/${dirent.name}` : dirent.name;
                const fullPath = path.join(currentDir, dirent.name);

                if (dirent.isDirectory()) {
                    await walk(fullPath, subRel);
                } else if (dirent.isFile()) {
                    const stats = await fs.stat(fullPath).catch(() => null);
                    if (stats) {
                        entries.push({
                            path: subRel.replace(/\\/g, '/'),
                            size: stats.size,
                            mtime: Math.floor(stats.mtimeMs),
                            isBinary: isBinaryPath(subRel)
                        });
                    }
                }
            }
        };

        await walk(this.rootDir, '');
        return entries;
    }

    public async ensureDirectory(relDirPath: string): Promise<void> {
        const fullPath = this.resolveSafePath(relDirPath);
        await fs.mkdir(fullPath, { recursive: true });
    }

    public onVaultChange(listener: (event: VaultChangeEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(type: VaultChangeEvent['type'], path: string, mtime?: number, oldPath?: string) {
        const event: VaultChangeEvent = mtime !== undefined
            ? { type, path, mtime }
            : { type, path };
        if (oldPath !== undefined) event.oldPath = oldPath;
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (err) {
                console.error('Error in vault change listener:', err);
            }
        }
    }
}
