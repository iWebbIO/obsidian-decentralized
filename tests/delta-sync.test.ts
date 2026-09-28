/**
 * Delta sync's failure ladder. The headline pin: when a delta arrives whose base the
 * receiver no longer holds, the receiver nacks and the sender must fall back to a full
 * send — the fallback used to be silently dropped by the queue's dedup slot (the
 * in-flight item still held the identical id), so two devices that traded edits over a
 * persistent link diverged indefinitely while both sides believed they were syncing.
 */
import { createDevice, connect, teardown, waitFor, partition, heal, sleep, Device } from './helpers/harness';
import { FakeVault } from './helpers/fake-vault';
import { TFile } from 'obsidian';

afterEach(teardown);

const A = 'device-aaaa0001';
const B = 'device-bbbb0002';
const T = 1_700_000_000_000;

function vaultWith(files: Record<string, [string, number]>): FakeVault {
    const vault = new FakeVault();
    for (const [path, [text, mtime]] of Object.entries(files)) vault.seed(path, text, mtime);
    return vault;
}

async function edit(device: Device, path: string, text: string, mtime: number) {
    const file = device.vault.getAbstractFileByPath(path) as TFile;
    await device.vault.modify(file, text, { mtime });
    await sleep(60);   // let the per-path debounce (10 ms in tests) flush
}

async function settle(a: Device, b: Device) {
    await waitFor(
        () => a.plugin.queueManager.getActiveTransfers() === 0 && b.plugin.queueManager.getActiveTransfers() === 0
            && a.plugin.queueManager.getQueueSize() === 0 && b.plugin.queueManager.getQueueSize() === 0
            && a.plugin.queueManager.getRetrying() === 0 && b.plugin.queueManager.getRetrying() === 0,
        { what: 'both queues to drain' },
    );
    await sleep(100);
}

describe('delta fallback', () => {
    test('a nack\'d delta falls back to a full send instead of being dropped', async () => {
        const a = await createDevice(A, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        const b = await createDevice(B, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        await connect(a, b);

        // A edits first; B receives the full send (receiving never seeds B's delta
        // base — that gap is what makes the stale-base delta below realistic).
        await edit(a, 'note.md', 'A-edit', T + 10_000);
        await waitFor(() => b.vault.text('note.md') === 'A-edit', { what: 'A\'s edit to reach B' });
        await settle(a, b);

        // B's delta base is stale: it remembers sending 'v1', but A holds 'A-edit'.
        (b.plugin as any).lastSentContent.set('note.md', { content: 'v1', timestamp: Date.now() });

        await edit(b, 'note.md', 'B-edit', T + 20_000);

        // B builds a delta against 'v1'; A's copy is 'A-edit', so the base hash cannot
        // match and A nacks. The fallback re-queue used to be swallowed by the dedup
        // wall (identical id to the in-flight item) — the words then stayed on B only.
        await waitFor(() => a.vault.text('note.md') === 'B-edit', { timeout: 20000, what: 'the full-send fallback to reach A' });
        await settle(a, b);
        expect(b.vault.text('note.md')).toBe('B-edit');
    }, 30000);
});

describe('deletes queued before a link drop', () => {
    test('park in failedSyncs and replay when the peer returns', async () => {
        const a = await createDevice(A, { vault: vaultWith({ 'gone.md': ['x', T] }) });
        const b = await createDevice(B, { vault: vaultWith({ 'gone.md': ['x', T] }) });
        await connect(a, b);
        await settle(a, b);

        // Hold the queue so the delete is enqueued but not processed, then cut the
        // link: the task now runs with no connected peer. Deletes used to fall through
        // the no-peer branch (only updates/deltas parked) and were reported success.
        b.plugin.queueManager.pause();
        await b.vault.delete(b.vault.getAbstractFileByPath('gone.md')!);
        // The delete handler chains asynchronously; the task must be IN the (paused)
        // heap before the link drops, or nothing would demonstrate the park.
        await waitFor(() => b.plugin.queueManager.getQueueSize() === 1, { what: 'the delete task to be queued' });
        await partition(a, b);
        b.plugin.queueManager.resume();
        await sleep(300);

        const parked = b.plugin.failedSyncs.find(f => f.path === 'gone.md');
        expect(parked).toMatchObject({ peerId: null, type: 'file-delete' });

        // And when the peer is reachable again, the retry loop delivers the deletion.
        heal(a, b);
        await connect(a, b);
        b.plugin.retryFailedSyncs();
        await waitFor(() => !a.vault.has('gone.md'), { timeout: 20000, what: 'the parked delete to reach A' });
    }, 30000);
});
