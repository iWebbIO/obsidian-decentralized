import { TFile, Vault } from 'obsidian';

export class FileManager {
    private vault: Vault;
    private fileLocks: Map<string, { peerId: string; expiresAt: number }> = new Map();

    constructor(vault: Vault) {
        this.vault = vault;
    }

    /**
     * Note: This method reads the entire file into memory before slicing it.
     * Obsidian's Vault API does not natively support streaming for File objects.
     * This simulates chunking for network transfer purposes.
     */
    public async readChunked(file: TFile, chunkSize: number, onChunk: (data: ArrayBuffer, index: number, total: number) => Promise<void>): Promise<void> {
        const content = await this.vault.readBinary(file);
        const totalChunks = Math.max(1, Math.ceil(content.byteLength / chunkSize));
        
        for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, content.byteLength);
            const chunk = content.slice(start, end);
            await onChunk(chunk, i, totalChunks);
        }
    }

    public async handleIncomingChunk(transferId: string, chunk: ArrayBuffer, index: number, total: number): Promise<void> {
        throw new Error("NotImplementedError: handleIncomingChunk is not yet implemented.");
    }

    public acquireLock(path: string, peerId: string, durationMs: number = 30000): boolean {
        const lock = this.fileLocks.get(path);
        const now = Date.now();
        if (lock && lock.expiresAt > now && lock.peerId !== peerId) {
            return false; // Locked by someone else
        }
        
        this.fileLocks.set(path, { peerId, expiresAt: now + durationMs });
        return true;
    }

    public refreshLock(path: string, peerId: string, durationMs: number = 30000): void {
        const lock = this.fileLocks.get(path);
        if (lock && lock.peerId === peerId) {
            lock.expiresAt = Date.now() + durationMs;
        }
    }

    public releaseLock(path: string, peerId: string): void {
        const lock = this.fileLocks.get(path);
        if (lock && lock.peerId === peerId) {
            this.fileLocks.delete(path);
        }
    }

    public cleanupExpiredLocks(): void {
        const now = Date.now();
        for (const [path, lock] of this.fileLocks.entries()) {
            if (now > lock.expiresAt) {
                this.fileLocks.delete(path);
            }
        }
    }
}
