/**
 * Regressions for defects found in the 3.0 audit. Each test names the behaviour that broke
 * and why it mattered, so a future change that reintroduces it fails here rather than in a
 * user's vault.
 *
 * These all exercise pure functions, which is why they need no Obsidian mock — the same
 * reason QueueManager.test.ts can test queue behaviour directly.
 */
import {
    sanitizeVaultPath,
    taskQueueId,
    compressText,
    decompressText,
    splitBinaryPayload,
    joinBinaryPayload,
    packFrame,
    unpackFrame,
    packFilesToTLV,
    unpackTLVToFiles,
    toExactArrayBuffer,
    PackedFile,
} from '../src/utils';
import { QueueManager } from '../src/core/QueueManager';
import { TimeoutManager } from '../src/utils/Timeouts';
import { SyncTask } from '../src/types';

describe('sanitizeVaultPath', () => {
    it('accepts ordinary vault paths unchanged', () => {
        expect(sanitizeVaultPath('note.md')).toBe('note.md');
        expect(sanitizeVaultPath('Folder/Sub/note.md')).toBe('Folder/Sub/note.md');
        expect(sanitizeVaultPath('.obsidian/snippets/x.css')).toBe('.obsidian/snippets/x.css');
    });

    it('rejects traversal out of the vault', () => {
        expect(sanitizeVaultPath('../evil.md')).toBeNull();
        expect(sanitizeVaultPath('a/../../evil.md')).toBeNull();
        expect(sanitizeVaultPath('a/b/..')).toBeNull();
    });

    it('rejects absolute paths and drive letters', () => {
        expect(sanitizeVaultPath('/etc/passwd')).toBeNull();
        expect(sanitizeVaultPath('C:/Windows/system.ini')).toBeNull();
        expect(sanitizeVaultPath('//server/share/x')).toBeNull();
    });

    it('normalises "./" so it cannot slip past a prefix filter', () => {
        // The exclusion and .obsidian checks are startsWith() comparisons, so
        // './.obsidian/plugins/x' failed the '.obsidian/' test while still resolving into
        // the config folder — which is plugin code, i.e. arbitrary execution on restart.
        expect(sanitizeVaultPath('./.obsidian/plugins/x/main.js')).toBe('.obsidian/plugins/x/main.js');
        expect(sanitizeVaultPath('./Private/secrets.md')).toBe('Private/secrets.md');
        expect(sanitizeVaultPath('a//b/./c.md')).toBe('a/b/c.md');
    });

    it('rejects NUL bytes and non-strings', () => {
        expect(sanitizeVaultPath('a\0b.md')).toBeNull();
        expect(sanitizeVaultPath('')).toBeNull();
        expect(sanitizeVaultPath(undefined)).toBeNull();
        expect(sanitizeVaultPath(42)).toBeNull();
    });

    it('treats backslashes as separators rather than filename characters', () => {
        expect(sanitizeVaultPath('a\\b.md')).toBe('a/b.md');
        expect(sanitizeVaultPath('..\\evil.md')).toBeNull();
    });

    it('rejects trailing dots and spaces that Windows would strip', () => {
        // 'note.md ' and 'note.md' address the same file on Windows but compare unequal,
        // which would let a filtered path through under a slightly different spelling.
        expect(sanitizeVaultPath('note.md ')).toBeNull();
        expect(sanitizeVaultPath('folder./note.md')).toBeNull();
    });
});

