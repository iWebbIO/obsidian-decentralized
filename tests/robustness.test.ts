/**
 * Robustness regressions from the constants audit (sweep 4): each test names a way a
 * legal transfer or sync used to die on a bound that did not match the code that
 * actually runs.
 */
import { REQUESTING_TIMEOUT, PLANNING_TIMEOUT, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE } from '../src/types';
import { createDevice, teardown } from './helpers/harness';

afterEach(teardown);

const B = 'device-bbbb0002';
const A = 'device-aaaa0001';

function fromA() {
    return { peer: A, open: true, send: jest.fn() } as any;
}

describe('phase timeout budget', () => {
    it('gives the requester more time than the responder spends planning', () => {
        // The initiator's REQUESTING window must contain the responder's entire
        // PLANNING window plus the request/plan deliveries (up to 30 s per ack
        // attempt). Equal values meant a vault whose planning used most of its own
        // budget made the requester abort first.
        expect(REQUESTING_TIMEOUT).toBeGreaterThan(PLANNING_TIMEOUT);
        expect(REQUESTING_TIMEOUT - PLANNING_TIMEOUT).toBeGreaterThanOrEqual(30000);
    });
});

describe('chunked transfer bounds', () => {
    test('a legal large transfer is not refused by the chunk-count ceiling', async () => {
        // The ceiling divided by MAX_CHUNK_SIZE (128 chunks): a 102 MB file in the
        // default 512 KB chunks is 200 chunks — rejected forever, the sender burning
        // its full ack window per attempt. totalBytes ≤ 512 MB plus the
        // ceil-consistency check bound memory on their own; the ceiling only needs
        // to exclude absurd counts (8192 = 512 MB in minimum-size chunks).
        const b = await createDevice(B);
        const plugin: any = b.plugin;
        const chunkSize = 512 * 1024;
        const totalChunks = 200;                      // 102.4 MB in 512 KB chunks
        const totalBytes = totalChunks * chunkSize;

        await plugin.handleFileChunkStart({
            type: 'file-chunk-start', path: 'media/big.bin', mtime: 1000,
            totalChunks, transferId: 't-legal', fileHash: 'h', totalBytes, chunkSize,
        }, fromA());

        expect(plugin.pendingFileChunks.has('t-legal')).toBe(true);

        // The real ceiling still applies: more chunks than 512 MB in MINIMUM-size
        // chunks cannot be a legal transfer.
        await plugin.handleFileChunkStart({
            type: 'file-chunk-start', path: 'media/absurd.bin', mtime: 1000,
            totalChunks: 8193, transferId: 't-absurd', fileHash: 'h',
            totalBytes: 8193 * MIN_CHUNK_SIZE, chunkSize: MIN_CHUNK_SIZE,
        }, fromA());
        expect(plugin.pendingFileChunks.has('t-absurd')).toBe(false);
    });

    test('an over-size chunk setting from a hand-edited data.json is clamped', async () => {
        // The receiver validates chunks against MAX_CHUNK_SIZE, so an unclamped
        // setting made every chunk of every transfer fail while the sender kept
        // sending them.
        const b = await createDevice(B, { settings: { chunkSize: 9 * 1024 * 1024 } as any });
        const clamped = b.plugin.getChunkSize();
        expect(clamped).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
        expect(clamped).toBeGreaterThanOrEqual(MIN_CHUNK_SIZE);
    });

    test('aborting a sync releases in-flight chunk reassemblies', async () => {
        // An aborted download's preallocated buffer used to linger for the 5-minute
        // sweeper, still counting against the concurrent-reassembly limit — a sync
        // restarted right after an abort could have its next chunked transfer
        // refused with "too many concurrent transfers in progress".
        const b = await createDevice(B);
        const plugin: any = b.plugin;
        plugin.syncState.isSyncing = true;
        plugin.syncState.peerId = A;

        await plugin.handleFileChunkStart({
            type: 'file-chunk-start', path: 'media/big.bin', mtime: 1000,
            totalChunks: 4, transferId: 't-abort', fileHash: 'h',
            totalBytes: 4 * 64 * 1024, chunkSize: 64 * 1024,
        }, fromA());
        expect(plugin.pendingFileChunks.has('t-abort')).toBe(true);

        plugin.abortSync(undefined, { silent: true });

        expect(plugin.pendingFileChunks.has('t-abort')).toBe(false);
        expect(plugin.activeTransfers.has('t-abort')).toBe(false);
    });
});

