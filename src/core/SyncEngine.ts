import { TimeoutManager } from '../utils/Timeouts';

export enum SyncPhase {
    IDLE = 'IDLE',
    REQUESTING = 'REQUESTING',
    PLANNING = 'PLANNING',
    TRANSFERRING = 'TRANSFERRING',
    COMPLETING = 'COMPLETING'
}

export class SyncEngine {
    private currentPhase: SyncPhase = SyncPhase.IDLE;
    private timeoutManager: TimeoutManager;
    private phaseTimeoutId: number | null = null;

    constructor(timeoutManager: TimeoutManager) {
        this.timeoutManager = timeoutManager;
    }

    public transitionTo(newPhase: SyncPhase, maxDurationMs: number = 0, onTimeout?: () => void): void {
        this.currentPhase = newPhase;
        
        if (this.phaseTimeoutId !== null) {
            this.timeoutManager.clearTimeout(this.phaseTimeoutId);
            this.phaseTimeoutId = null;
        }

        if (maxDurationMs > 0 && onTimeout) {
            this.phaseTimeoutId = this.timeoutManager.setTimeout(() => {
                this.phaseTimeoutId = null;
                this.currentPhase = SyncPhase.IDLE;
                onTimeout();
            }, maxDurationMs);
        }
    }

    public getPhase(): SyncPhase {
        return this.currentPhase;
    }

    public abort(): void {
        this.transitionTo(SyncPhase.IDLE);
    }
}
