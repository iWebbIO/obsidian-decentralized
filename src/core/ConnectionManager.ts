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
            
            const timeoutId = this.timeoutManager.setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    dc.removeEventListener?.('bufferedamountlow', handler);
                    reject(new Error("Timeout waiting for WebRTC buffer to drain"));
                }
            }, maxWaitMs);

            dc.bufferedAmountLowThreshold = 1 * 1024 * 1024;
            
            const handler = () => {
                if (!isResolved) {
                    isResolved = true;
                    this.timeoutManager.clearTimeout(timeoutId);
                    dc.removeEventListener?.('bufferedamountlow', handler);
                    resolve();
                }
            };
            
            if (dc.addEventListener) {
                dc.addEventListener('bufferedamountlow', handler);
            } else {
                // Fallback if addEventListener is somehow not available (e.g. mock objects)
                dc.onbufferedamountlow = handler;
            }
        });
    }

    // Additional connection management logic will go here
}
