import { InMemoryVaultStorage } from '../src/core/storage/InMemoryVaultStorage';
import { MerkleManager } from '../src/core/sync/MerkleManager';
import { VersionVectorManager } from '../src/core/sync/VersionVectorManager';
import { ConflictResolver } from '../src/core/sync/ConflictResolver';

describe('Core Sync Modules', () => {
    describe('MerkleManager', () => {
        let storage: InMemoryVaultStorage;
        let merkle: MerkleManager;

        beforeEach(() => {
            storage = new InMemoryVaultStorage();
            merkle = new MerkleManager(storage);
        });

        test('builds deterministic Merkle tree for identical contents', async () => {
            await storage.write('a.md', 'Hello');
            await storage.write('sub/b.md', 'World');

            const tree1 = await merkle.buildMerkleTree();
            expect(tree1.hash).toBeTruthy();

            // Rebuild with same contents produces identical root hash
            merkle.invalidate();
            const tree2 = await merkle.buildMerkleTree();
            expect(tree2.hash).toBe(tree1.hash);
        });

        test('detects content modifications in Merkle tree', async () => {
            await storage.write('doc.md', 'Version 1');
            const tree1 = await merkle.buildMerkleTree();

            merkle.invalidate();
            await storage.write('doc.md', 'Version 2');
            const tree2 = await merkle.buildMerkleTree();

            expect(tree2.hash).not.toBe(tree1.hash);
        });

        test('diffTrees accurately identifies added, changed, and identical files', async () => {
            const storageA = new InMemoryVaultStorage();
            const storageB = new InMemoryVaultStorage();

            await storageA.write('common.md', 'Same');
            await storageB.write('common.md', 'Same');

            await storageA.write('onlyA.md', 'A');
            await storageB.write('onlyB.md', 'B');

            await storageA.write('diff.md', 'Content A');
            await storageB.write('diff.md', 'Content B');

            const merkleA = new MerkleManager(storageA);
            const merkleB = new MerkleManager(storageB);

            const treeA = await merkleA.buildMerkleTree();
            const treeB = await merkleB.buildMerkleTree();

            const diff = merkleA.diffTrees(treeA, treeB);

            expect(diff.identical).toContain('common.md');
            expect(diff.missingRemotely).toContain('onlyA.md');
            expect(diff.missingLocally).toContain('onlyB.md');
            expect(diff.changed).toContain('diff.md');
        });

        test('diffTrees reports two empty vaults as identical without a phantom "" path', async () => {
            // Both roots are childless with an empty hash; the leaf-leaf branch used to
            // push "" into `identical`, handing callers a path that names no file.
            const emptyA = new MerkleManager(new InMemoryVaultStorage());
            const emptyB = new MerkleManager(new InMemoryVaultStorage());
            const treeA = await emptyA.buildMerkleTree();
            const treeB = await emptyB.buildMerkleTree();

            const diff = emptyA.diffTrees(treeA, treeB);

            expect(diff).toEqual({ missingLocally: [], missingRemotely: [], changed: [], identical: [] });
        });

        test('diffTrees reports a file facing a directory on both sides instead of dropping the file', async () => {
            // "a" is a file locally and a folder remotely (it holds "a/x.md"). The old
            // walk only descended into the directory's children, so the local file "a"
            // vanished from the diff and no reconciliation would ever push it.
            const storageA = new InMemoryVaultStorage();
            const storageB = new InMemoryVaultStorage();
            await storageA.write('a', 'a file');
            await storageB.write('a/x.md', 'inside the folder');

            const merkleA = new MerkleManager(storageA);
            const merkleB = new MerkleManager(storageB);
            const diff = merkleA.diffTrees(await merkleA.buildMerkleTree(), await merkleB.buildMerkleTree());

            expect(diff.missingRemotely).toContain('a');
            expect(diff.missingLocally).toContain('a/x.md');
        });

        test('a tree built while the vault changed is not cached as current', async () => {
            // Hashing awaits, so a vault write can land mid-build. The finished tree must
            // not be cached, or the change stays invisible until the next vault event and
            // anti-entropy compares against a stale tree. One listFiles call is one
            // build, which is what distinguishes a rebuild from a hash-cache hit.
            let builds = 0;
            const probing = new (class extends InMemoryVaultStorage {
                public async listFiles() {
                    builds++;
                    if (builds === 1) merkle.invalidate();   // the vault changes mid-build
                    return super.listFiles();
                }
            })();
            const merkle = new MerkleManager(probing);
            await probing.write('a.md', 'A');
            await probing.write('b.md', 'B');

            await merkle.buildMerkleTree();

            // Mid-build change: the tree was not cached, so this had to rebuild...
            expect(builds).toBe(1);
            await merkle.getMerkleTree();
            expect(builds).toBe(2);
            // ...and with no further changes, that rebuild is cached.
            await merkle.getMerkleTree();
            expect(builds).toBe(2);
        });
    });

    describe('VersionVectorManager', () => {
        test('increments device clocks', () => {
            let vv = {};
            vv = VersionVectorManager.increment(vv, 'deviceA');
            expect(vv).toEqual({ deviceA: 1 });
            vv = VersionVectorManager.increment(vv, 'deviceA');
            expect(vv).toEqual({ deviceA: 2 });
            vv = VersionVectorManager.increment(vv, 'deviceB');
            expect(vv).toEqual({ deviceA: 2, deviceB: 1 });
        });

        test('merges version vectors with component-wise maximum', () => {
            const v1 = { a: 2, b: 1 };
            const v2 = { a: 1, b: 3, c: 1 };
            const merged = VersionVectorManager.merge(v1, v2);
            expect(merged).toEqual({ a: 2, b: 3, c: 1 });
        });

        test('identifies causal relations (GREATER, LESSER, EQUAL, CONCURRENT)', () => {
            const v1 = { a: 2, b: 2 };
            const v2 = { a: 1, b: 1 };
            const v3 = { a: 3, b: 1 }; // Concurrent with v1

            expect(VersionVectorManager.compare(v1, v2)).toBe('GREATER');
            expect(VersionVectorManager.compare(v2, v1)).toBe('LESSER');
            expect(VersionVectorManager.compare(v1, v1)).toBe('EQUAL');
            expect(VersionVectorManager.compare(v1, v3)).toBe('CONCURRENT');
            expect(VersionVectorManager.isNewerThan(v1, v2)).toBe(true);
            expect(VersionVectorManager.isNewerThan(v1, v3)).toBe(false);
        });
    });

    describe('ConflictResolver', () => {
        const resolver = new ConflictResolver(2000);

        test('role-based strategy keeps local for primary and adopts remote for secondary', () => {
            const primaryOutcome = resolver.resolve({
                strategy: 'role-based',
                filePath: 'notes.md',
                localContent: 'Local',
                localMtime: 1000,
                remoteContent: 'Remote',
                remoteMtime: 2000,
                remoteDeviceId: 'peer2',
                myRole: 'primary'
            });
            expect(primaryOutcome.action).toBe('keep-local');

            const secondaryOutcome = resolver.resolve({
                strategy: 'role-based',
                filePath: 'notes.md',
                localContent: 'Local',
                localMtime: 1000,
                remoteContent: 'Remote',
                remoteMtime: 2000,
                remoteDeviceId: 'peer2',
                myRole: 'secondary'
            });
            expect(secondaryOutcome.action).toBe('adopt-remote');
            expect(secondaryOutcome.contentToSave).toBe('Remote');
        });

        test('last-write-wins picks newest beyond tolerance', () => {
            const outcome = resolver.resolve({
                strategy: 'last-write-wins',
                filePath: 'file.txt',
                localContent: 'Old',
                localMtime: 1000,
                remoteContent: 'New',
                remoteMtime: 5000,
                remoteDeviceId: 'peer2',
                myRole: 'primary'
            });
            expect(outcome.action).toBe('adopt-remote');
        });

        test('create-conflict-file generates conflict path', () => {
            const outcome = resolver.resolve({
                strategy: 'create-conflict-file',
                filePath: 'folder/my-note.md',
                localContent: 'Local',
                localMtime: 1000,
                remoteContent: 'Remote',
                remoteMtime: 2000,
                remoteDeviceId: 'peerB',
                myRole: 'primary'
            });
            expect(outcome.action).toBe('create-conflict-file');
            expect(outcome.conflictFilePath).toMatch(/^folder\/my-note\.conflict-peerB-2000\.md$/);
            expect(outcome.conflictFileContent).toBe('Remote');
        });

        test('three-way merge merges non-conflicting edits', () => {
            const base = "Line 1\nLine 2\nLine 3";
            const updated = "Line 1\nLine 2 modified\nLine 3";
            const patch = resolver.createPatch(base, updated);

            const otherLocal = "Line 1\nLine 2\nLine 3\nLine 4 added";
            const { mergedText, success } = resolver.mergePatches(otherLocal, patch);

            expect(success).toBe(true);
            expect(mergedText).toContain('Line 2 modified');
            expect(mergedText).toContain('Line 4 added');
        });

        test('last-write-wins treats mtimes within tolerance as a tie and breaks it by device id', () => {
            // Clocks on two devices skew by seconds; comparing those mtimes at full
            // resolution made "newer" depend on the skew. Within the tolerance the
            // device ID decides, and both ends reach the same verdict.
            const remoteNewer = resolver.resolve({
                strategy: 'last-write-wins',
                filePath: 'file.txt',
                localContent: 'Local',
                localMtime: 1000,
                localDeviceId: 'device-a',
                remoteContent: 'Remote',
                remoteMtime: 2500,   // 1500 ms apart, inside the 2000 ms tolerance
                remoteDeviceId: 'device-b',
                myRole: 'primary'
            });
            expect(remoteNewer.action).toBe('adopt-remote');

            const localNewer = resolver.resolve({
                strategy: 'last-write-wins',
                filePath: 'file.txt',
                localContent: 'Local',
                localMtime: 2500,
                localDeviceId: 'device-b',
                remoteContent: 'Remote',
                remoteMtime: 1000,   // same pair of times, ids swapped
                remoteDeviceId: 'device-a',
                myRole: 'primary'
            });
            expect(localNewer.action).toBe('keep-local');
        });

        test('three-way merge with a common base lands both sides\' edits', () => {
            const base = "Line 1\nLine 2\nLine 3";
            const local = "Line 1\nLine 2\nLine 3\nLine 4 added";
            const remote = "Line 1\nLine 2 modified\nLine 3";

            const outcome = resolver.resolve({
                strategy: 'three-way-merge',
                filePath: 'document.md',
                localContent: local,
                localMtime: 1000,
                localDeviceId: 'device-a',
                remoteContent: remote,
                remoteMtime: 1100,
                remoteDeviceId: 'device-b',
                myRole: 'primary',
                baseContent: base
            });

            expect(outcome.action).toBe('write-merged');
            expect(outcome.contentToSave).toContain('Line 2 modified');
            expect(outcome.contentToSave).toContain('Line 4 added');
        });

        test('three-way merge without a common base keeps both versions instead of "merging" into one side', () => {
            // With no base to diff against, the old code built a patch from local to
            // remote and applied it to local — which is always exactly the remote
            // content — and returned it as a successful merge. A merge that cannot be
            // attempted must fall back to a conflict file like the comment always claimed.
            const outcome = resolver.resolve({
                strategy: 'three-way-merge',
                filePath: 'document.md',
                localContent: 'the local edit',
                localMtime: 5000,     // local is the newer change
                localDeviceId: 'device-a',
                remoteContent: 'the remote edit',
                remoteMtime: 1000,
                remoteDeviceId: 'device-b',
                myRole: 'primary'
                // no baseContent: the caller never tracked what both sides shared
            });

            expect(outcome.action).toBe('create-conflict-file');
            expect(outcome.conflictFileContent).toBe('the remote edit');
            expect(outcome.contentToSave).toBeUndefined();   // the newer local version stays primary
        });

        test('three-way merge of binary content falls back to a conflict file', () => {
            const outcome = resolver.resolve({
                strategy: 'three-way-merge',
                filePath: 'image.png',
                localContent: new Uint8Array([1, 1, 1, 1]).buffer,
                localMtime: 5000,
                localDeviceId: 'device-a',
                remoteContent: new Uint8Array([2, 2, 2, 2]).buffer,
                remoteMtime: 1000,
                remoteDeviceId: 'device-b',
                myRole: 'primary',
                baseContent: 'not applicable'
            });

            expect(outcome.action).toBe('create-conflict-file');
            expect(outcome.conflictFileContent).toEqual(new Uint8Array([2, 2, 2, 2]).buffer);
        });
    });
});
