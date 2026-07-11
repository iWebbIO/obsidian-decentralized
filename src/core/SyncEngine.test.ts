import { SyncEngine } from './SyncEngine';
import { TimeoutManager } from '../utils/Timeouts';
import { SyncPhase } from '../../types';

describe('SyncEngine', () => {
    let timeoutManager: TimeoutManager;
    let engine: SyncEngine;

    beforeEach(() => {
        jest.useFakeTimers();
        timeoutManager = new TimeoutManager();
        engine = new SyncEngine(timeoutManager);
    });

    afterEach(() => {
        timeoutManager.clearAll();
        jest.useRealTimers();
    });

    test('should start in IDLE phase', () => {
        expect(engine.getPhase()).toBe(SyncPhase.IDLE);
    });

    test('should transition to a new phase', () => {
        engine.transitionTo(SyncPhase.PLANNING);
        expect(engine.getPhase()).toBe(SyncPhase.PLANNING);
    });

    test('should abort and return to IDLE phase', () => {
        engine.transitionTo(SyncPhase.TRANSFERRING);
        expect(engine.getPhase()).toBe(SyncPhase.TRANSFERRING);
        engine.abort();
        expect(engine.getPhase()).toBe(SyncPhase.IDLE);
    });

    test('should trigger timeout and execute callback, returning to IDLE', () => {
        const timeoutCallback = jest.fn();
        
        engine.transitionTo(SyncPhase.REQUESTING, 5000, timeoutCallback);
        expect(engine.getPhase()).toBe(SyncPhase.REQUESTING);

        jest.advanceTimersByTime(4999);
        expect(timeoutCallback).not.toHaveBeenCalled();
        expect(engine.getPhase()).toBe(SyncPhase.REQUESTING);

        jest.advanceTimersByTime(1);
        expect(timeoutCallback).toHaveBeenCalledTimes(1);
        expect(engine.getPhase()).toBe(SyncPhase.IDLE);
    });

    test('should clear previous timeout when transitioning to a new phase', () => {
        const timeoutCallback = jest.fn();
        
        engine.transitionTo(SyncPhase.REQUESTING, 5000, timeoutCallback);
        
        // Transition to another phase before the first one times out
        engine.transitionTo(SyncPhase.PLANNING);
        
        jest.advanceTimersByTime(6000); // Beyond the 5000ms limit
        
        expect(timeoutCallback).not.toHaveBeenCalled();
        expect(engine.getPhase()).toBe(SyncPhase.PLANNING); // Should not have reverted to IDLE
    });
});
