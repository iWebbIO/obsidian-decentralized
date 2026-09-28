/**
 * Wire-protocol regressions for the V3 hardening batch: the sync epoch (a stale plan
 * from an aborted sync cannot enter a newer one), scope-refusal feedback (a peer that
 * does not sync a path is told so, and the sender stops re-sending it), batch write
 * feedback (the puller's disk failures are reported back and re-sent), the
 * reconciliation re-arm after a sync, and the incremental Merkle tree agreeing with a
 * full rebuild.
 */
import { TFile } from 'obsidian';
import { createDevice, connect, teardown, waitFor, sleep } from './helpers/harness';
import { FakeVault } from './helpers/fake-vault';

afterEach(teardown);

const A = 'device-aaaa0001';
const B = 'device-bbbb0002';
const T = 1_700_000_000_000;

function vaultWith(files: Record<string, [string, number]>): FakeVault {
    const vault = new FakeVault();
    for (const [path, [text, mtime]] of Object.entries(files)) vault.seed(path, text, mtime);
    return vault;
}

function fromA() { return { peer: A, open: true, send: jest.fn() } as any; }

describe('sync epoch', () => {
    test('a plan answering an earlier sync run is dropped', async () => {
        // Sync 1 aborts on the initiator while the responder's plan is still retrying
        // on the wire; a new sync starts. The stale plan used to be applied verbatim
        // and computed pulls against the old manifest.
        const b = await createDevice(B);
        const plugin: any = b.plugin;
        plugin.syncState.isSyncing = true;
        plugin.syncState.peerId = A;
        plugin.syncState.syncEpoch = 'epoch-2';
        plugin.syncState.currentPhase = 'PLANNING';
        const apply = jest.spyOn(plugin, 'requestNextBatch');

        await plugin.handleSyncPlan({ type: 'sync-plan', syncEpoch: 'epoch-1', filesReceiverWillSend: [], filesInitiatorMustSend: [], filesReceiverMustDelete: [], filesInitiatorMustDelete: [], fileSizes: {} }, fromA());
        expect(apply).not.toHaveBeenCalled();

        // And the current epoch's plan still lands.
        await plugin.handleSyncPlan({ type: 'sync-plan', syncEpoch: 'epoch-2', filesReceiverWillSend: [], filesInitiatorMustSend: [], filesReceiverMustDelete: [], filesInitiatorMustDelete: [], fileSizes: {} }, fromA());
        expect(apply).toHaveBeenCalled();
        plugin.abortSync(undefined, { silent: true });
        apply.mockRestore();
    });
});

describe('scope-refusal feedback', () => {
    test('a refused push is nacked out-of-scope and the sender stops retrying', async () => {
        const a = await createDevice(A, { vault: vaultWith({}), settings: { syncMode: 'manual', excludedFolders: 'Private' } });
        const b = await createDevice(B, { vault: vaultWith({ 'Private/secret.md': ['x', T] }) });
        await connect(a, b);
        const ap: any = a.plugin, bp: any = b.plugin;

        // B pushes a file A's scope excludes (the receiver's filters decide).
        const bSend = jest.spyOn(bp, 'sendFileUpdate');
        const aNackSpy = jest.spyOn(ap, 'sendDirect');
        const aNacks = () => aNackSpy.mock.calls.map(([, m]: any[]) => m);

        await ap.processIncomingData(
            { type: 'file-update', path: 'Private/secret.md', content: 'for A', mtime: T, encoding: 'utf8', transferId: 't-scope' },
            { peer: B, open: true, send: jest.fn() });
        await sleep(400);

        // A refused: the nack says so, and B never parked a failure for the path
        // (before the verdict, this looped through the whole retry ladder).
        expect(aNacks().some((m: any) => m.type === 'nack' && m.reason === 'out-of-scope')).toBe(true);
        expect(bp.failedSyncs.some((f: any) => f.path === 'Private/secret.md')).toBe(false);
        expect(bSend.mock.calls.filter(([file]: any[]) => (file as TFile).path === 'Private/secret.md').length).toBeLessThanOrEqual(1);
    });
});

