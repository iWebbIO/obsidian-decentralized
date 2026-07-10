export class TimeoutManager {
    private timeouts: Set<number> = new Set();
    private intervals: Set<number> = new Set();

    public setTimeout(callback: () => void, ms: number): number {
        const id = window.setTimeout(() => {
            this.timeouts.delete(id);
            callback();
        }, ms);
        this.timeouts.add(id);
        return id;
    }

    public clearTimeout(id: number | null | undefined): void {
        if (id == null) return;
        window.clearTimeout(id);
        this.timeouts.delete(id);
    }

    public setInterval(callback: () => void, ms: number): number {
        const id = window.setInterval(callback, ms);
        this.intervals.add(id);
        return id;
    }

    public clearInterval(id: number | null | undefined): void {
        if (id == null) return;
        window.clearInterval(id);
        this.intervals.delete(id);
    }

    public clearAll(): void {
        for (const id of this.timeouts) {
            window.clearTimeout(id);
        }
        this.timeouts.clear();

        for (const id of this.intervals) {
            window.clearInterval(id);
        }
        this.intervals.clear();
    }
}
