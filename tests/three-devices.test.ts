/**
 * Three real plugin instances: the partition/heal matrix (47), the same-winner-
 * everywhere contract (48), and rename/delete propagation through the third
 * device (49). These exercise production code — the sim/stress suites pin the
 * core library only (see the parity note on VirtualDevice).
 */
import { TFile } from 'obsidian';
import { createDevice, connect, teardown, waitFor, partition, heal, sleep, Device } from './helpers/harness';
import { FakeVault } from './helpers/fake-vault';

afterEach(teardown);

const A = 'device-aaaa0001';
const B = 'device-bbbb0002';
const C = 'device-cccc0003';
const T = 1_700_000_000_000;

function vaultWith(files: Record<string, [string, number]>): FakeVault {
    const vault = new FakeVault();
    for (const [path, [text, mtime]] of Object.entries(files)) vault.seed(path, text, mtime);
    return vault;
}

async function trio(files: Record<string, [string, number]> = {}): Promise<[Device, Device, Device]> {
    const a = await createDevice(A, { vault: vaultWith(files) });
    const b = await createDevice(B, { vault: vaultWith(files) });
    const c = await createDevice(C, { vault: vaultWith(files) });
    await connect(a, b);
    await connect(a, c);
    await connect(b, c);
    await waitFor(() => [a, b, c].every(d => d.plugin.queueManager.getQueueSize() === 0 && d.plugin.queueManager.getActiveTransfers() === 0),
        { what: 'all three queues to settle' });
    return [a, b, c];
}

async function edit(device: Device, path: string, text: string, mtime: number) {
    const file = device.vault.getAbstractFileByPath(path) as TFile;
    await device.vault.modify(file, text, { mtime });
    await sleep(60);
}

function conflictCopies(device: Device): string[] {
    return device.vault.getFiles().map(f => f.path).filter(p => p.includes('(conflict on'));
}

describe('three devices: the partition/heal matrix (47)', () => {
    test('an edit made while the pair is split reaches the third device, and the healed pair converges', async () => {
        const [a, b, c] = await trio({ 'shared.md': ['v0', T] });

        await partition(a, b);
        await edit(a, 'shared.md', 'edit while split', T + 10_000);
        // The intact A-C link gets the edit as a direct push from its author. (The
        // plugin does not relay content: B converges on reconnect, not via C.)
        await waitFor(() => c.vault.text('shared.md') === 'edit while split', { timeout: 15000, what: 'C to receive the direct push' });
        // The cut A-B pair: B is still on v0 until the heal.
        expect(b.vault.text('shared.md')).toBe('v0');

        heal(a, b);
        await connect(a, b);
        await waitFor(() => b.vault.text('shared.md') === 'edit while split', { timeout: 20000, what: 'the healed pair to converge' });
        expect(a.vault.text('shared.md')).toBe('edit while split');
    }, 60000);

    test('fully partitioned edits on all three devices converge to one winner plus copies', async () => {
        const [a, b, c] = await trio({ 'three.md': ['v0', T] });
        // Cut every pair: all three edit independently.
        await partition(a, b);
        await partition(a, c);
        await partition(b, c);

        await edit(a, 'three.md', 'from A', T + 10_000);
        await edit(b, 'three.md', 'from B', T + 20_000);
        await edit(c, 'three.md', 'from C', T + 30_000);

        heal(a, b); heal(a, c); heal(b, c);
        await connect(a, b);
        await connect(b, c);
        await waitFor(() => [a, b, c].every(d => d.vault.text('three.md') === 'from C'), { timeout: 20000, what: 'the newest edit to win on all three' });
        // Every device holds exactly one copy of some loser; no edit vanished.
        for (const d of [a, b, c]) {
            await waitFor(() => conflictCopies(d).length >= 1, { timeout: 15000, what: `${d.id} to keep a losing copy` });
        }
        const kept = new Set<string>();
        for (const d of [a, b, c]) for (const p of conflictCopies(d)) kept.add(d.vault.text(p) ?? '');
        expect(kept.has('from A')).toBe(true);
        expect(kept.has('from B')).toBe(true);
    }, 90000);
});

