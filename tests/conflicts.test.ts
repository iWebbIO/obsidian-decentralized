/**
 * Convergence and conflicts between two real plugin instances, including edits and
 * deletions made while the devices could not reach each other.
 *
 * device-aaaa0001 sorts first, so it is the side that used to "win" every two-device conflict
 * under the old role rule regardless of which edit was newer.
 */
import { TFile } from 'obsidian';
import { createDevice, connect, teardown, waitFor, partition, heal, sleep, Device } from './helpers/harness';
import { FakeVault } from './helpers/fake-vault';
import { SyncPhase } from '../src/types';

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
    // Let the per-path debounce (10 ms in tests) and its handler run.
    await sleep(40);
}

function conflictCopies(device: Device): string[] {
    return device.vault.getFiles().map(f => f.path).filter(p => p.includes('(conflict on'));
}

async function settle(a: Device, b: Device) {
    await waitFor(
        () => a.plugin.queueManager.getActiveTransfers() === 0 && b.plugin.queueManager.getActiveTransfers() === 0
            && a.plugin.queueManager.getQueueSize() === 0 && b.plugin.queueManager.getQueueSize() === 0,
        { what: 'both queues to drain' },
    );
    await sleep(100);
}

describe('two devices reconciling after time apart', () => {
    test('an edit made offline on the second device survives reconnecting', async () => {
        const a = await createDevice(A, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        const b = await createDevice(B, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        await connect(a, b);
        await partition(a, b);

        await edit(b, 'note.md', 'v2 from B', T + 10_000);

        heal(a, b);
        await connect(a, b);
        await waitFor(() => a.vault.text('note.md') === 'v2 from B', { what: 'A to take B\'s offline edit' });
        await settle(a, b);

        expect(b.vault.text('note.md')).toBe('v2 from B');
        expect(conflictCopies(a)).toEqual([]);
        expect(conflictCopies(b)).toEqual([]);
    });

    test('concurrent edits: the newer one wins everywhere and the other is kept as a copy', async () => {
        const a = await createDevice(A, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        const b = await createDevice(B, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        await connect(a, b);
        await partition(a, b);

        await edit(a, 'note.md', 'older edit on A', T + 10_000);
        await edit(b, 'note.md', 'newer edit on B', T + 20_000);

        heal(a, b);
        await connect(a, b);
        await waitFor(() => a.vault.text('note.md') === 'newer edit on B', { what: 'the newer edit to win on A' });
        await settle(a, b);

        expect(b.vault.text('note.md')).toBe('newer edit on B');
        // The losing edit is preserved exactly once, on the device that made it.
        expect(conflictCopies(a)).toHaveLength(1);
        expect(a.vault.text(conflictCopies(a)[0])).toBe('older edit on A');
        expect(conflictCopies(b)).toEqual([]);
    });

    test('identical edit times go to the lower device ID on both sides', async () => {
        const a = await createDevice(A, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        const b = await createDevice(B, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        await connect(a, b);
        await partition(a, b);

        await edit(a, 'note.md', 'from A', T + 10_000);
        await edit(b, 'note.md', 'from B', T + 10_000);

        heal(a, b);
        await connect(a, b);
        await waitFor(() => b.vault.text('note.md') === 'from A', { what: 'A\'s edit to win the tie' });
        await settle(a, b);

        expect(a.vault.text('note.md')).toBe('from A');
        expect(conflictCopies(b).map(p => b.vault.text(p))).toEqual(['from B']);
        expect(conflictCopies(a)).toEqual([]);
    });

    test('a file deleted offline is not brought back by the other device', async () => {
        const a = await createDevice(A, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        const b = await createDevice(B, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        await connect(a, b);
        await partition(a, b);

        await b.vault.delete(b.vault.getAbstractFileByPath('note.md')!);
        await sleep(20);
        expect(b.plugin.tombstones['note.md']).toBeDefined();

        heal(a, b);
        await connect(a, b);
        await waitFor(() => !a.vault.has('note.md'), { what: 'the deletion to reach A' });
        await settle(a, b);

        expect(b.vault.has('note.md')).toBe(false);
        expect(a.vault.trashed).toContain('note.md');
    });

    test('a copy edited after the deletion is restored', async () => {
        const vaultB = new FakeVault();
        const b = await createDevice(B, { vault: vaultB, settings: { enableTwoDeviceOptimizations: false } });
        b.plugin.tombstones['note.md'] = T;
        const a = await createDevice(A, {
            vault: vaultWith({ 'note.md': ['edited after the delete', T + 5_000] }),
            settings: { enableTwoDeviceOptimizations: false },
        });
        await connect(a, b);

        await a.plugin.sendFileUpdate(a.vault.getAbstractFileByPath('note.md') as TFile, b.id, true);
        await waitFor(() => b.vault.text('note.md') === 'edited after the delete', { what: 'the newer copy to be restored' });
        expect(b.plugin.tombstones['note.md']).toBeUndefined();
    });
});

describe('hash cache', () => {
    test('an update this device rejects does not leave the peer\'s hash behind', async () => {
        // The peer's hash used to be cached before deciding. When the update was then
        // rejected, manifests and Merkle trees claimed the two different files were identical.
        const vault = vaultWith({ 'note.md': ['newer here', T + 60_000] });
        const b = await createDevice(B, { vault, settings: { enableTwoDeviceOptimizations: false } });
        const plugin: any = b.plugin;
        const theirs = 'older on the peer';

        await plugin.applyFileUpdate({
            type: 'file-update', path: 'note.md', content: theirs, mtime: T, encoding: 'utf8', transferId: 't',
            fileHash: await plugin.getHash(theirs),
        }, A);

        expect(vault.text('note.md')).toBe('newer here');
        const manifest = await plugin.buildVaultManifest();
        const entry = manifest.find((e: any) => e.path === 'note.md');
        expect(entry.hash === undefined || entry.hash === await plugin.getHash('newer here')).toBe(true);
    });

    test('a cached hash stops counting once the file changes outside Obsidian', async () => {
        const vault = vaultWith({ 'note.md': ['one', T] });
        const b = await createDevice(B, { vault });
        const plugin: any = b.plugin;
        await plugin.buildMerkleTree();
        const file = vault.getAbstractFileByPath('note.md') as TFile;
        expect(plugin.cachedHashFor(file)).toBe(await plugin.getHash('one'));

        vault.seed('note.md', 'two', T + 1_000);   // no vault event, as with an external editor

        expect(plugin.cachedHashFor(file)).toBeUndefined();
    });
});

describe('renames made offline', () => {
    test('move the file\'s records and tombstone the old path', async () => {
        const vault = vaultWith({ 'note.md': ['x', T] });
        const b = await createDevice(B, { vault });
        b.plugin.twoDeviceState.fileVersions['note.md'] = { [A]: 3 };

        await vault.rename(vault.getAbstractFileByPath('note.md')!, 'renamed.md');
        await sleep(20);

        expect(b.plugin.tombstones['note.md']).toBeDefined();
        expect(b.plugin.twoDeviceState.fileVersions['note.md']).toBeUndefined();
        expect(b.plugin.twoDeviceState.fileVersions['renamed.md']).toMatchObject({ [A]: 3, [B]: 1 });
    });
});

describe('full-sync completion', () => {
    test('finishes even when the peer gave up on a file it was allowed to pull', async () => {
        // A path the peer abandoned after three failures stayed "allowed" here forever, so this
        // side never declared itself done and the sync always ended in a timeout error.
        const b = await createDevice(B);
        const plugin: any = b.plugin;
        jest.spyOn(plugin, 'sendSyncMessage').mockResolvedValue(undefined);
        Object.assign(plugin.syncState, {
            isSyncing: true, peerId: A, currentPhase: SyncPhase.TRANSFERRING,
            pendingPulls: new Set(), allowedPulls: new Set(['stuck.md']), activeBatches: new Map(),
        });
        plugin.localSyncComplete.set(A, false);
        plugin.peerSyncComplete.set(A, false);

        plugin.checkFullSyncCompletion(A);
        await plugin.processIncomingData({ type: 'full-sync-complete' }, { peer: A, open: true, send: () => { } });

        expect(plugin.syncState.isSyncing).toBe(false);
    });
});