describe('batch write feedback', () => {
    test('paths that fail to apply are reported back and re-sent individually', async () => {
        const a = await createDevice(A, { vault: vaultWith({ 'note.md': ['peer copy', T], 'clash/inner.md': ['blocked by file', T] }) });
        const b = await createDevice(B, { vault: vaultWith({}) });
        await connect(a, b);
        const ap: any = a.plugin, bp: any = b.plugin;

        // B has a FILE at 'clash', so the batch's 'clash/inner.md' cannot be written.
        await b.vault.create('clash', 'a file where a folder is needed');

        const { packFilesToTLV } = require('../src/utils');
        const packed = {
            type: 'file-batch-binary', batchId: 'bx',
            data: packFilesToTLV([
                { path: 'note.md', mtime: T, isCompressed: false, encoding: 'utf8', content: new TextEncoder().encode('ok') },
                { path: 'clash/inner.md', mtime: T, isCompressed: false, encoding: 'utf8', content: new TextEncoder().encode('blocked by file') },
            ]),
        };

        // Pass-through spies: record without swallowing (a mockImplementation here
        // would eat the very feedback this test drives).
        const directSpy = jest.spyOn(bp, 'sendDirect');
        const resend = jest.spyOn(ap, 'sendFileUpdate');

        // Through the real dispatch: the feedback is sent back along the connection
        // the batch arrived on.
        await bp.processIncomingData(packed, { peer: A, open: true, send: jest.fn() });
        await sleep(200);

        expect(b.vault.has('note.md')).toBe(true);
        expect(b.vault.has('clash/inner.md')).toBe(false);
        // B reported the write failure...
        expect(directSpy.mock.calls.some(([, m]: any[]) => m.type === 'batch-apply-failed' && m.paths.includes('clash/inner.md'))).toBe(true);
        // ...and A, on receiving that report, re-sends the path individually.
        await ap.processIncomingData({ type: 'batch-apply-failed', batchId: 'bx', paths: ['clash/inner.md'] }, { peer: B, open: true, send: jest.fn() });
        await sleep(50);
        expect(resend.mock.calls.some(([file]: any[]) => file.path === 'clash/inner.md')).toBe(true);
    });
});

describe('incremental Merkle tree', () => {
    test('per-path updates agree with a full rebuild after edits and deletes', async () => {
        const files: Record<string, [string, number]> = {
            'a.md': ['a', T], 'sub/b.md': ['b', T], 'sub/deep/c.md': ['c', T],
        };
        const b = await createDevice(B, { vault: vaultWith(files) });
        const plugin: any = b.plugin;
        await plugin.buildMerkleTree();

        const assertAgrees = async () => {
            // The incremental result must be exactly a full rebuild of the same vault.
            const incrementalJson = JSON.stringify(plugin.twoDeviceState.merkleTreeRoot);
            plugin.invalidateMerkleTree();           // no path → full invalidation
            await plugin.buildMerkleTree();
            expect(JSON.stringify(plugin.twoDeviceState.merkleTreeRoot)).toBe(incrementalJson);
        };

        await b.vault.modify(b.vault.getAbstractFileByPath('sub/b.md') as TFile, 'b-edited', { mtime: T + 10 });
        await plugin.getMerkleTree();               // applies the dirty path incrementally
        await assertAgrees();

        await b.vault.create('sub/new.md', 'fresh', { mtime: Date.now() });
        await plugin.getMerkleTree();
        await assertAgrees();

        await b.vault.delete(b.vault.getAbstractFileByPath('sub/deep/c.md')!);
        await plugin.getMerkleTree();
        await assertAgrees();

        await b.vault.rename(b.vault.getAbstractFileByPath('a.md')!, 'renamed.md');
        await plugin.getMerkleTree();
        await assertAgrees();
    });

    test('a vault emptied of its last file no longer matches a peer still holding it', async () => {
        // The emptied tree used to keep the pre-delete root hash, so reconciliation
        // declared the vaults "in sync" and the peer kept the file forever.
        const a = await createDevice(A, { vault: vaultWith({ 'only.md': ['x', T] }) });
        const b = await createDevice(B, { vault: vaultWith({ 'only.md': ['x', T] }) });
        await connect(a, b);
        await waitFor(() => {
            const ta = (a.plugin as any).twoDeviceState.merkleTreeRoot;
            const tb = (b.plugin as any).twoDeviceState.merkleTreeRoot;
            return ta && tb && ta.hash === tb.hash;
        }, { what: 'both trees built and matching' });

        await b.vault.delete(b.vault.getAbstractFileByPath('only.md')!);
        const tb = await (b.plugin as any).getMerkleTree();
        const ta = (a.plugin as any).twoDeviceState.merkleTreeRoot;
        expect(tb.hash).not.toBe(ta.hash);
        expect(tb.hash).toBe('');   // the empty-vault root, as a full rebuild produces
    });
});

describe('reconciliation re-arm', () => {
    test('a link that connected during a sync exchanges once the sync ends', async () => {
        const a = await createDevice(A, { vault: vaultWith({ 'late.md': ['from A', T] }) });
        const b = await createDevice(B, { vault: vaultWith({}) });
        await connect(a, b);
        // Simulate "connected during a sync": the handshake's exchange was skipped.
        const ap: any = a.plugin;
        ap.syncState.isSyncing = true;
        await a.vault.modify(a.vault.getAbstractFileByPath('late.md') as TFile, 'edited during the sync', { mtime: T + 10_000 });
        await sleep(150);

        // The sync ends: the re-arm fires the exchange the handshake missed.
        ap.syncState.isSyncing = false;
        ap.rearmReconciliation();
        await waitFor(() => b.vault.text('late.md') === 'edited during the sync', { timeout: 15000, what: 'the post-sync exchange to deliver the edit' });
    });
});