describe('chunked transfer defenses', () => {
    const BIG_ENOUGH_TO_CHUNK = 3;   // any totalChunks works for these paths
    function fromA() {
        return { peer: A, open: true, send: jest.fn() } as any;
    }

    async function startTransfer(plugin: any, id: string, totalChunks = BIG_ENOUGH_TO_CHUNK) {
        await plugin.handleFileChunkStart({
            type: 'file-chunk-start', path: `media/${id}.bin`, mtime: 1000,
            totalChunks, transferId: id, fileHash: 'h',
            totalBytes: totalChunks * 64 * 1024, chunkSize: 64 * 1024,
        }, fromA());
    }

    test('a fractional chunk index is rejected, not written into a neighbour', async () => {
        // index 1.5 passed the range check, escaped the received[] bitmap (an ordinary
        // property, so no double-count guard) and its truncated offset landed mid-way
        // inside a legitimately received chunk — clobbering it.
        const b = await createDevice(B);
        const plugin: any = b.plugin;
        await startTransfer(plugin, 't-frac');
        const before = plugin.pendingFileChunks.get('t-frac');

        await plugin.handleFileChunkData({ type: 'file-chunk-data', transferId: 't-frac', index: 1.5, data: new Uint8Array(64 * 1024) }, fromA());

        const after = plugin.pendingFileChunks.get('t-frac');
        expect(after.receivedCount).toBe(0);                       // not counted
        expect(after.buffer).toEqual(before.buffer);              // nothing written
    });

    test('a refused chunk-start answers with a nack, not silence', async () => {
        // The receiver caps concurrent reassemblies at 16; the sender used to learn of
        // a refusal only by streaming every chunk into the void and burning the ack
        // window before the retry ladder.
        const b = await createDevice(B);
        const plugin: any = b.plugin;
        for (let i = 0; i < 16; i++) await startTransfer(plugin, `t-cap${i}`);
        const nack = jest.spyOn(plugin, 'sendDirect');

        await startTransfer(plugin, 't-cap-refused');

        expect(nack).toHaveBeenCalledWith(expect.anything(), { type: 'nack', transferId: 't-cap-refused', reason: 'busy' });
        expect(plugin.pendingFileChunks.has('t-cap-refused')).toBe(false);
        nack.mockRestore();
    });

    test('a slow-drip reassembly is reclaimed by its absolute age, not just by silence', async () => {
        // A connected peer sending one small chunk per <5 min kept a 512 MB
        // preallocation alive forever: lastUpdated refreshed on any chunk.
        const b = await createDevice(B);
        const plugin: any = b.plugin;
        await startTransfer(plugin, 't-slow');
        const entry = plugin.pendingFileChunks.get('t-slow');
        entry.lastUpdated = Date.now();                    // silent never — always fresh
        entry.startedAt = Date.now() - 31 * 60 * 1000;     // but half an hour old

        plugin.cleanupPendingChunks();

        expect(plugin.pendingFileChunks.has('t-slow')).toBe(false);
    });

    test('a paused upload whose peer never returns is dropped after a week', async () => {
        const b = await createDevice(B);
        const plugin: any = b.plugin;
        plugin.activeTransfers.set('t-old', {
            id: 't-old', path: 'x.bin', direction: 'upload', peerId: A,
            totalChunks: 2, processedChunks: 0, startTime: Date.now() - 9 * 24 * 3600 * 1000,
            lastUpdate: Date.now() - 9 * 24 * 3600 * 1000, status: 'paused', chunkSize: 65536,
        });
        plugin.activeTransfers.set('t-recent', {
            id: 't-recent', path: 'y.bin', direction: 'upload', peerId: A,
            totalChunks: 2, processedChunks: 0, startTime: Date.now() - 1000,
            lastUpdate: Date.now() - 1000, status: 'paused', chunkSize: 65536,
        });

        plugin.cleanupPendingChunks();

        expect(plugin.activeTransfers.has('t-old')).toBe(false);
        expect(plugin.activeTransfers.has('t-recent')).toBe(true);   // still resumable
    });
});

