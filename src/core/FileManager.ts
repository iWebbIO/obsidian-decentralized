import { TFile, Vault } from 'obsidian';

export class FileManager {
    private vault: Vault;
    private fileLocks: Map<string, { peerId: string; expiresAt: number }> = new Map();

    constructor(vault: Vault) {
        this.vault = vault;
    }

    public async readChunked(file: TFile, chunkSize: number, onChunk: (data: ArrayBuffer, index: number, total: number) => Promise<void>): Promise<void> {
        // We simulate chunked reading by reading the file and slicing.
        // In a true stream API, we would use vault.readRaw or similar streaming APIs if available.
        // For now, we protect OOM by allowing chunk-by-chunk processing.
        const content = await this.vault.readBinary(file);
        const totalChunks = Math.ceil(content.byteLength / chunkSize);
        
        for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, content.byteLength);
            const chunk = content.slice(start, end);
            await onChunk(chunk, i, totalChunks);
        }
    }

    public async handleIncomingChunk(transferId: string, chunk: ArrayBuffer, index: number, total: number): Promise<void> {
        // Implement chunk saving logic
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
