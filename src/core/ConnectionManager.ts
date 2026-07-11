import { TimeoutManager } from '../utils/Timeouts';

export class ConnectionManager {
    private timeoutManager: TimeoutManager;


    constructor(timeoutManager: TimeoutManager) {
        this.timeoutManager = timeoutManager;
    }

    public async waitForBufferToDrain(dc: any, maxWaitMs: number = 60000): Promise<void> {
        if (!dc) return;
        if (dc.bufferedAmount <= 1 * 1024 * 1024) return;

        return new Promise<void>((resolve, reject) => {
            let isResolved = false;
            
            let oldHandler = dc.onbufferedamountlow;
            
            const timeoutId = this.timeoutManager.setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    dc.onbufferedamountlow = oldHandler;
                    reject(new Error("Timeout waiting for WebRTC buffer to drain"));
                }
            }, maxWaitMs);

            dc.bufferedAmountLowThreshold = 1 * 1024 * 1024;
            
            dc.onbufferedamountlow = () => {
                if (!isResolved) {
                    isResolved = true;
                    this.timeoutManager.clearTimeout(timeoutId);
                    dc.onbufferedamountlow = oldHandler;
                    // Invoke the old handler so it doesn't miss this drain event
                    if (typeof oldHandler === 'function') oldHandler();
                    resolve();
                }
            };
        });
    }

    // Additional connection management logic will go here
}
