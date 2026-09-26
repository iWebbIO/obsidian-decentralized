import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { InMemoryVaultStorage } from '../src/core/storage/InMemoryVaultStorage';
import { NodeFsVaultStorage } from '../src/core/storage/NodeFsVaultStorage';
import { IVaultStorage } from '../src/core/storage/IVaultStorage';

function testStorageSuite(name: string, getStorage: () => Promise<{ storage: IVaultStorage; cleanup: () => Promise<void> }>) {
    describe(`IVaultStorage: ${name}`, () => {
        let storage: IVaultStorage;
        let cleanup: () => Promise<void>;

        beforeEach(async () => {
            const setup = await getStorage();
            storage = setup.storage;
            cleanup = setup.cleanup;
        });

        afterEach(async () => {
            if (cleanup) await cleanup();
        });

        test('writes and reads utf-8 text file', async () => {
            await storage.write('notes/test.md', 'Hello World');
            const exists = await storage.exists('notes/test.md');
            expect(exists).toBe(true);

            const content = await storage.read('notes/test.md');
            expect(content).toBe('Hello World');
        });

        test('writes and reads binary file', async () => {
            const buffer = new Uint8Array([1, 2, 3, 4, 5, 255]).buffer;
            await storage.writeBinary('images/pic.png', buffer);

            const exists = await storage.exists('images/pic.png');
            expect(exists).toBe(true);

            const readBuf = await storage.readBinary('images/pic.png');
            expect(new Uint8Array(readBuf)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 255]));
        });

        test('preserves mtime on write', async () => {
            const mtime = 1700000000000;
            await storage.write('doc.txt', 'Preserve mtime', mtime);

            const stat = await storage.stat('doc.txt');
            expect(stat).not.toBeNull();
            // Node utimes resolution might truncate to seconds or ms
            expect(Math.abs((stat?.mtime || 0) - mtime)).toBeLessThan(2000);
        });

        test('deletes a single file and a folder recursively', async () => {
            await storage.write('folder/file1.txt', '1');
            await storage.write('folder/file2.txt', '2');
            await storage.write('other.txt', '3');

            await storage.delete('folder/file1.txt');
            expect(await storage.exists('folder/file1.txt')).toBe(false);
            expect(await storage.exists('folder/file2.txt')).toBe(true);

            await storage.delete('folder');
            expect(await storage.exists('folder/file2.txt')).toBe(false);
            expect(await storage.exists('other.txt')).toBe(true);
        });

        test('renames files and directories', async () => {
            await storage.write('docs/doc1.md', 'Content 1');
            await storage.rename('docs/doc1.md', 'docs/renamed.md');

            expect(await storage.exists('docs/doc1.md')).toBe(false);
            expect(await storage.exists('docs/renamed.md')).toBe(true);
            expect(await storage.read('docs/renamed.md')).toBe('Content 1');

            // Directory rename
            await storage.write('sub/a.txt', 'A');
            await storage.write('sub/b.txt', 'B');
            await storage.rename('sub', 'renamed_sub');

            expect(await storage.exists('sub/a.txt')).toBe(false);
            expect(await storage.exists('renamed_sub/a.txt')).toBe(true);
            expect(await storage.exists('renamed_sub/b.txt')).toBe(true);
            expect(await storage.read('renamed_sub/a.txt')).toBe('A');
        });

        test('lists all files with accurate sizes and types', async () => {
            await storage.write('test.md', '# Markdown');
            await storage.writeBinary('photo.jpg', new Uint8Array([0xFF, 0xD8, 0xFF]).buffer);

            const files = await storage.listFiles();
            expect(files.length).toBe(2);

            const mdFile = files.find(f => f.path === 'test.md');
            const jpgFile = files.find(f => f.path === 'photo.jpg');

            expect(mdFile).toBeDefined();
            expect(mdFile?.isBinary).toBe(false);

            expect(jpgFile).toBeDefined();
            expect(jpgFile?.isBinary).toBe(true);
            expect(jpgFile?.size).toBe(3);
        });

        test('dispatches change events', async () => {
            const events: any[] = [];
            const unsubscribe = storage.onVaultChange(event => events.push(event));

            await storage.write('event.md', 'Initial');
            await storage.write('event.md', 'Modified');
            await storage.rename('event.md', 'event2.md');
            await storage.delete('event2.md');

            unsubscribe();
            await storage.write('after.md', 'Should not capture');

            expect(events.length).toBe(4);
            expect(events[0].type).toBe('create');
            expect(events[0].path).toBe('event.md');
            expect(events[1].type).toBe('modify');
            expect(events[2].type).toBe('rename');
            expect(events[2].path).toBe('event2.md');
            expect(events[2].oldPath).toBe('event.md');
            expect(events[3].type).toBe('delete');
        });
    });
}

testStorageSuite('InMemoryVaultStorage', async () => {
    const storage = new InMemoryVaultStorage();
    return {
        storage,
        cleanup: async () => storage.clear()
    };
});

testStorageSuite('NodeFsVaultStorage', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-test-'));
    const storage = new NodeFsVaultStorage(tempDir);
    return {
        storage,
        cleanup: async () => {
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
    };
});
