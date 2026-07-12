import { TimeoutManager } from '../utils/Timeouts';
import { SyncPhase } from '../../types';

export class SyncEngine {
    private currentPhase: SyncPhase = SyncPhase.IDLE;
    private timeoutManager: TimeoutManager;
    private phaseTimeoutId: number | null = null;

    constructor(timeoutManager: TimeoutManager) {
        this.timeoutManager = timeoutManager;
    }

    public transitionTo(newPhase: SyncPhase, maxDurationMs: number = 0, onTimeout?: (phase?: SyncPhase) => void): void {
        this.currentPhase = newPhase;
        
        if (this.phaseTimeoutId !== null) {
            this.timeoutManager.clearTimeout(this.phaseTimeoutId);
            this.phaseTimeoutId = null;
        }

        if (maxDurationMs > 0) {
            this.phaseTimeoutId = this.timeoutManager.setTimeout(() => {
                this.phaseTimeoutId = null;
                const timedOutPhase = this.currentPhase;
                this.currentPhase = SyncPhase.IDLE;
                if (onTimeout) onTimeout(timedOutPhase);
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
