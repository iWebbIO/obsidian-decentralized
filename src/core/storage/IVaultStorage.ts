/**
 * Core vault storage interface.
 * Abstracts local file system operations away from Obsidian's Vault API,
 * allowing the sync engine to run both in Obsidian and in headless virtual device test harnesses.
 */

export interface FileStat {
    size: number;
    mtime: number;
}

export interface VaultFileEntry {
    path: string;
    size: number;
    mtime: number;
    isBinary: boolean;
}

export type VaultEventType = 'create' | 'modify' | 'delete' | 'rename';

export interface VaultChangeEvent {
    type: VaultEventType;
    path: string;
    oldPath?: string;
    mtime?: number;
}

export interface IVaultStorage {
    /** Read UTF-8 text file contents. */
    read(path: string): Promise<string>;

    /** Read raw binary file contents. */
    readBinary(path: string): Promise<ArrayBuffer>;

    /** Write UTF-8 text file contents, optionally preserving mtime. */
    write(path: string, content: string, mtime?: number): Promise<void>;

    /** Write raw binary file contents, optionally preserving mtime. */
    writeBinary(path: string, content: ArrayBuffer, mtime?: number): Promise<void>;

    /** Delete a file or folder. */
    delete(path: string): Promise<void>;

    /** Rename/move a file or folder. */
    rename(oldPath: string, newPath: string): Promise<void>;

    /** Check if a file or folder exists. */
    exists(path: string): Promise<boolean>;

    /** Get file stat (size and mtime), or null if not found. */
    stat(path: string): Promise<FileStat | null>;

    /** List all files in the vault. */
    listFiles(): Promise<VaultFileEntry[]>;

    /** Ensure folder structure exists for a given path. */
    ensureDirectory?(dirPath: string): Promise<void>;

    /** Subscribe to file change events. Returns an unsubscribe function. */
    onVaultChange(listener: (event: VaultChangeEvent) => void): () => void;
}

/** Standard text extension whitelist matching the plugin logic. */
export const TEXT_EXTENSIONS = new Set(['md', 'txt', 'json', 'css', 'js', 'html', 'xml', 'csv', 'yaml', 'toml']);

export function isBinaryPath(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    return !TEXT_EXTENSIONS.has(ext);
}
