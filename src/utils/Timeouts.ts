export class TimeoutManager {
    private timeouts: Set<number> = new Set();
    private intervals: Set<number> = new Set();

    public setTimeout(callback: () => void, ms: number): number {
        const id = setTimeout(() => {
            this.timeouts.delete(id);
            callback();
        }, ms) as any as number;
        this.timeouts.add(id);
        return id;
    }

    public clearTimeout(id: number | null | undefined): void {
        if (id == null) return;
        clearTimeout(id);
        this.timeouts.delete(id);
    }

    public setInterval(callback: () => void, ms: number): number {
        const id = setInterval(callback, ms) as any as number;
        this.intervals.add(id);
        return id;
    }

    public clearInterval(id: number | null | undefined): void {
        if (id == null) return;
        clearInterval(id);
        this.intervals.delete(id);
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