describe('three devices: the same winner everywhere (48)', () => {
    test('a delete made on one device wins everywhere once its time is newest', async () => {
        const [a, b, c] = await trio({ 'doomed.md': ['x', T] });
        await edit(b, 'doomed.md', 'last edit', T + 10_000);
        await waitFor(() => [a, c].every(d => b.vault.text('doomed.md') !== null && d.vault.text('doomed.md') === 'last edit'), { what: 'the edit to spread' });

        // Delete on C with a NEWER deletion time than the edit.
        const cFile = c.vault.getAbstractFileByPath('doomed.md') as TFile;
        await c.vault.modify(cFile, 'last edit', { mtime: T + 10_000 });
        await sleep(50);
        await c.vault.delete(cFile);
        await sleep(120);

        await waitFor(() => [a, b, c].every(d => !d.vault.has('doomed.md')), { timeout: 20000, what: 'the deletion to win on all three' });
    });
});

describe('three devices: rename and delete propagation (49)', () => {
    test('a rename on A reaches B and C, records travel with it, and the old path stays dead', async () => {
        const [a, b, c] = await trio({ 'old name.md': ['content', T] });
        await a.vault.rename(a.vault.getAbstractFileByPath('old name.md')!, 'new name.md');
        await sleep(200);

        await waitFor(() => b.vault.has('new name.md') && c.vault.has('new name.md'), { timeout: 15000, what: 'the rename to reach both peers' });
        await waitFor(() => !b.vault.has('old name.md') && !c.vault.has('old name.md'), { what: 'the old path to vanish on both peers' });
        expect(b.vault.text('new name.md')).toBe('content');
        expect(c.vault.text('new name.md')).toBe('content');
        // The tombstone on the sender keeps a late copy of the old path from resurrecting.
        expect(a.plugin.tombstones['old name.md']).toBeDefined();
    });

    test('an edit racing the rename still reaches the peers under the new name', async () => {
        const [a, b, c] = await trio({ 'moving.md': ['v0', T] });
        await edit(a, 'moving.md', 'v1 edit', T + 10_000);
        await sleep(60);
        await a.vault.rename(a.vault.getAbstractFileByPath('moving.md')!, 'moved.md');

        await waitFor(() => b.vault.has('moved.md') && b.vault.text('moved.md') === 'v1 edit', { timeout: 15000, what: 'B to hold the edit under the new name' });
        await waitFor(() => c.vault.has('moved.md') && c.vault.text('moved.md') === 'v1 edit', { timeout: 15000, what: 'C to hold the edit under the new name' });
    });
});

describe('failure paths over real plugin instances (40)', () => {
    test('a mid-sync link drop aborts cleanly and a reconnect finishes the job', async () => {
        const files: Record<string, [string, number]> = {};
        for (let i = 0; i < 30; i++) files[`bulk/file${i}.md`] = [`content ${i}`, T + i];
        const [a, b] = await (async () => {
            const x = await createDevice(A, { vault: vaultWith(files) });
            const y = await createDevice(B, { vault: vaultWith({}) });
            await connect(x, y);
            return [x, y] as const;
        })();

        // Start a full sync, then cut the link mid-flight.
        const done: any = (b.plugin as any).requestFullSyncFromPeer(A);
        await sleep(150);
        await partition(a, b);
        await done.catch(() => { /* the abort is the expected outcome */ });
        await waitFor(() => !(b.plugin as any).syncState.isSyncing, { timeout: 15000, what: 'the sync to abort' });
        expect((b.plugin as any).syncState.currentPhase).toBe('IDLE');

        // Reconnect: the reconciliation finishes what the sync started.
        heal(a, b);
        await connect(a, b);
        await waitFor(() => {
            const missing = Object.keys(files).filter(p => !b.vault.has(p));
            return missing.length === 0;
        }, { timeout: 30000, what: 'every file to arrive after the reconnect' });
        expect(b.vault.text('bulk/file17.md')).toBe('content 17');
    });

    test('a queued edit survives a link drop in the paused queue and arrives on reconnect', async () => {
        const [a, b] = await (async () => {
            const x = await createDevice(A, { vault: vaultWith({ 'resume.md': ['persisted', T] }) });
            const y = await createDevice(B, { vault: vaultWith({}) });
            await connect(x, y);
            return [x, y] as const;
        })();
        // Enqueue a send while the queue is paused, then drop the link: the task
        // runs with no peer and parks; the reconnect re-drives it.
        (a.plugin as any).queueManager.pause();
        await edit(a, 'resume.md', 'queued before the drop', T + 10_000);
        await waitFor(() => (a.plugin as any).queueManager.getQueueSize() >= 1, { what: 'the send task to be queued' });
        await partition(a, b);
        (a.plugin as any).queueManager.resume();
        await sleep(200);

        heal(a, b);
        await connect(a, b);
        await waitFor(() => b.vault.text('resume.md') === 'queued before the drop', { timeout: 15000, what: 'the queued edit to arrive after the drop' });
    });
});
