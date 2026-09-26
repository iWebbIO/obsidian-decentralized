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
    });
});
