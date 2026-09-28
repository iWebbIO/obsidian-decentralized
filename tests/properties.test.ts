/**
 * Property tests: at-scale invariants of the primitives every device runs identically.
 *
 * Hand-picked cases in the unit suites show WHAT the rules do; these pin that the rules
 * HOLD over thousands of adversarial inputs, with a fixed seed so a failure reproduces
 * from its seed alone.
 *
 *   pickVersion/newerVersion — the convergence rule: every device must pick the same
 *     winner from the same two versions, so the decision can only read the versions'
 *     own fields, and swapping the arguments must swap the answer (anti-symmetry)
 *     unless the two versions are indistinguishable in every field.
 *   sanitizeVaultPath — whatever a peer sends, the result either stays inside the
 *     vault or is refused; and sanitizing is stable.
 *   packFrame/unpackFrame, packFilesToTLV/unpackTLVToFiles — round-trip fidelity and
 *     the truncation contract: a cut buffer is ALWAYS an error, never silent garbage.
 */
import {
    compareVectors, mergeVectors, unseenEdits, pickVersion, sanitizeVersionVector, VersionInfo,
} from '../src/utils/versions';
import { VersionVector, SyncError } from '../src/types';
import {
    sanitizeVaultPath, packFrame, unpackFrame, packFilesToTLV, unpackTLVToFiles, PackedFile,
} from '../src/utils';

/** mulberry32: small, fast, deterministic — failures reproduce from the seed. */
function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const rnd = prng(0xC0FFEE);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
const randInt = (max: number) => Math.floor(rnd() * max);
const randBytes = (maxLen: number) => {
    const out = new Uint8Array(randInt(maxLen + 1));
    for (let i = 0; i < out.length; i++) out[i] = randInt(256);
    return out;
};
const randHex = (len: number) => Array.from({ length: len }, () => '0123456789abcdef'[randInt(16)]).join('');
const sameBytes = (a: Uint8Array | ArrayBuffer, b: Uint8Array | ArrayBuffer) =>
    new Uint8Array(a).length === new Uint8Array(b).length
    && new Uint8Array(a).every((v, i) => v === new Uint8Array(b)[i]);

// --- generators ------------------------------------------------------------

const MTIMES = [0, 1, 5, 5, 5, 10, 1000, 1.7e12, -1];
const DEVICES = ['a', 'b', 'c', 'd', 'device-0001', 'zz', 'n'];
const HASHES = [undefined, undefined, 'x1', 'x2', randHex(64), randHex(64)];
const DEVICE_IDS = [undefined, undefined, 'a', 'b', 'device-0001', 'zz'];

function randVector(): VersionVector {
    const vv: VersionVector = {};
    const n = randInt(4);
    for (let i = 0; i < n; i++) vv[pick(DEVICES)] = randInt(6);
    return vv;
}

function randVersionInfo(): VersionInfo {
    return {
        mtime: pick(MTIMES),
        vv: randVector(),
        hash: pick(HASHES),
        deviceId: pick(DEVICE_IDS),
    };
}

/**
 * Two versions no field can tell apart — the one case where both orderings may return
 * 'a' (picking either is correct because they are the same version for all the rule
 * can know). Every other input pair MUST decide anti-symmetrically.
 */
function indistinguishable(a: VersionInfo, b: VersionInfo): boolean {
    return a.mtime === b.mtime
        && unseenEdits(a.vv, b.vv).length === 0
        && unseenEdits(b.vv, a.vv).length === 0
        && !(a.hash && b.hash && a.hash !== b.hash)
        && !(a.deviceId && b.deviceId && a.deviceId !== b.deviceId);
}

// --- sweep 44: the convergence rule -----------------------------------------

