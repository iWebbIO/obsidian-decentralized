/**
 * Regressions for what this device records on its own, with no peer involved:
 * durable state must stay small and truthful, and vault events that carry no
 * per-file meaning (folder events) must not leave state behind.
 */
import { createDevice, teardown, waitFor, sleep, MANIFEST } from './helpers/harness';
import { FakeVault } from './helpers/fake-vault';

afterEach(teardown);

const B = 'device-bbbb0002';
const A = 'device-aaaa0001';

function fromA() {
    return { peer: A, open: true, send: jest.fn() } as any;
}

describe('durable state', () => {
    test('state.json does not carry the Merkle tree', async () => {
        // The tree is the largest structure the plugin holds, and it is fully
        // rebuildable: merkleTreeBuiltAt is not persisted, so the first use after a
        // restart rebuilds anyway. Persisting it rewrote megabytes of JSON on every
        // save, several times a minute for the whole sync.
        const vault = new FakeVault();
        vault.seed('note.md', 'hello', 1000);
        const b = await createDevice(B, { vault });
        await b.plugin.buildMerkleTree();           // the in-memory tree now exists
        expect(b.plugin.twoDeviceState.merkleTreeRoot).not.toBeNull();

        await b.plugin.saveState(true);

        const raw = await vault.adapter.read(`${MANIFEST.dir}/state.json`);
        const state = JSON.parse(raw);
        expect(state.twoDeviceState.merkleTreeRoot).toBeNull();
        // The durable part is untouched.
        expect(state.twoDeviceState.fileVersions).toEqual(b.plugin.twoDeviceState.fileVersions);
    });

    test('a stale tree is never served, not even one restored from disk', async () => {
        // loadState can put a previous session's tree into twoDeviceState (and older
        // builds persisted it), while merkleTreeBuiltAt always starts at 0. Nothing
        // may answer from that copy.
        const vault = new FakeVault();
        vault.seed('note.md', 'old', 1000);
        const b = await createDevice(B, { vault });
        const plugin: any = b.plugin;
        const freshTree = await plugin.buildMerkleTree();

        plugin.twoDeviceState.merkleTreeRoot = { hash: 'stale-root', children: {} };
        plugin.merkleTreeBuiltAt = 0;

        const served = await plugin.getMerkleTree();
        expect(served.hash).toBe(freshTree.hash);      // rebuilt from the vault
        expect(served.hash).not.toBe('stale-root');
    });
});

describe('vault events with no peer connected', () => {
    test('folder events leave no version vectors or tombstones behind', async () => {
        // Folders never appear in manifests as files; their create/delete events used
        // to file version vectors and tombstones under the folder path, where nothing
        // ever read them — and with no tombstone of their own, the vectors were never
        // pruned either.
        const vault = new FakeVault();
        const b = await createDevice(B, { vault });

        await vault.createFolder('Notes');
        await vault.create('Notes/a.md', 'content');
        await waitFor(() => !!b.plugin.twoDeviceState.fileVersions['Notes/a.md'], { what: 'the file edit to be recorded' });

        expect(b.plugin.twoDeviceState.fileVersions['Notes']).toBeUndefined();
        expect(b.plugin.tombstones['Notes']).toBeUndefined();
        expect(b.plugin.twoDeviceState.fileVersions['Notes/a.md']).toBeDefined();

        await vault.delete(vault.getAbstractFileByPath('Notes/a.md')!);
        await waitFor(() => b.plugin.tombstones['Notes/a.md'] !== undefined, { what: 'the deletion to be recorded' });
        // Deleting the folder itself records nothing beyond what its files already did.
        await vault.delete(vault.getAbstractFileByPath('Notes')!);
        await sleep(30);

        expect(b.plugin.tombstones['Notes']).toBeUndefined();
        expect(b.plugin.tombstones['Notes/a.md']).toBeDefined();
    });

    test('deleting a folder offline tombstones each file it contained', async () => {
        // The folder's own event is skipped, so per-file delete events are what carry
        // the deletion; they must all be recorded or a peer resurrects the files.
        const vault = new FakeVault();
        vault.seed('Project/a.md', 'a', 1000);
        vault.seed('Project/b.md', 'b', 1000);
        vault.ensureHiddenFolder(MANIFEST.dir);
        const b = await createDevice(B, { vault });

        await vault.delete(vault.getAbstractFileByPath('Project/a.md')!);
        await vault.delete(vault.getAbstractFileByPath('Project/b.md')!);
        await waitFor(
            () => b.plugin.tombstones['Project/a.md'] !== undefined && b.plugin.tombstones['Project/b.md'] !== undefined,
            { what: 'both file deletions to be recorded' },
        );
        await vault.delete(vault.getAbstractFileByPath('Project')!);
        await sleep(30);

        expect(b.plugin.tombstones['Project']).toBeUndefined();
        expect(b.plugin.tombstones['Project/a.md']).toBeDefined();
        expect(b.plugin.tombstones['Project/b.md']).toBeDefined();
    });
});

describe('Merkle traversal without a pre-built tree', () => {
    test('node requests and responses build the tree on demand', async () => {
        // The handlers used to read twoDeviceState.merkleTreeRoot directly, which is
        // null until something builds it. They must build or reuse a current tree
        // themselves, and compare against it.
        const vault = new FakeVault();
        vault.seed('Notes/a.md', 'a', 1000);
        const b = await createDevice(B, { vault });
        const plugin: any = b.plugin;
        expect(plugin.twoDeviceState.merkleTreeRoot).toBeNull();   // nothing built yet

        const sent: any[] = [];
        jest.spyOn(plugin, 'sendData').mockImplementation((_peer: string, msg: any) => { sent.push(msg); });

        await plugin.handleMerkleNodeRequest({ type: 'merkle-node-request', path: '' }, fromA());
        expect(sent[0].type).toBe('merkle-node-response');
        expect(sent[0].folders).toEqual(['Notes']);

        // A child matching the freshly built tree is identical: nothing follows.
        await plugin.handleMerkleNodeResponse(
            { type: 'merkle-node-response', path: 'Notes', children: { 'a.md': await plugin.getHash('a') }, folders: [] }, fromA());
        expect(sent).toHaveLength(1);

        // A child we lack is requested against that same fresh tree.
        await plugin.handleMerkleNodeResponse(
            { type: 'merkle-node-response', path: 'Notes', children: { 'b.md': 'some-hash' }, folders: [] }, fromA());
        expect(sent).toContainEqual({ type: 'request-file', path: 'Notes/b.md' });
    });
});
