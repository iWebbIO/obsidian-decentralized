import { TimeoutManager } from '../utils/Timeouts';

export interface QueueItem {
    peerId: string | null;
    task?: any;
    data?: any;
    retries: number;
    priority: number;
}

export class QueueManager {
    private syncQueue: QueueItem[] = [];
    private activeQueueTransfers: number = 0;
    private processingQueue: boolean = false;
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
        this.loadQueueFromDisk(); // Basic persistence stub
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
        this.activeQueueTransfers = 0;
        this.saveQueueToDisk();
    }

    public addToQueue(item: QueueItem) {
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
        this.saveQueueToDisk();
        this.processQueue();
    }

    public getQueuePressure(): number {
        const MAX_QUEUE_DEPTH = 100; // Configurable
        return Math.min(1, (this.syncQueue.length + this.activeQueueTransfers) / MAX_QUEUE_DEPTH);
    }

    public getQueueSize(): number { return this.syncQueue.length; }
    public getActiveTransfers(): number { return this.activeQueueTransfers; }

    private processQueue() {
        if (this.processingQueue || this.queueIsPaused) return;
        this.processingQueue = true;

        while (this.activeQueueTransfers < this.maxConcurrency && this.syncQueue.length > 0) {
            const item = this.syncQueue.shift();
            if (item) {
                this.activeQueueTransfers++;
                this.saveQueueToDisk();
                
                this.processCallback(item)
                    .then((success) => {
                        this.activeQueueTransfers--;
                        if (!success && item.retries < 3) {
                            item.retries++;
                            // Non-blocking, managed timeout for backoff
                            this.timeoutManager.setTimeout(() => {
                                this.addToQueue(item);
                            }, 5000);
                        }
                    })
                    .catch((e) => {
                        this.activeQueueTransfers--;
                        console.error("Queue item processing error", e);
                    })
                    .finally(() => {
                        // Ensure we trigger the next item
                        this.processingQueue = false;
                        this.processQueue();
                    });
            }
        }

        if (this.activeQueueTransfers === 0 && this.syncQueue.length === 0 && this.syncDrainCallback) {
            this.syncDrainCallback();
            this.syncDrainCallback = null;
        }

        this.processingQueue = false;
    }

    private loadQueueFromDisk() {
        // Implementation to load queue from IndexedDB or file
        // To prevent data loss across crashes
    }

    private saveQueueToDisk() {
        // Implementation to save queue to IndexedDB or file
    }
}