describe('property: pickVersion decides identically on every device', () => {
    const N = 2000;

    test('anti-symmetric: swapping the arguments swaps the winner (unless the versions are indistinguishable)', () => {
        let decided = 0;
        let tied = 0;
        for (let i = 0; i < N; i++) {
            const a = randVersionInfo();
            const b = randVersionInfo();
            const ab = pickVersion(a, b);
            const ba = pickVersion(b, a);
            if (indistinguishable(a, b)) {
                // Nothing distinguishes them: both orderings fall through every
                // tiebreak and return 'a'. Picking "either" is picking the same thing.
                expect(ab).toBe('a');
                expect(ba).toBe('a');
                tied++;
            } else {
                expect(ab === 'a' ? 'b' : 'a').toBe(ba);
                decided++;
            }
        }
        // The fuzz must actually reach both branches, or it pins nothing.
        expect(decided).toBeGreaterThan(N / 2);
        expect(tied).toBeGreaterThan(0);
    });

    test('deterministic: the same inputs always decide the same way', () => {
        for (let i = 0; i < 500; i++) {
            const a = randVersionInfo();
            const b = randVersionInfo();
            expect(pickVersion(a, b)).toBe(pickVersion(a, b));
            expect(pickVersion(a, b)).toBe(pickVersion({ ...a }, { ...b, vv: { ...b.vv } }));
        }
    });

    test('vector merge is commutative, idempotent and dominates both inputs', () => {
        const canon = (v: VersionVector) => JSON.stringify(Object.entries(v).sort(([x], [y]) => x < y ? -1 : 1));
        for (let i = 0; i < 1000; i++) {
            const a = randVector();
            const b = randVector();
            const m1 = mergeVectors(a, b);
            const m2 = mergeVectors(b, a);
            expect(canon(m1)).toBe(canon(m2));               // commutative
            expect(canon(mergeVectors(m1, a))).toBe(canon(m1));  // idempotent
            // The merged vector includes everything either input had: it is 'after'
            // (or equal to) each of them, and no input keeps an edit the merge lacks.
            expect(['after', 'equal']).toContain(compareVectors(m1, a));
            expect(['after', 'equal']).toContain(compareVectors(m1, b));
            expect(unseenEdits(a, m1)).toEqual([]);
            expect(unseenEdits(b, m1)).toEqual([]);
        }
    });

    test('sanitizeVersionVector drops __proto__ entries and never pollutes Object.prototype', () => {
        // A peer-controlled key reached `clean[device] = value`; for '__proto__' that
        // is the prototype setter, not an own property — harmless only because the
        // validated value is a number. The sanitizer now drops the key outright.
        const crafted = JSON.parse('{"__proto__": {"polluted": true}, "real": 2}');
        const clean = sanitizeVersionVector(crafted);
        expect(clean).toEqual({ real: 2 });
        expect(({} as any).polluted).toBeUndefined();
        expect(({} as any).real).toBeUndefined();
    });
});

// --- sweep 45: the path sanitizer --------------------------------------------

const PATH_CHARS = ['a', 'B', '3', '-', '_', '.', '/', '\\', ' ', ':', '\0', '..', 'é', '文', 'n', 'C'];

describe('property: sanitizeVaultPath contains the result or refuses it', () => {
    const N = 3000;

    test('every accepted path is vault-relative, traversal-free and idempotent', () => {
        let accepted = 0;
        for (let i = 0; i < N; i++) {
            const len = randInt(30);
            let raw = '';
            for (let j = 0; j < len; j++) raw += pick(PATH_CHARS);
            const safe = sanitizeVaultPath(raw);
            if (safe === null) continue;
            accepted++;

            // Vault-relative: no absolute prefix, no drive letter, no UNC.
            expect(safe.startsWith('/')).toBe(false);
            expect(/^[a-zA-Z]:/.test(safe)).toBe(false);
            // No separators of the other OS, no NUL.
            expect(safe.includes('\\')).toBe(false);
            expect(safe.includes('\0')).toBe(false);
            // No traversal and no empty/dot segments survive.
            for (const seg of safe.split('/')) {
                expect(seg === '..' || seg === '.' || seg === '').toBe(false);
                // Windows strips trailing dots and spaces: the sanitized form must
                // not contain a segment that would address a different file there.
                expect(seg).toBe(seg.replace(/[. ]+$/, ''));
            }
            expect(safe.length).toBeLessThanOrEqual(1024);
            // Stable: sanitizing the sanitized form changes nothing.
            expect(sanitizeVaultPath(safe)).toBe(safe);
        }
        expect(accepted).toBeGreaterThan(N / 10);   // the fuzz must accept plenty
    });
});

// --- sweep 46: the wire framing ----------------------------------------------

