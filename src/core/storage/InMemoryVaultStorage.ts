import {
    IVaultStorage,
    VaultFileEntry,
    VaultChangeEvent,
    FileStat,
    isBinaryPath
} from './IVaultStorage';

interface StoredFile {
    data: Uint8Array;
    mtime: number;
}

/**
 * High-performance in-memory vault storage.
 * Designed for microsecond multi-instance simulation tests with zero disk I/O.
 */
export class InMemoryVaultStorage implements IVaultStorage {
    private files: Map<string, StoredFile> = new Map();
    private listeners: Set<(event: VaultChangeEvent) => void> = new Set();
    private encoder = new TextEncoder();
    private decoder = new TextDecoder();

    private normalize(path: string): string {
        return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    }

    public async read(path: string): Promise<string> {
        const norm = this.normalize(path);
        const file = this.files.get(norm);
        if (!file) {
            throw new Error(`File not found: ${path}`);
        }
        return this.decoder.decode(file.data);
    }

    public async readBinary(path: string): Promise<ArrayBuffer> {
        const norm = this.normalize(path);
        const file = this.files.get(norm);
        if (!file) {
            throw new Error(`File not found: ${path}`);
        }
        // Return a fresh copy of the ArrayBuffer slice
        const copy = new Uint8Array(file.data.length);
        copy.set(file.data);
        return copy.buffer;
    }

    public async write(path: string, content: string, mtime?: number): Promise<void> {
        const norm = this.normalize(path);
        const data = this.encoder.encode(content);
        const exists = this.files.has(norm);
        let fileMtime = mtime ?? Date.now();
        if (exists && mtime === undefined) {
            const prevMtime = this.files.get(norm)!.mtime;
            if (fileMtime <= prevMtime) fileMtime = prevMtime + 1;
        }

        this.files.set(norm, { data, mtime: fileMtime });

        this.emit({
            type: exists ? 'modify' : 'create',
            path: norm,
            mtime: fileMtime
        });
    }

    public async writeBinary(path: string, content: ArrayBuffer, mtime?: number): Promise<void> {
        const norm = this.normalize(path);
        const data = new Uint8Array(content.slice(0));
        const exists = this.files.has(norm);
        let fileMtime = mtime ?? Date.now();
        if (exists && mtime === undefined) {
            const prevMtime = this.files.get(norm)!.mtime;
            if (fileMtime <= prevMtime) fileMtime = prevMtime + 1;
        }

        this.files.set(norm, { data, mtime: fileMtime });

        this.emit({
            type: exists ? 'modify' : 'create',
            path: norm,
            mtime: fileMtime
        });
    }

    public async delete(path: string): Promise<void> {
        const norm = this.normalize(path);
        if (this.files.has(norm)) {
            this.files.delete(norm);
            this.emit({ type: 'delete', path: norm });
            return;
        }

        // Folder deletion: delete any file starting with norm + '/'
        const prefix = norm + '/';
        const toDelete: string[] = [];
        for (const key of this.files.keys()) {
            if (key.startsWith(prefix)) {
                toDelete.push(key);
            }
        }

        for (const k of toDelete) {
            this.files.delete(k);
            this.emit({ type: 'delete', path: k });
        }
    }

    public async rename(oldPath: string, newPath: string): Promise<void> {
        const oldNorm = this.normalize(oldPath);
        const newNorm = this.normalize(newPath);

        if (this.files.has(oldNorm)) {
            const entry = this.files.get(oldNorm)!;
            this.files.delete(oldNorm);
            this.files.set(newNorm, entry);
            this.emit({ type: 'rename', path: newNorm, oldPath: oldNorm, mtime: entry.mtime });
            return;
        }

        // Folder rename
        const oldPrefix = oldNorm + '/';
        const newPrefix = newNorm + '/';
        const renames: Array<{ from: string; to: string; entry: StoredFile }> = [];

        for (const [key, entry] of this.files.entries()) {
            if (key.startsWith(oldPrefix)) {
                renames.push({
                    from: key,
                    to: newPrefix + key.substring(oldPrefix.length),
                    entry
                });
            }
        }

        for (const { from, to, entry } of renames) {
            this.files.delete(from);
            this.files.set(to, entry);
            this.emit({ type: 'rename', path: to, oldPath: from, mtime: entry.mtime });
        }
    }

    public async exists(path: string): Promise<boolean> {
        const norm = this.normalize(path);
        if (this.files.has(norm)) return true;

        // Check if it's a folder containing files
        const prefix = norm + '/';
        for (const key of this.files.keys()) {
            if (key.startsWith(prefix)) return true;
        }
        return false;
    }

    public async stat(path: string): Promise<FileStat | null> {
        const norm = this.normalize(path);
        const file = this.files.get(norm);
        if (!file) return null;
        return {
            size: file.data.byteLength,
            mtime: file.mtime
        };
    }

    public async listFiles(): Promise<VaultFileEntry[]> {
        const entries: VaultFileEntry[] = [];
        for (const [path, file] of this.files.entries()) {
            entries.push({
                path,
                size: file.data.byteLength,
                mtime: file.mtime,
                isBinary: isBinaryPath(path)
            });
        }
        return entries;
    }

    public async ensureDirectory(_dirPath: string): Promise<void> {
        // In-memory file storage creates directories implicitly
    }

    public onVaultChange(listener: (event: VaultChangeEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(event: VaultChangeEvent) {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (err) {
                console.error('Error in vault change listener:', err);
            }
        }
    }

    /** Helper for tests: clears all files and listeners. */
    public clear() {
        this.files.clear();
        this.listeners.clear();
    }
}
