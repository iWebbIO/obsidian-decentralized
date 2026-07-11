import { TimeoutManager } from '../utils/Timeouts';

export interface QueueItem {
    id?: string;
    peerId: string | null;
    task?: any;
    data?: any;
    retries: number;
    priority: number;
}

export class QueueManager {
    private syncQueue: QueueItem[] = [];
    private activeQueueTransfers: number = 0;
    private pendingRetries: number = 0;
    private inQueueOrProcessing: Set<string> = new Set();
    private maxConcurrency: number = 3;
    private timeoutManager: TimeoutManager;
    private processCallback: (item: QueueItem) => Promise<boolean>;
    private syncDrainCallback: (() => void) | null = null;
    private queueIsPaused: boolean = false;

    constructor(
        timeoutManager: TimeoutManager, 
        processCallback: (item: QueueItem) => Promise<boolean>
    ) {
        this.timeoutManager = timeoutManager;
        this.processCallback = processCallback;
        // TODO: call loadQueueFromDisk() here once IndexedDB persistence is implemented
    }

    public setConcurrencyLimit(limit: number) {
        this.maxConcurrency = limit;
    }

    public setSyncDrainCallback(callback: () => void) {
        this.syncDrainCallback = callback;
    }

    public pause() {
        this.queueIsPaused = true;
    }

    public resume() {
        this.queueIsPaused = false;
        this.processQueue();
    }

    public clear() {
        this.syncQueue = [];
        this.inQueueOrProcessing.clear();
        // Do not reset activeQueueTransfers; let in-flight items finish naturally
    }

    public addToQueue(item: QueueItem) {
        if (item.id) {
            if (this.inQueueOrProcessing.has(item.id)) return;
            this.inQueueOrProcessing.add(item.id);
        }
        
        let low = 0, high = this.syncQueue.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (this.syncQueue[mid].priority < item.priority) {
                high = mid;
            } else {
                low = mid + 1;
            }
        }
        this.syncQueue.splice(low, 0, item);
        this.processQueue();
    }

    public getQueuePressure(): number {
        const MAX_QUEUE_DEPTH = 100; // Configurable
        return Math.min(1, (this.syncQueue.length + this.activeQueueTransfers) / MAX_QUEUE_DEPTH);
    }

    public getQueueSize(): number { return this.syncQueue.length; }
    public getActiveTransfers(): number { return this.activeQueueTransfers; }

    private processQueue() {
        if (this.queueIsPaused) return;
        // Drain the queue up to the concurrency limit. Since JS is single-threaded,
        // this loop runs atomically — no re-entry can occur before the while exits.
        while (this.activeQueueTransfers < this.maxConcurrency && this.syncQueue.length > 0) {
            const item = this.syncQueue.shift()!;
            this.activeQueueTransfers++;

            this.processCallback(item)
                .then((success) => {
                    if (!success && item.retries < 3) {
                        item.retries++;
                        this.pendingRetries++;
                        // Keep item.id in inQueueOrProcessing during the retry delay
                        // to prevent duplicates from entering the queue in the window.
                        this.timeoutManager.setTimeout(() => {
                            this.pendingRetries--;
                            if (item.id) this.inQueueOrProcessing.delete(item.id);
                            this.addToQueue(item);
                        }, 5000);
                    } else {
                        if (item.id) this.inQueueOrProcessing.delete(item.id);
                    }
                })
                .catch((e) => {
                    console.error("Queue item processing error", e);
                    if (item.id) this.inQueueOrProcessing.delete(item.id);
                })
                .finally(() => {
                    this.activeQueueTransfers--;
                    // Re-enter processQueue after each item completes to drain pending work
                    this.processQueue();
                });
        }

        if (this.activeQueueTransfers === 0 && this.syncQueue.length === 0 && this.pendingRetries === 0 && this.syncDrainCallback) {
            const cb = this.syncDrainCallback;
            this.syncDrainCallback = null;
            cb();
        }
    }

    // TODO: implement loadQueueFromDisk() using IndexedDB or vault adapter to survive crashes
    // TODO: implement saveQueueToDisk() to persist queue state; call it on addToQueue/clear
}