describe('taskQueueId', () => {
    const batch = (paths: string[]): SyncTask => ({ taskType: 'send-file-batch', paths, batchId: 'b1' });

    it('gives each flush of one batch a distinct id', () => {
        // handleRequestBatch flushes a batch in several chunks that all carry the same
        // batchId. Keying on batchId alone made every flush after the first a duplicate,
        // and QueueManager drops duplicates silently — so those files were never sent and
        // the batch never completed, hanging the sync for the full 300 s timeout.
        const first = taskQueueId('peer', batch(['a.md', 'b.md']));
        const second = taskQueueId('peer', batch(['c.md', 'd.md']));
        expect(first).not.toBe(second);
    });

    it('still coalesces a genuinely identical re-queue', () => {
        expect(taskQueueId('peer', batch(['a.md']))).toBe(taskQueueId('peer', batch(['a.md'])));
    });

    it('separates tasks by peer, type and path', () => {
        const send: SyncTask = { taskType: 'send-file', path: 'a.md', mtime: 1, forceFull: false };
        expect(taskQueueId('p1', send)).not.toBe(taskQueueId('p2', send));
        expect(taskQueueId(null, send)).toBe(taskQueueId(null, send));
        expect(taskQueueId('p1', send)).not.toBe(
            taskQueueId('p1', { taskType: 'send-delete', path: 'a.md' })
        );
    });

    it('keeps a pull retried in a later batch apart from the earlier batch', () => {
        const pull = (batchId: string): SyncTask => ({ taskType: 'send-file', path: 'a.md', mtime: 1, forceFull: true, batchId });
        expect(taskQueueId('p', pull('b1'))).not.toBe(taskQueueId('p', pull('b2')));
    });

    it('never merges a conflict reply into a plain send', () => {
        // The reply carries the vector from before the conflict; merged into a plain send it
        // went out with the merged vector and the other device lost its edit without a copy.
        const plain: SyncTask = { taskType: 'send-file', path: 'a.md', mtime: 1, forceFull: true };
        const reply: SyncTask = { ...plain, versionVector: { a: 1 } };
        expect(taskQueueId('p', plain)).not.toBe(taskQueueId('p', reply));
    });

    it('distinguishes renames that share one endpoint', () => {
        const a: SyncTask = { taskType: 'send-rename', oldPath: 'x.md', newPath: 'y.md' };
        const b: SyncTask = { taskType: 'send-rename', oldPath: 'x.md', newPath: 'z.md' };
        expect(taskQueueId('p', a)).not.toBe(taskQueueId('p', b));
    });
});

describe('QueueManager retry path', () => {
    it('retries an item whose processor reports failure', async () => {
        // The processor swallows its own errors, so the callback always returned true and
        // scheduleRetry was unreachable: item.retries never left 0 and a transient failure
        // silently lost the file.
        jest.useFakeTimers();
        const timeouts = new TimeoutManager();
        let attempts = 0;
        const qm = new QueueManager(timeouts, async () => {
            attempts++;
            return false;
        });

        qm.addToQueue({ id: 'x', peerId: null, retries: 0, priority: 1 });
        await Promise.resolve();
        expect(attempts).toBe(1);

        // Three retries at the fixed 5 s delay, then it stops.
        for (let i = 0; i < 5; i++) {
            await jest.advanceTimersByTimeAsync(5000);
        }
        expect(attempts).toBe(4);

        timeouts.clearAll();
        jest.useRealTimers();
    });

    it('does not retry an item that reports success', async () => {
        jest.useFakeTimers();
        const timeouts = new TimeoutManager();
        let attempts = 0;
        const qm = new QueueManager(timeouts, async () => {
            attempts++;
            return true;
        });

        qm.addToQueue({ id: 'y', peerId: null, retries: 0, priority: 1 });
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(20000);
        expect(attempts).toBe(1);

        timeouts.clearAll();
        jest.useRealTimers();
    });
});

describe('decompressText output cap', () => {
    it('round-trips normal content', () => {
        const text = 'hello '.repeat(1000);
        expect(decompressText(compressText(text))).toBe(text);
    });

    it('refuses a payload that expands past the limit', () => {
        // DEFLATE reaches roughly 1000:1, so an uncapped inflate let a few megabytes from a
        // peer expand to gigabytes. This frame is reachable before any authentication.
        const bomb = compressText('\0'.repeat(2 * 1024 * 1024));
        expect(() => decompressText(bomb, 1024)).toThrow(/Decompression failed/);
    });
});