describe('property: frames and TLV batches round-trip or fail loudly', () => {
    const TYPES = ['file-chunk-data', 'file-batch-binary', 'encrypted-frame', 'sync-control-binary', 'file-update', 'config-file', 'note'];

    test('packFrame/unpackFrame round-trip arbitrary headers and bodies, including empty', () => {
        for (let i = 0; i < 1000; i++) {
            const header = { type: pick(TYPES), n: randInt(100), text: pick(['ok', '', 'ünïcode ✓', '文檔']), nested: { deep: rnd() } };
            const body = rnd() < 0.15 ? null : randBytes(300);
            // packFrame allocates its own exact buffer, so .buffer needs no copy.
            const { header: h, body: b } = unpackFrame(packFrame(header, body).buffer);
            expect(h).toEqual(header);
            // A zero-length body is carried by the __emptyBody marker and comes back
            // as no body at all — same as a null one.
            if (body === null || body.byteLength === 0) {
                expect(b).toBeNull();
            } else {
                expect(b).not.toBeNull();
                expect(sameBytes(b!, body)).toBe(true);
            }
        }
    });

    test('a cut in the header region is always a protocol error; a cut in the body returns a shorter body', () => {
        const header = { type: 'file-chunk-data', path: 'x.md' };
        const body = randBytes(64);
        const frame = packFrame(header, body);
        const headerLen = frame.length - 4 - body.byteLength;

        // Cuts through the length prefix or the header bytes cannot be told apart
        // from a corrupt frame: refused, never best-effort parsed.
        for (let cut = 0; cut < 4 + headerLen; cut++) {
            expect(() => unpackFrame(frame.buffer.slice(0, cut) as ArrayBuffer)).toThrow(SyncError);
        }
        // A cut inside the body is the format's honest case: the frame carries no
        // body-length field, so the caller's integrity layer (AES-GCM for encrypted
        // frames, the chunk protocol for chunks) is what catches it. What unpackFrame
        // MUST do is return exactly the bytes that remain — no padding, no slack.
        for (let cut = 4 + headerLen; cut <= frame.length; cut++) {
            const { header: h, body: b } = unpackFrame(frame.buffer.slice(0, cut) as ArrayBuffer);
            expect(h).toEqual(header);
            const remaining = cut - 4 - headerLen;
            // A cut exactly at the body boundary leaves no body at all (null, the
            // same shape a zero-byte body takes); anything more is exactly what's left.
            if (remaining === 0) {
                expect(b).toBeNull();
            } else {
                expect(b).not.toBeNull();
                expect(b!.byteLength).toBe(remaining);
            }
        }
        // A forged header length is refused the same way.
        const forged = new Uint8Array(frame);
        new DataView(forged.buffer).setUint32(0, 0xFFFFFFF, true);
        expect(() => unpackFrame(forged.buffer)).toThrow(SyncError);
    });

    test('packFilesToTLV/unpackTLVToFiles round-trip arbitrary batches, including empty files', () => {
        for (let i = 0; i < 300; i++) {
            const n = randInt(8);
            const files: PackedFile[] = [];
            for (let j = 0; j < n; j++) {
                files.push({
                    path: pick(['a.md', '文件夹/文档.md', 'deep/nested/x.bin', 'no-ext']),
                    mtime: pick([0, 1.7e12, -1, 1e15, 0.5]),
                    isCompressed: rnd() < 0.5,
                    encoding: pick(['utf8', 'binary', 'base64'] as const),
                    content: randBytes(600),
                });
            }
            const back = unpackTLVToFiles(packFilesToTLV(files));
            expect(back).toHaveLength(files.length);
            for (let j = 0; j < files.length; j++) {
                expect(back[j].path).toBe(files[j].path);
                expect(back[j].mtime).toBe(files[j].mtime);
                expect(back[j].isCompressed).toBe(files[j].isCompressed);
                expect(back[j].encoding).toBe(files[j].encoding);
                expect(sameBytes(back[j].content, files[j].content)).toBe(true);
            }
        }
    });

    test('a truncated TLV batch throws, or yields an exact prefix of the original files', () => {
        const files: PackedFile[] = [
            { path: 'a.md', mtime: 1, isCompressed: false, encoding: 'utf8', content: randBytes(300) },
            { path: 'b/c.bin', mtime: 2, isCompressed: true, encoding: 'binary', content: randBytes(300) },
            { path: 'd.md', mtime: 3, isCompressed: false, encoding: 'base64', content: randBytes(300) },
        ];
        const packed = packFilesToTLV(files);
        let threw = 0;
        let prefixes = 0;
        for (let cut = 0; cut < packed.byteLength; cut++) {
            let back: PackedFile[];
            try {
                back = unpackTLVToFiles(packed.slice(0, cut));
            } catch (e) {
                // A cut through a file's length or content must be a protocol error,
                // never a half-invented entry.
                expect(e).toBeInstanceOf(SyncError);
                threw++;
                continue;
            }
            // A cut that happens to land exactly on a file boundary is a legal
            // shorter batch: every returned file must be an INTACT prefix of the
            // originals — same fields, same bytes.
            expect(back.length).toBeLessThanOrEqual(files.length);
            for (let k = 0; k < back.length; k++) {
                expect(back[k].path).toBe(files[k].path);
                expect(back[k].mtime).toBe(files[k].mtime);
                expect(back[k].isCompressed).toBe(files[k].isCompressed);
                expect(back[k].encoding).toBe(files[k].encoding);
                expect(sameBytes(back[k].content, files[k].content)).toBe(true);
            }
            prefixes++;
        }
        expect(threw).toBeGreaterThan(0);
        expect(prefixes).toBeGreaterThan(0);
    });
});
