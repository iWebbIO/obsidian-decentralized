import { VersionVector } from '../../types';

export type VersionRelation = 'EQUAL' | 'GREATER' | 'LESSER' | 'CONCURRENT';

export class VersionVectorManager {
    /**
     * Increment the counter for the given device ID.
     */
    public static increment(vector: VersionVector, deviceId: string): VersionVector {
        const copy: VersionVector = { ...vector };
        copy[deviceId] = (copy[deviceId] || 0) + 1;
        return copy;
    }

    /**
     * Component-wise maximum of two version vectors.
     */
    public static merge(local: VersionVector, remote: VersionVector): VersionVector {
        const merged: VersionVector = {};
        const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);
        for (const k of allKeys) {
            merged[k] = Math.max(local[k] || 0, remote[k] || 0);
        }
        return merged;
    }

    /**
     * Check if v1 strictly dominates v2 (at least one component greater, none lesser).
     */
    public static isNewerThan(v1: VersionVector, v2: VersionVector): boolean {
        let hasGreater = false;
        const keys = new Set([...Object.keys(v1), ...Object.keys(v2)]);
        for (const k of keys) {
            const val1 = v1[k] || 0;
            const val2 = v2[k] || 0;
            if (val1 < val2) return false;
            if (val1 > val2) hasGreater = true;
        }
        return hasGreater;
    }

    /**
     * Determine the causal relationship between two version vectors.
     */
    public static compare(v1: VersionVector, v2: VersionVector): VersionRelation {
        let hasGreater = false;
        let hasLesser = false;
        const keys = new Set([...Object.keys(v1), ...Object.keys(v2)]);

        for (const k of keys) {
            const val1 = v1[k] || 0;
            const val2 = v2[k] || 0;
            if (val1 > val2) hasGreater = true;
            if (val1 < val2) hasLesser = true;
        }

        if (!hasGreater && !hasLesser) return 'EQUAL';
        if (hasGreater && !hasLesser) return 'GREATER';
        if (!hasGreater && hasLesser) return 'LESSER';
        return 'CONCURRENT';
    }
}