describe('empty binary bodies', () => {
    it('round-trips a 0-byte file through the frame format', () => {
        // A zero-length body is indistinguishable from "no body" once framed, so the
        // receiver got content: undefined and threw on createBinary(path, undefined).
        const msg = {
            type: 'file-update',
            path: 'empty.bin',
            encoding: 'binary',
            mtime: 1,
            transferId: 't1',
            content: new ArrayBuffer(0),
        };

        const { header, body } = splitBinaryPayload(msg);
        const framed = packFrame(header, body);
        const unpacked = unpackFrame(framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength));
        const rebuilt = joinBinaryPayload(unpacked.header, unpacked.body);

        expect(rebuilt.content).toBeInstanceOf(ArrayBuffer);
        expect(rebuilt.content.byteLength).toBe(0);
        expect(rebuilt.__emptyBody).toBeUndefined();
    });

    it('materialises file-update content even though the frame body is a view', () => {
        // unpackFrame hands back a zero-copy view into the decoded frame. applyFileUpdate
        // branches on `content instanceof ArrayBuffer` and passes content straight to the
        // vault's binary writers, so this one field must still arrive as a real
        // ArrayBuffer — a view here would make every binary update take the text path.
        const bytes = new Uint8Array([7, 8, 9]);
        const msg = {
            type: 'file-update',
            path: 'x.bin',
            encoding: 'binary',
            mtime: 1,
            transferId: 't3',
            content: bytes.buffer,
        };

        const { header, body } = splitBinaryPayload(msg);
        const framed = packFrame(header, body);
        const unpacked = unpackFrame(framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength));
        expect(unpacked.body).toBeInstanceOf(Uint8Array);

        const rebuilt = joinBinaryPayload(unpacked.header, unpacked.body);
        expect(rebuilt.content).toBeInstanceOf(ArrayBuffer);
        expect(new Uint8Array(rebuilt.content)).toEqual(bytes);
    });

    it('passes bulk bodies through as views rather than copying them', () => {
        // file-chunk-data is the hot path: one of these per 512 KB of every large file.
        // Its consumer reads raw bytes, so it must not be re-materialised.
        const payload = new Uint8Array([1, 2, 3, 4, 5]);
        const { header, body } = splitBinaryPayload({
            type: 'file-chunk-data', transferId: 't', index: 0, data: payload.buffer,
        });
        const framed = packFrame(header, body);
        const unpacked = unpackFrame(framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength));
        const rebuilt = joinBinaryPayload(unpacked.header, unpacked.body);

        expect(rebuilt.data).toBeInstanceOf(Uint8Array);
        expect(new Uint8Array(rebuilt.data)).toEqual(payload);
    });

    it('still round-trips a non-empty binary body', () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const msg = {
            type: 'file-update',
            path: 'x.bin',
            encoding: 'binary',
            mtime: 1,
            transferId: 't2',
            content: bytes.buffer,
        };

        const { header, body } = splitBinaryPayload(msg);
        const framed = packFrame(header, body);
        const unpacked = unpackFrame(framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength));
        const rebuilt = joinBinaryPayload(unpacked.header, unpacked.body);

        expect(new Uint8Array(rebuilt.content)).toEqual(bytes);
    });
});

