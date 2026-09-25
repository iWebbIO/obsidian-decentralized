/**
 * Deciding between two versions of a file, identically on every device.
 *
 * A version vector counts, per device, the edits a version includes. When one version's
 * vector includes everything in the other's, that version was made with the other already in
 * hand, so it wins however the two devices' clocks compare. When neither includes the other
 * (both changed while apart), or no record tells them apart, the more recent change wins.
 *
 * Every device holding either version must pick the same one, or the devices would each keep
 * their own. So nothing here depends on which device is asking: the inputs are the two
 * versions' vectors, times and hashes, which every device sees the same.
 */
import type { VersionVector } from '../types';

export type VectorOrder =
    /** Identical counts: no record distinguishes the versions. */
    | 'equal'
    /** The first includes every edit of the second, and more. */
    | 'after'
    /** The second includes every edit of the first, and more. */
    | 'before'
    /** Each has edits the other lacks: changed independently. */
    | 'concurrent';

export function compareVectors(a: VersionVector = {}, b: VersionVector = {}): VectorOrder {
    let aAhead = false;
    let bAhead = false;
    for (const device of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const x = a[device] || 0;
        const y = b[device] || 0;
        if (x > y) aAhead = true;
        else if (y > x) bAhead = true;
    }
    if (aAhead && bAhead) return 'concurrent';
    if (aAhead) return 'after';
    if (bAhead) return 'before';
    return 'equal';
}

/**
 * A peer's vector reduced to well-formed entries: device IDs of sane length with
 * non-negative integer counts. Anything else is dropped (undefined when nothing remains).
 */
export function sanitizeVersionVector(raw: unknown): VersionVector | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const clean: VersionVector = {};
    let count = 0;
    for (const [device, value] of Object.entries(raw as Record<string, unknown>)) {
        if (++count > 1000) break;
        if (!device || device.length > 128) continue;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) continue;
        clean[device] = value;
    }
    return Object.keys(clean).length ? clean : undefined;
}

export function mergeVectors(a: VersionVector = {}, b: VersionVector = {}): VersionVector {
    const merged: VersionVector = {};
    for (const device of new Set([...Object.keys(a), ...Object.keys(b)])) {
        merged[device] = Math.max(a[device] || 0, b[device] || 0);
    }
    return merged;
}

/** Devices with an edit counted in `a` that `b` has not seen, lowest ID first. */
export function unseenEdits(a: VersionVector = {}, b: VersionVector = {}): string[] {
    return Object.keys(a).filter(device => (a[device] || 0) > (b[device] || 0)).sort();
}

export interface VersionInfo {
    /** When the version was last changed (a deletion: when it was deleted). */
    mtime: number;
    vv?: VersionVector;
    /** Content hash, when known. */
    hash?: string;
    /** Device holding this version — the last resort for breaking a tie. */
    deviceId?: string | null;
}

/**
 * Which of two versions wins when their vectors do not order them: the more recent change.
 * An exact tie goes to the version carrying an edit from the lowest device ID that the other
 * lacks — for two devices that is simply the lower device ID — then to the smaller content
 * hash, then to the device with the lower ID. Symmetric: swapping the arguments swaps the
 * answer, so the devices on both ends agree.
 */
export function newerVersion(a: VersionInfo, b: VersionInfo): 'a' | 'b' {
    if (a.mtime !== b.mtime) return a.mtime > b.mtime ? 'a' : 'b';

    const aOnly = unseenEdits(a.vv, b.vv);
    const bOnly = unseenEdits(b.vv, a.vv);
    if (aOnly.length && bOnly.length) return aOnly[0] < bOnly[0] ? 'a' : 'b';
    if (aOnly.length !== bOnly.length) return aOnly.length ? 'a' : 'b';

    if (a.hash && b.hash && a.hash !== b.hash) return a.hash < b.hash ? 'a' : 'b';
    if (a.deviceId && b.deviceId && a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? 'a' : 'b';
    return 'a';
}

/**
 * The winner between two versions: the vectors decide when they can, the more recent change
 * otherwise.
 */
export function pickVersion(a: VersionInfo, b: VersionInfo): 'a' | 'b' {
    const order = compareVectors(a.vv, b.vv);
    if (order === 'after') return 'a';
    if (order === 'before') return 'b';
    return newerVersion(a, b);
}

/**
 * True when `mine` includes an edit made on `deviceId` that `theirs` has not seen — i.e.
 * replacing `mine` with `theirs` would drop work done on this device.
 */
export function hasOwnUnseenEdit(mine: VersionVector = {}, theirs: VersionVector = {}, deviceId: string): boolean {
    return (mine[deviceId] || 0) > (theirs[deviceId] || 0);
}
