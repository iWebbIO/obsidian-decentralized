import { App, TFile, TFolder, normalizePath } from 'obsidian';
import {
    IVaultStorage,
    VaultFileEntry,
    VaultChangeEvent,
    FileStat,
    isBinaryPath
} from './IVaultStorage';

/**
 * Obsidian vault storage adapter.
 * Wraps Obsidian's native App.vault and App.vault.adapter.
 */
export class ObsidianVaultStorage implements IVaultStorage {
    constructor(private app: App) {}

    public async read(path: string): Promise<string> {
        const norm = normalizePath(path);
        const file = this.app.vault.getAbstractFileByPath(norm);
        if (file instanceof TFile) {
            return await this.app.vault.read(file);
        }
        return await this.app.vault.adapter.read(norm);
    }

    public async readBinary(path: string): Promise<ArrayBuffer> {
        const norm = normalizePath(path);
        const file = this.app.vault.getAbstractFileByPath(norm);
        if (file instanceof TFile) {
            return await this.app.vault.readBinary(file);
        }
        return await this.app.vault.adapter.readBinary(norm);
    }

    /** The vault root is not a file any operation may target. */
    private requirePath(path: string): string {
        const norm = normalizePath(path);
        if (!norm || norm === '/' || norm === '.') {
            throw new Error(`Refusing to operate on the vault root: "${path}"`);
        }
        return norm;
    }

    public async write(path: string, content: string, mtime?: number): Promise<void> {
        const norm = this.requirePath(path);
        const existing = this.app.vault.getAbstractFileByPath(norm);

        if (existing instanceof TFile) {
            await this.app.vault.modify(existing, content, mtime !== undefined ? { mtime } : undefined);
        } else {
            await this.ensureParentFolder(norm);
            await this.app.vault.create(norm, content);
            if (mtime !== undefined) {
                const created = this.app.vault.getAbstractFileByPath(norm);
                if (created instanceof TFile) {
                    await this.app.vault.modify(created, content, { mtime });
                }
            }
        }
    }

    public async writeBinary(path: string, content: ArrayBuffer, mtime?: number): Promise<void> {
        const norm = this.requirePath(path);
        const existing = this.app.vault.getAbstractFileByPath(norm);

        if (existing instanceof TFile) {
            await this.app.vault.modifyBinary(existing, content, mtime !== undefined ? { mtime } : undefined);
        } else {
            await this.ensureParentFolder(norm);
            await this.app.vault.createBinary(norm, content);
            if (mtime !== undefined) {
                const created = this.app.vault.getAbstractFileByPath(norm);
                if (created instanceof TFile) {
                    await this.app.vault.modifyBinary(created, content, { mtime });
                }
            }
        }
    }

    public async delete(path: string): Promise<void> {
        const norm = this.requirePath(path);
        const item = this.app.vault.getAbstractFileByPath(norm);
        if (item) {
            await this.app.vault.delete(item, true);
        } else if (await this.app.vault.adapter.exists(norm)) {
            await this.app.vault.adapter.remove(norm);
        }
    }

    public async rename(oldPath: string, newPath: string): Promise<void> {
        const normOld = this.requirePath(oldPath);
        const normNew = this.requirePath(newPath);
        const item = this.app.vault.getAbstractFileByPath(normOld);

        if (item) {
            await this.ensureParentFolder(normNew);
            await this.app.vault.rename(item, normNew);
        } else if (await this.app.vault.adapter.exists(normOld)) {
            await this.ensureParentFolder(normNew);
            await this.app.vault.adapter.rename(normOld, normNew);
        } else {
            // The other adapters throw for a missing source; a silent no-op here made
            // the caller believe the rename had happened.
            throw new Error(`File not found: ${oldPath}`);
        }
    }

    public async exists(path: string): Promise<boolean> {
        const norm = normalizePath(path);
        // The vault root always exists but no file lives at it; the other adapters
        // answer false for the root, so this one must not diverge.
        if (!norm || norm === '/' || norm === '.') return false;
        if (this.app.vault.getAbstractFileByPath(norm)) return true;
        return await this.app.vault.adapter.exists(norm);
    }

    public async stat(path: string): Promise<FileStat | null> {
        const norm = normalizePath(path);
        if (!norm || norm === '/' || norm === '.') return null;
        const item = this.app.vault.getAbstractFileByPath(norm);
        if (item instanceof TFile) {
            return {
                size: item.stat.size,
                mtime: item.stat.mtime
            };
        }
        const adapterStat = await this.app.vault.adapter.stat(norm);
        // A folder is not a file: stat answers for files, and null otherwise, on every
        // implementation.
        if (adapterStat && adapterStat.type === 'file') {
            return {
                size: adapterStat.size,
                mtime: adapterStat.mtime
            };
        }
        return null;
    }

    public async listFiles(): Promise<VaultFileEntry[]> {
        const allFiles = this.app.vault.getAllLoadedFiles();
        const entries: VaultFileEntry[] = [];

        for (const item of allFiles) {
            if (item instanceof TFile) {
                entries.push({
                    path: item.path,
                    size: item.stat.size,
                    mtime: item.stat.mtime,
                    isBinary: isBinaryPath(item.path)
                });
            }
        }
        return entries;
    }

    public async ensureDirectory(dirPath: string): Promise<void> {
        const norm = normalizePath(dirPath);
        if (!norm || norm === '.' || norm === '/') return;
        const existing = this.app.vault.getAbstractFileByPath(norm);
        if (existing instanceof TFolder) return;
        if (!await this.app.vault.adapter.exists(norm)) {
            await this.app.vault.createFolder(norm).catch(() => {});
        }
    }

    private async ensureParentFolder(filePath: string): Promise<void> {
        const parts = filePath.split('/');
        if (parts.length <= 1) return;
        parts.pop();
        const dirPath = parts.join('/');
        await this.ensureDirectory(dirPath);
    }

    public onVaultChange(listener: (event: VaultChangeEvent) => void): () => void {
        const refCreate = this.app.vault.on('create', (file) => {
            if (file instanceof TFile) {
                listener({ type: 'create', path: file.path, mtime: file.stat.mtime });
            }
        });
        const refModify = this.app.vault.on('modify', (file) => {
            if (file instanceof TFile) {
                listener({ type: 'modify', path: file.path, mtime: file.stat.mtime });
            }
        });
        const refDelete = this.app.vault.on('delete', (file) => {
            // Folders are dropped like the other adapters do: Obsidian fires one delete
            // per contained file as well, and those carry the information.
            if (file instanceof TFile) {
                listener({ type: 'delete', path: file.path });
            }
        });
        const refRename = this.app.vault.on('rename', (file, oldPath) => {
            listener({ type: 'rename', path: file.path, oldPath });
        });

        return () => {
            this.app.vault.offref(refCreate);
            this.app.vault.offref(refModify);
            this.app.vault.offref(refDelete);
            this.app.vault.offref(refRename);
        };
    }
}