describe('TLV unpacking from a view', () => {
    const encoder = new TextEncoder();
    const files: PackedFile[] = [
        { path: 'a/one.md', mtime: 111, isCompressed: true, encoding: 'utf8', content: encoder.encode('first') },
        { path: 'two.png', mtime: 222, isCompressed: false, encoding: 'binary', content: new Uint8Array([9, 8, 7, 6]) },
    ];

    const expectRoundTrip = (unpacked: PackedFile[]) => {
        expect(unpacked.length).toBe(2);
        expect(unpacked[0].path).toBe('a/one.md');
        expect(unpacked[0].isCompressed).toBe(true);
        expect(new Uint8Array(unpacked[0].content)).toEqual(new Uint8Array(files[0].content));
        expect(unpacked[1].path).toBe('two.png');
        expect(unpacked[1].encoding).toBe('binary');
        expect(new Uint8Array(unpacked[1].content)).toEqual(new Uint8Array(files[1].content));
    };

    it('parses a batch given as a bare ArrayBuffer', () => {
        expectRoundTrip(unpackTLVToFiles(packFilesToTLV(files)));
    });

    it('parses a batch given as a view at a non-zero byte offset', () => {
        // The batch body arrives as a view into a larger decoded frame, so its bytes start
        // partway into the underlying buffer. Reading through a DataView built on the raw
        // buffer instead of the view would parse the wrong bytes entirely.
        const packed = new Uint8Array(packFilesToTLV(files));
        const framed = new Uint8Array(packed.byteLength + 17);
        framed.set(packed, 17);
        const view = framed.subarray(17);

        expect(view.byteOffset).toBe(17);
        expectRoundTrip(unpackTLVToFiles(view));
    });

    it('bounds-checks against the view, not its backing buffer', () => {
        // A truncated batch must be refused even when the underlying buffer has spare
        // bytes after it that a naive length check would happily read into.
        const packed = new Uint8Array(packFilesToTLV(files));
        const backing = new Uint8Array(packed.byteLength + 64);
        backing.set(packed, 0);
        const truncated = backing.subarray(0, packed.byteLength - 3);

        expect(() => unpackTLVToFiles(truncated)).toThrow(/TLV/);
    });
});

describe('toExactArrayBuffer', () => {
    it('returns the backing buffer untouched when the view already spans it', () => {
        const bytes = new Uint8Array([1, 2, 3]);
        expect(toExactArrayBuffer(bytes)).toBe(bytes.buffer);
    });

    it('copies out only the view when it is a window into a larger buffer', () => {
        const backing = new Uint8Array([0, 0, 1, 2, 3, 0]);
        const window = backing.subarray(2, 5);
        const out = toExactArrayBuffer(window);

        expect(out.byteLength).toBe(3);
        expect(new Uint8Array(out)).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('passes an ArrayBuffer straight through', () => {
        const buf = new ArrayBuffer(4);
        expect(toExactArrayBuffer(buf)).toBe(buf);
    });
});

describe('decompressText accepts a view', () => {
    it('inflates a view without needing it copied out first', () => {
        const text = 'sync '.repeat(500);
        const compressed = new Uint8Array(compressText(text));
        const backing = new Uint8Array(compressed.byteLength + 8);
        backing.set(compressed, 8);

        expect(decompressText(backing.subarray(8))).toBe(text);
    });
});

describe('folder rules', () => {
    const { parseFolderList, isWithinFolders, hasHiddenSegment } = require('../src/utils');

    it('parses the spellings people type', () => {
        expect(parseFolderList('Archive/\n/Journal\n./Work\r\n  Deep\\Nested  \n\n../escape')).toEqual([
            'Archive', 'Journal', 'Work', 'Deep/Nested',
        ]);
        expect(parseFolderList('')).toEqual([]);
        expect(parseFolderList(undefined)).toEqual([]);
    });

    it('matches whole folders, not name prefixes', () => {
        // startsWith('Work') used to exclude Workshop/ and "Work notes.md" too.
        const folders = ['Work', 'Journal/Daily'];
        expect(isWithinFolders('Work', folders)).toBe(true);
        expect(isWithinFolders('Work/plan.md', folders)).toBe(true);
        expect(isWithinFolders('Workshop/plan.md', folders)).toBe(false);
        expect(isWithinFolders('Work notes.md', folders)).toBe(false);
        expect(isWithinFolders('Journal/Daily/2026-01-01.md', folders)).toBe(true);
        expect(isWithinFolders('Journal/Dailies/x.md', folders)).toBe(false);
    });

    it('spots hidden segments anywhere in a path', () => {
        expect(hasHiddenSegment('.git/hooks/pre-commit')).toBe(true);
        expect(hasHiddenSegment('notes/.trash/x.md')).toBe(true);
        expect(hasHiddenSegment('notes/v1.2/x.md')).toBe(false);
    });
});
