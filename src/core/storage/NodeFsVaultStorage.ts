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

    private resolveSafePath(relPath: string): string {
        const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
        const target = path.resolve(this.rootDir, normalized);
        if (!target.startsWith(this.rootDir)) {
            throw new Error(`Path traversal attempt detected: ${relPath}`);
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

        if (mtime !== undefined) {
            const timeSec = mtime / 1000;
            await fs.utimes(fullPath, timeSec, timeSec).catch(() => {});
        }

        const normRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
        this.emit({
            type: existed ? 'modify' : 'create',
            path: normRel,
            mtime: mtime ?? Date.now()
        });
    }

    public async writeBinary(relPath: string, content: ArrayBuffer, mtime?: number): Promise<void> {
        const fullPath = this.resolveSafePath(relPath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });

        const existed = await this.exists(relPath);
        await fs.writeFile(fullPath, Buffer.from(content));

        if (mtime !== undefined) {
            const timeSec = mtime / 1000;
            await fs.utimes(fullPath, timeSec, timeSec).catch(() => {});
        }

        const normRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
        this.emit({
            type: existed ? 'modify' : 'create',
            path: normRel,
            mtime: mtime ?? Date.now()
        });
    }

    public async delete(relPath: string): Promise<void> {
        const fullPath = this.resolveSafePath(relPath);
        await fs.rm(fullPath, { recursive: true, force: true });
        const normRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
        this.emit({ type: 'delete', path: normRel });
    }

    public async rename(oldRelPath: string, newRelPath: string): Promise<void> {
        const oldFullPath = this.resolveSafePath(oldRelPath);
        const newFullPath = this.resolveSafePath(newRelPath);

        await fs.mkdir(path.dirname(newFullPath), { recursive: true });
        await fs.rename(oldFullPath, newFullPath);

        const normOld = oldRelPath.replace(/\\/g, '/').replace(/^\/+/, '');
        const normNew = newRelPath.replace(/\\/g, '/').replace(/^\/+/, '');
        this.emit({ type: 'rename', path: normNew, oldPath: normOld });
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

    private emit(event: VaultChangeEvent) {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (err) {
                console.error('Error in vault change listener:', err);
            }
        }
    }
}