describe('full-sync state machine hardening', () => {
    function fromA() {
        return { peer: A, open: true, send: jest.fn() } as any;
    }

    test('sync-busy is honored only from the device being synced with', async () => {
        // Any connected peer could abort an unrelated in-progress sync with one
        // message — including the shared-queue wipe that came with it.
        const b = await createDevice(B);
        const plugin: any = b.plugin;
        plugin.syncState.isSyncing = true;
        plugin.syncState.peerId = A;

        await plugin.processIncomingData({ type: 'sync-busy' }, { peer: 'device-cccc0003', open: true, send: jest.fn() });
        expect(plugin.syncState.isSyncing).toBe(true);

        await plugin.processIncomingData({ type: 'sync-busy' }, fromA());
        expect(plugin.syncState.isSyncing).toBe(false);
    });

    test('a pull given up after 3 attempts is recorded and reported', async () => {
        // The give-up used to leave no trace at all: the sync completed "cleanly"
        // and the vaults silently diverged until a manual full sync.
        const b = await createDevice(B);
        const plugin: any = b.plugin;
        Object.assign(plugin.syncState, {
            isSyncing: true, peerId: A, currentPhase: 'TRANSFERRING',
            pendingPulls: new Set(['stuck.md']),
        });
        plugin.syncState.activePullBatches = new Set(['b1']);
        plugin.pullRetries.set('stuck.md', 3);

        await plugin.handleBatchComplete({ type: 'batch-complete', batchId: 'b1', receivedPaths: [], failedPaths: ['stuck.md'] }, fromA());

        const parked = plugin.failedSyncs.find((f: any) => f.path === 'stuck.md');
        expect(parked).toMatchObject({ peerId: A, reason: 'Pull failed 3 times during sync' });
        expect(plugin.syncState.pendingPulls.has('stuck.md')).toBe(false);
        plugin.abortSync(undefined, { silent: true });
    });

    test('the responder sums its own pull bytes into bytesTotal', async () => {
        // bytesTotal was only ever initialized on the initiator; the responder's
        // progress readout divided by zero for the whole sync.
        const b = await createDevice(B);
        const plugin: any = b.plugin;
        jest.spyOn(plugin, 'sendSyncMessage').mockResolvedValue(undefined);

        await plugin.handleFullSyncRequest({
            type: 'request-full-sync',
            manifest: [{ type: 'file', path: 'from-a.md', mtime: 1000, size: 123 }],
        }, fromA());

        expect(plugin.syncState.bytesTotal).toBe(123);
        plugin.abortSync(undefined, { silent: true });
    });

    test('completion waits until our own full-sync-complete is delivered', async () => {
        // Tearing the sync down while the completion message was still retrying
        // left the peer never learning "I will request nothing more" — it then
        // burned its whole BATCH_TIMEOUT before erroring out.
        const b = await createDevice(B);
        const plugin: any = b.plugin;
        let deliver: (() => void) | null = null;
        const send = jest.spyOn(plugin, 'sendSyncMessage').mockImplementation(
            () => new Promise<void>(resolve => { deliver = resolve; }));
        Object.assign(plugin.syncState, {
            isSyncing: true, peerId: A, pendingPulls: new Set(),
            activeBatches: new Map(), activePullBatches: new Set(),
        });
        plugin.peerSyncComplete.set(A, true);

        plugin.checkFullSyncCompletion(A);
        expect(plugin.syncState.isSyncing).toBe(true);      // decided, not delivered

        deliver!();
        await new Promise(r => setTimeout(r, 20));
        expect(plugin.syncState.isSyncing).toBe(false);    // delivered → completed
        expect(send).toHaveBeenCalledWith(A, { type: 'full-sync-complete' });
        send.mockRestore();
    });

    test('a batch item exhausting retries degrades per path, not by aborting the sync', async () => {
        const b = await createDevice(B, { vault: (() => {
            const v = new (require('./helpers/fake-vault').FakeVault)();
            v.seed('note.md', 'x', 1000);
            return v;
        })() });
        const plugin: any = b.plugin;
        jest.spyOn(plugin, 'sendSyncMessage').mockResolvedValue(undefined);
        jest.spyOn(plugin, 'sendPayloadTo').mockRejectedValue(new Error('Connection closed'));
        Object.assign(plugin.syncState, {
            isSyncing: true, peerId: A, currentPhase: 'TRANSFERRING',
            pendingPulls: new Set(), activePullBatches: new Set(),
        });
        plugin.syncState.activeBatches.set('b1', {
            peerId: A, batchId: 'b1', totalCount: 1, sentCount: 0, succeededPaths: [], failedPaths: [],
        });

        await plugin.processQueueItem({
            peerId: A, retries: 3, priority: 100,
            task: { taskType: 'send-file-batch', paths: ['note.md'], batchId: 'b1' },
        });

        // The sync survives; the batch is reported failed per path.
        expect(plugin.syncState.isSyncing).toBe(true);
        expect(plugin.syncState.activeBatches.has('b1')).toBe(false);
        expect(plugin.failedSyncs.some((f: any) => f.path === 'note.md' && f.peerId === A)).toBe(true);
        plugin.abortSync(undefined, { silent: true });
    });
});

