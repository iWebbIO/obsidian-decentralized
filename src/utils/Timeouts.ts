export class TimeoutManager {
    private timeouts: Set<number> = new Set();
    private intervals: Set<number> = new Set();
    private disposed = false;

    /** True once dispose() ran; long-running waits check it to stop early. */
    public get isDisposed(): boolean {
        return this.disposed;
    }

    public setTimeout(callback: () => void, ms: number): number {
        // After dispose() (plugin unload) callbacks still settling must not arm new timers.
        if (this.disposed) return -1;
        const id = setTimeout(() => {
            this.timeouts.delete(id);
            callback();
        }, ms) as any as number;
        this.timeouts.add(id);
        return id;
    }

    public clearTimeout(id: number | null | undefined): void {
        if (id == null || id === -1) return;
        clearTimeout(id);
        this.timeouts.delete(id);
    }

    public setInterval(callback: () => void, ms: number): number {
        if (this.disposed) return -1;
        const id = setInterval(callback, ms) as any as number;
        this.intervals.add(id);
        return id;
    }

    public clearInterval(id: number | null | undefined): void {
        if (id == null || id === -1) return;
        clearInterval(id);
        this.intervals.delete(id);
    }

    /** Clear everything and refuse new timers from now on. */
    public dispose(): void {
        this.disposed = true;
        this.clearAll();
    }

    public clearAll(): void {
        for (const id of this.timeouts) {
            clearTimeout(id);
        }
        this.timeouts.clear();

        for (const id of this.intervals) {
            clearInterval(id);
        }
        this.intervals.clear();
    }
}
