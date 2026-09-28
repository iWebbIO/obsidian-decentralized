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