describe('Merkle traversal defenses', () => {
    function fromA() {
        return { peer: A, open: true, send: jest.fn() } as any;
    }

    test('a type conflict is named once, not descended into', async () => {
        // A folder on one device and a file at the same path on the other used to
        // loop forever: every child push failed per file with unrelated error
        // toasts and nothing converged.
        const b = await createDevice(B, { vault: (() => {
            const v = new (require('./helpers/fake-vault').FakeVault)();
            v.seed('clash', 'a note where a folder lives elsewhere', 1000);
            return v;
        })() });
        const plugin: any = b.plugin;
        const sent: any[] = [];
        jest.spyOn(plugin, 'sendData').mockImplementation((_p: string, m: any) => { sent.push(m); });
        await plugin.buildMerkleTree();

        // The peer says 'clash' is a folder holding a child.
        await plugin.handleMerkleNodeResponse(
            { type: 'merkle-node-response', path: '', children: { 'clash': 'h1' }, folders: ['clash'] }, fromA());

        expect(sent).toEqual([]);   // no descent, no request-file for phantom children
    });

    test('a merkle-node-response with absurd fan-out is dropped', async () => {
        const b = await createDevice(B);
        const plugin: any = b.plugin;
        const sent: any[] = [];
        jest.spyOn(plugin, 'sendData').mockImplementation((_p: string, m: any) => { sent.push(m); });
        await plugin.buildMerkleTree();

        const children: Record<string, string> = {};
        for (let i = 0; i < 5000; i++) children[`k${i}`] = `hash-${i}`;
        await plugin.handleMerkleNodeResponse(
            { type: 'merkle-node-response', path: '', children, folders: [] }, fromA());

        expect(sent).toEqual([]);   // no queue items spawned from one crafted message
    });
});
