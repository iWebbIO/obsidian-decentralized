/**
 * Convergence and conflicts between two real plugin instances, including edits and
 * deletions made while the devices could not reach each other.
 *
 * device-aaaa0001 sorts first, so it is the side that used to "win" every two-device conflict
 * under the old role rule regardless of which edit was newer.
 */
import { TFile, Modal } from 'obsidian';
import { ConflictListModal } from '../src/ui';
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
        // The losing edit is kept once — saved by the device that made it, and synced like
        // any note so the conflict can be resolved on either device.
        expect(conflictCopies(a)).toHaveLength(1);
        expect(a.vault.text(conflictCopies(a)[0])).toBe('older edit on A');
        await waitFor(() => conflictCopies(b).length === 1, { what: 'the copy to sync' });
        expect(conflictCopies(b)).toEqual(conflictCopies(a));
        expect(b.vault.text(conflictCopies(b)[0])).toBe('older edit on A');
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
        await waitFor(() => conflictCopies(a).length === 1, { what: 'the copy to sync' });
        expect(conflictCopies(a).map(p => a.vault.text(p))).toEqual(['from B']);
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

    test('an offline deletion still reaches the other device when its queued send was lost', async () => {
        // Deletions used to reach the other device only through the queued send-delete. When
        // that was lost (a restart, retries exhausted) reconciliation pulled the file back.
        const a = await createDevice(A, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        const b = await createDevice(B, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        await connect(a, b);
        await partition(a, b);

        await b.vault.delete(b.vault.getAbstractFileByPath('note.md')!);
        await sleep(20);
        b.plugin.queueManager.clear();

        heal(a, b);
        await connect(a, b);
        await waitFor(() => !a.vault.has('note.md'), { what: 'the deletion to reach A' });
        await settle(a, b);

        expect(b.vault.has('note.md')).toBe(false);
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

describe('after a conflict', () => {
    test('the next ordinary edit is not another conflict', async () => {
        // The winner never folded the loser's edit into its version vector, so its next plain
        // edit looked concurrent with the loser's merged vector and produced a second copy.
        const a = await createDevice(A, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        const b = await createDevice(B, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        await connect(a, b);
        await partition(a, b);
        await edit(a, 'note.md', 'older edit on A', T + 10_000);
        await edit(b, 'note.md', 'newer edit on B', T + 20_000);
        heal(a, b);
        await connect(a, b);
        await waitFor(() => a.vault.text('note.md') === 'newer edit on B', { what: 'the conflict to resolve' });
        await settle(a, b);
        expect(conflictCopies(a)).toHaveLength(1);

        await edit(b, 'note.md', 'later ordinary edit on B', T + 30_000);
        await waitFor(() => a.vault.text('note.md') === 'later ordinary edit on B', { what: 'the edit to arrive' });
        await settle(a, b);
        expect(conflictCopies(a)).toHaveLength(1);
        expect(conflictCopies(b)).toEqual(conflictCopies(a));
    });
});

describe('first sync of vaults that differed before the plugin was installed', () => {
    test('the newer copy of each note wins, without conflict copies', async () => {
        // Neither side has any recorded edit: there is no edit here to protect, and a copy
        // per differing note would bury a stale vault clone in "(conflict on …)" files.
        const a = await createDevice(A, { vault: vaultWith({ 'x.md': ['stale on A', T], 'y.md': ['newer on A', T + 5_000] }) });
        const b = await createDevice(B, { vault: vaultWith({ 'x.md': ['newer on B', T + 5_000], 'y.md': ['stale on B', T] }) });
        await connect(a, b);
        await waitFor(() => a.vault.text('x.md') === 'newer on B' && b.vault.text('y.md') === 'newer on A', { what: 'the newer copies to win' });
        await settle(a, b);

        expect([a.vault.text('x.md'), a.vault.text('y.md')]).toEqual(['newer on B', 'newer on A']);
        expect([b.vault.text('x.md'), b.vault.text('y.md')]).toEqual(['newer on B', 'newer on A']);
        expect(conflictCopies(a)).toEqual([]);
        expect(conflictCopies(b)).toEqual([]);
    });
});

describe('an edit right after a change arrives', () => {
    test('is synced, not taken for the incoming write', async () => {
        // Every event on a note was ignored for two seconds after a peer's version was
        // written there, so an edit made in that window was never counted or sent. (Edit
        // locks, which deliberately hold the other device's edits for a while, are off here.)
        const settings = { enableTwoDeviceOptimizations: false };
        const a = await createDevice(A, { vault: vaultWith({ 'note.md': ['v1', T] }), settings });
        const b = await createDevice(B, { vault: vaultWith({ 'note.md': ['v1', T] }), settings });
        await connect(a, b);

        await edit(a, 'note.md', 'from A', T + 10_000);
        await waitFor(() => b.vault.text('note.md') === 'from A', { what: 'A\'s edit to arrive' });
        await edit(b, 'note.md', 'from A, then B right away', T + 11_000);

        await waitFor(() => a.vault.text('note.md') === 'from A, then B right away', { what: 'B\'s quick edit to reach A', timeout: 1500 });
        await settle(a, b);
        expect(conflictCopies(a)).toEqual([]);
        expect(conflictCopies(b)).toEqual([]);
    });

    test('the incoming write itself is not counted as an edit here', async () => {
        const a = await createDevice(A, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        const b = await createDevice(B, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        await connect(a, b);

        await edit(a, 'note.md', 'from A', T + 10_000);
        await waitFor(() => b.vault.text('note.md') === 'from A', { what: 'A\'s edit to arrive' });
        await settle(a, b);
        expect(b.plugin.twoDeviceState.fileVersions['note.md']?.[B]).toBeUndefined();
    });
});

describe('resolving a conflict', () => {
    async function resolvedConflict() {
        const a = await createDevice(A, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        const b = await createDevice(B, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        await connect(a, b);
        await partition(a, b);
        await edit(a, 'note.md', 'older edit on A', T + 10_000);
        await edit(b, 'note.md', 'newer edit on B', T + 20_000);
        heal(a, b);
        await connect(a, b);
        await waitFor(() => conflictCopies(a).length === 1 && a.vault.text('note.md') === 'newer edit on B', { what: 'the conflict copy' });
        await settle(a, b);
        return [a, b] as const;
    }

    function chooseInModal(label: string) {
        const open = (Modal as any).openModals as any[];
        const modal = open[open.length - 1];
        const button = modal.contentEl.findByText(label);
        if (!button) throw new Error(`No "${label}" button`);
        button.click();
    }

    test('picking the conflict copy updates every device and removes the copy', async () => {
        const [a, b] = await resolvedConflict();
        const copyPath = conflictCopies(a)[0];

        const list = new ConflictListModal(a.app as any, (a.plugin as any).conflictCenter, a.plugin);
        await list.showResolutionModal('note.md', copyPath);
        chooseInModal('Use the conflict copy');

        await waitFor(() => b.vault.text('note.md') === 'older edit on A', { what: 'the chosen version to reach B' });
        await settle(a, b);
        expect(a.vault.text('note.md')).toBe('older edit on A');
        expect(conflictCopies(a)).toEqual([]);
        expect(conflictCopies(b)).toEqual([]);
        expect(a.vault.trashed).toContain(copyPath);
    });

    test('keeping the current version sends nothing and removes the copy', async () => {
        const [a, b] = await resolvedConflict();
        const copyPath = conflictCopies(a)[0];
        const sent = jest.spyOn(a.plugin, 'sendFileUpdate');

        const list = new ConflictListModal(a.app as any, (a.plugin as any).conflictCenter, a.plugin);
        await list.showResolutionModal('note.md', copyPath);
        chooseInModal('Keep the current version');
        await waitFor(() => conflictCopies(a).length === 0, { what: 'the copy to go' });
        await settle(a, b);

        expect(a.vault.text('note.md')).toBe('newer edit on B');
        expect(b.vault.text('note.md')).toBe('newer edit on B');
        expect(sent.mock.calls.filter(([file]) => (file as TFile).path === 'note.md')).toEqual([]);
    });
});

describe('conflict setting', () => {
    async function concurrentEdits(settings: Record<string, unknown>) {
        const a = await createDevice(A, { vault: vaultWith({ 'note.md': ['v1', T] }), settings });
        const b = await createDevice(B, { vault: vaultWith({ 'note.md': ['v1', T] }), settings });
        await connect(a, b);
        await partition(a, b);
        await edit(a, 'note.md', 'older edit on A', T + 10_000);
        await edit(b, 'note.md', 'newer edit on B', T + 20_000);
        heal(a, b);
        await connect(a, b);
        await waitFor(() => a.vault.text('note.md') === 'newer edit on B', { what: 'the newer edit to win' });
        await settle(a, b);
        return [a, b] as const;
    }

    test('a saved "create conflict file" keeps the newer version on both devices, and the older as a copy', async () => {
        // It used to keep each device's own version and file the other's as the copy, so the
        // two devices never agreed on the note itself.
        const [a, b] = await concurrentEdits({ syncMode: 'manual', conflictResolutionStrategy: 'create-conflict-file' });
        expect(b.vault.text('note.md')).toBe('newer edit on B');
        expect(conflictCopies(a).map(p => a.vault.text(p))).toEqual(['older edit on A']);
    });

    test('"last write wins" keeps the newer version and no copy', async () => {
        const [a, b] = await concurrentEdits({ syncMode: 'manual', conflictResolutionStrategy: 'last-write-wins' });
        expect(b.vault.text('note.md')).toBe('newer edit on B');
        expect(conflictCopies(a)).toEqual([]);
        expect(conflictCopies(b)).toEqual([]);
    });
});

describe('three devices', () => {
    const C = 'device-cccc0003';

    async function trio(files: Record<string, [string, number]>) {
        const a = await createDevice(A, { vault: vaultWith(files) });
        const b = await createDevice(B, { vault: vaultWith(files) });
        const c = await createDevice(C, { vault: vaultWith(files) });
        await connect(a, b);
        await connect(a, c);
        await connect(b, c);
        return [a, b, c] as const;
    }

    async function settleAll(...devices: Device[]) {
        await waitFor(() => devices.every(d => d.plugin.queueManager.getActiveTransfers() === 0 && d.plugin.queueManager.getQueueSize() === 0),
            { what: 'every queue to drain' });
        await sleep(150);
    }

    /** Conflict copies may spread to other devices by reconciliation; none may hold the winner. */
    function copyContents(...devices: Device[]): Set<string> {
        return new Set(devices.flatMap(d => conflictCopies(d).map(p => d.vault.text(p) ?? '')));
    }

    test('independent edits end with the newer one on every device, the older kept as a copy', async () => {
        const [a, b, c] = await trio({ 'note.md': ['v1', T] });
        // A and B cannot reach each other; C still reaches both.
        await partition(a, b);

        await edit(a, 'note.md', 'older edit on A', T + 10_000);
        await edit(b, 'note.md', 'newer edit on B', T + 20_000);
        await waitFor(() => c.vault.text('note.md') === 'newer edit on B', { what: 'C to settle on the newer edit' });

        heal(a, b);
        await connect(a, b);
        await waitFor(() => [a, b, c].every(d => d.vault.text('note.md') === 'newer edit on B'), { what: 'every device to hold the newer edit' });
        await settleAll(a, b, c);

        expect([a, b, c].map(d => d.vault.text('note.md'))).toEqual(['newer edit on B', 'newer edit on B', 'newer edit on B']);
        // A's edit is never silently dropped: A keeps it, once.
        expect(conflictCopies(a).map(p => a.vault.text(p))).toEqual(['older edit on A']);
        expect(copyContents(a, b, c)).toEqual(new Set(['older edit on A']));
        for (const d of [b, c]) expect(conflictCopies(d).length).toBeLessThanOrEqual(1);
    });

    test('identical edit times go to the lower device ID on every device', async () => {
        const [a, b, c] = await trio({ 'note.md': ['v1', T] });
        await partition(a, b);

        await edit(a, 'note.md', 'from A', T + 10_000);
        await edit(b, 'note.md', 'from B', T + 10_000);

        heal(a, b);
        await connect(a, b);
        await waitFor(() => [a, b, c].every(d => d.vault.text('note.md') === 'from A'), { what: 'A\'s edit to win everywhere' });
        await settleAll(a, b, c);

        expect([a, b, c].map(d => d.vault.text('note.md'))).toEqual(['from A', 'from A', 'from A']);
        expect(conflictCopies(b).map(p => b.vault.text(p))).toEqual(['from B']);
        expect(copyContents(a, b, c)).toEqual(new Set(['from B']));
    });

    test('a deletion made after an edit elsewhere wins everywhere; the edit goes to the trash', async () => {
        const [a, b, c] = await trio({ 'note.md': ['v1', T] });
        await partition(a, b);

        await edit(a, 'note.md', 'edited on A', T + 10_000);
        await b.vault.delete(b.vault.getAbstractFileByPath('note.md')!);   // now: after the edit
        await sleep(40);

        heal(a, b);
        await connect(a, b);
        await waitFor(() => [a, b, c].every(d => !d.vault.has('note.md')), { what: 'the deletion to win everywhere' });
        await settleAll(a, b, c);

        expect([a, b, c].some(d => d.vault.has('note.md'))).toBe(false);
        expect(a.vault.trashed).toContain('note.md');
    });

    test('an edit made after a deletion elsewhere wins everywhere; the note comes back', async () => {
        const [a, b, c] = await trio({ 'note.md': ['v1', T] });
        await partition(a, b);

        await b.vault.delete(b.vault.getAbstractFileByPath('note.md')!);
        await sleep(40);
        await edit(a, 'note.md', 'edited after the deletion', Date.now() + 60_000);

        heal(a, b);
        await connect(a, b);
        await waitFor(() => [a, b, c].every(d => d.vault.text('note.md') === 'edited after the deletion'), { what: 'the edit to win everywhere' });
        await settleAll(a, b, c);

        expect(b.plugin.tombstones['note.md']).toBeUndefined();
        expect(c.plugin.tombstones['note.md']).toBeUndefined();
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
