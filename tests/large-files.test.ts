/**
 * Large files (above the ~5 MB Merkle tree surrogate threshold) are compared through a
 * size+mtime surrogate rather than their content hash — the path every attachment and
 * PDF takes. These tests pin that the surrogate never hides a real change: an edit made
 * while the devices are apart must still be found by reconciliation and transferred, and
 * two copies with identical bytes but different mtimes must not corrupt or loop.
 */
import { TFile } from 'obsidian';
import { createDevice, connect, teardown, waitFor, partition, heal, sleep } from './helpers/harness';
import { FakeVault } from './helpers/fake-vault';

afterEach(teardown);

const A = 'device-aaaa0001';
const B = 'device-bbbb0002';
/** Above the 5 MB threshold in buildMerkleTree, so the tree never hashes this content. */
const BIG = 6 * 1024 * 1024;

async function editFile(vault: FakeVault, path: string, text: string, mtime: number) {
    const file = vault.getAbstractFileByPath(path) as TFile;
    await vault.modify(file, text, { mtime });
    await sleep(60);   // let the per-path debounce (10 ms in tests) run
}

describe('large files diffed through the size+mtime surrogate', () => {
    test('an edit made while apart is found and transferred', async () => {
        const first = 'x'.repeat(BIG);
        const second = 'y'.repeat(BIG);   // same size, different bytes: only mtime betrays it

        const vaultA = new FakeVault();
        const vaultB = new FakeVault();
        vaultA.seed('media/big.bin', first, 1000);
        // Same bytes, a different mtime: pre-surrogate copies always look different at
        // first, which is exactly the state two vaults meet in.
        vaultB.seed('media/big.bin', first, 5000);

        const a = await createDevice(A, { vault: vaultA });
        const b = await createDevice(B, { vault: vaultB });
        await connect(a, b);
        // The first reconciliation sees differing surrogates but identical content:
        // nothing may be overwritten or duplicated.
        await waitFor(() => a.plugin.queueManager.getQueueSize() === 0
            && b.plugin.queueManager.getQueueSize() === 0
            && a.plugin.queueManager.getActiveTransfers() === 0
            && b.plugin.queueManager.getActiveTransfers() === 0,
            { what: 'the first reconciliation to settle', timeout: 15000 });
        expect(vaultB.text('media/big.bin')).toBe(first);

        await partition(a, b);
        await editFile(vaultA, 'media/big.bin', second, 9000);
        await heal(a, b);

        // Reconnect: A (the primary) sends its Merkle root, the traversal finds the
        // changed surrogate, and the new bytes must arrive on B.
        await waitFor(() => vaultB.text('media/big.bin') === second,
            { what: 'the large edit to reach the other device', timeout: 20000 });
    }, 60000);

    test('identical large files are not turned into conflicts by their different mtimes', async () => {
        const content = 'z'.repeat(BIG);

        const vaultA = new FakeVault();
        const vaultB = new FakeVault();
        vaultA.seed('big.md', content, 1000);
        vaultB.seed('big.md', content, 999_999);   // a day apart in mtime

        const a = await createDevice(A, { vault: vaultA });
        const b = await createDevice(B, { vault: vaultB });
        await connect(a, b);

        await waitFor(() => a.plugin.queueManager.getQueueSize() === 0
            && b.plugin.queueManager.getQueueSize() === 0
            && a.plugin.queueManager.getActiveTransfers() === 0
            && b.plugin.queueManager.getActiveTransfers() === 0,
            { what: 'reconciliation to settle', timeout: 15000 });

        // Same bytes: no conflict copy, no data change — the differing surrogate may
        // trigger an exchange, but never a rewrite.
        expect(vaultA.text('big.md')).toBe(content);
        expect(vaultB.text('big.md')).toBe(content);
        expect(a.plugin.failedSyncs.length).toBe(0);
        expect(b.plugin.failedSyncs.length).toBe(0);
        const copies = [...vaultA.getFiles(), ...vaultB.getFiles()].filter(f => f.path.includes('(conflict on'));
        expect(copies).toHaveLength(0);
    });
});
