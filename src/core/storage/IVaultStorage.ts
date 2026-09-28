/**
 * Core vault storage interface.
 * Abstracts local file system operations away from Obsidian's Vault API,
 * allowing the sync engine to run both in Obsidian and in headless virtual device test harnesses.
 *
 * Contract (shared by every implementation, pinned by tests/storage.test.ts):
 *   - Paths are non-empty vault-relative paths; the root ('' or '/') is refused.
 *   - read/readBinary throw on a missing path (MerkleManager treats that as "vanished").
 *   - stat returns a FILE's stat, or null — for a folder, and for a missing path.
 *   - delete removes a file or a folder recursively and emits one 'delete' event per
 *     file the tree actually lost; nothing at all when the path was already gone.
 *   - rename throws when the source is missing or the destination is occupied by a
 *     folder (a file where a folder lives is a state no filesystem can represent).
 *   - Events carry the same normalized path listFiles reports.
 *   - Implementations expect to be the sole writer of their tree; external changes
 *     are not observed.
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

/**
 * A vault path is a non-empty relative path: `''` names the vault root, where a write,
 * delete or rename would act on every file at once, so implementations must refuse it.
 */
export function requireVaultPath(path: string): string {
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!normalized) throw new Error(`Refusing to operate on the vault root: "${path}"`);
    return normalized;
}

/**
 * Standard text extension set — the single copy; src/main.ts imports it so the
 * simulation model and the plugin can never disagree about what is text.
 */
export const TEXT_EXTENSIONS = new Set(['md', 'txt', 'json', 'css', 'js', 'html', 'xml', 'csv', 'yaml', 'yml', 'toml']);

export function isBinaryPath(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    return !TEXT_EXTENSIONS.has(ext);
}
