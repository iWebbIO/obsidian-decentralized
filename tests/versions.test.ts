import { compareVectors, mergeVectors, unseenEdits, newerVersion, pickVersion, hasOwnUnseenEdit, sanitizeVersionVector, VersionInfo } from '../src/utils/versions';

describe('compareVectors', () => {
    test('orders vectors by what each includes', () => {
        expect(compareVectors({ a: 2, b: 1 }, { a: 1, b: 1 })).toBe('after');
        expect(compareVectors({ a: 1 }, { a: 1, b: 1 })).toBe('before');
        expect(compareVectors({ a: 2 }, { a: 1, b: 1 })).toBe('concurrent');
        expect(compareVectors({ a: 1 }, { a: 1 })).toBe('equal');
        expect(compareVectors({}, undefined)).toBe('equal');
        expect(compareVectors({ a: 0 }, {})).toBe('equal');
    });
});

test('mergeVectors keeps the highest count per device', () => {
    expect(mergeVectors({ a: 2, b: 1 }, { b: 3, c: 1 })).toEqual({ a: 2, b: 3, c: 1 });
    expect(mergeVectors(undefined, { a: 1 })).toEqual({ a: 1 });
});

test('unseenEdits lists devices whose edits the other has not seen', () => {
    expect(unseenEdits({ c: 2, a: 1, b: 1 }, { a: 1, b: 2 })).toEqual(['c']);
    expect(unseenEdits({ b: 1, a: 3 }, { a: 1 })).toEqual(['a', 'b']);
});

describe('newerVersion', () => {
    const v = (mtime: number, vv: Record<string, number>, extra: Partial<VersionInfo> = {}): VersionInfo => ({ mtime, vv, ...extra });

    test('the more recent change wins', () => {
        expect(newerVersion(v(20, { a: 1 }), v(10, { b: 1 }))).toBe('a');
        expect(newerVersion(v(10, { a: 1 }), v(20, { b: 1 }))).toBe('b');
    });

    test('an exact tie goes to the edit from the lower device ID, whoever holds it', () => {
        // Device c holds a's edit and receives b's: it must pick what a and b pick.
        const fromA = v(10, { a: 1 }, { deviceId: 'c' });
        const fromB = v(10, { b: 1 }, { deviceId: 'b' });
        expect(newerVersion(fromA, fromB)).toBe('a');
        expect(newerVersion(fromB, fromA)).toBe('b');
    });

    test('with nothing recorded, ties fall back to the hash, then the device ID', () => {
        expect(newerVersion(v(10, {}, { hash: 'x2' }), v(10, {}, { hash: 'x1' }))).toBe('b');
        expect(newerVersion(v(10, {}, { deviceId: 'b' }), v(10, {}, { deviceId: 'a' }))).toBe('b');
    });

    test('is symmetric', () => {
        const cases: Array<[VersionInfo, VersionInfo]> = [
            [v(5, { a: 1 }), v(5, { b: 2 })],
            [v(5, { a: 1, c: 1 }), v(5, { b: 1, c: 1 })],
            [v(5, {}, { hash: 'h1', deviceId: 'z' }), v(5, {}, { hash: 'h2', deviceId: 'y' })],
            [v(7, { a: 1 }), v(5, { b: 1 })],
        ];
        for (const [x, y] of cases) {
            expect(newerVersion(x, y)).not.toBe(newerVersion(y, x));
        }
    });
});

describe('pickVersion', () => {
    test('a version made with the other in hand wins, whatever the clocks say', () => {
        // b received a's edit (a:1) and edited it on a device whose clock runs behind.
        expect(pickVersion({ mtime: 100, vv: { a: 1 } }, { mtime: 50, vv: { a: 1, b: 1 } })).toBe('b');
    });

    test('independent changes go to the more recent one', () => {
        expect(pickVersion({ mtime: 100, vv: { a: 1 } }, { mtime: 50, vv: { b: 1 } })).toBe('a');
    });
});

test('hasOwnUnseenEdit', () => {
    expect(hasOwnUnseenEdit({ me: 2 }, { me: 1, x: 5 }, 'me')).toBe(true);
    expect(hasOwnUnseenEdit({ me: 1, x: 1 }, { me: 1 }, 'me')).toBe(false);
    expect(hasOwnUnseenEdit({}, {}, 'me')).toBe(false);
});

test('sanitizeVersionVector keeps only well-formed counts', () => {
    expect(sanitizeVersionVector({ a: 1, b: -1, c: 1.5, d: 'x', e: NaN, ['x'.repeat(200)]: 2 })).toEqual({ a: 1 });
    expect(sanitizeVersionVector([1, 2])).toBeUndefined();
    expect(sanitizeVersionVector('a')).toBeUndefined();
    expect(sanitizeVersionVector({ z: 0 })).toEqual({ z: 0 });
});
