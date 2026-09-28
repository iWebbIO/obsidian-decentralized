import DiffMatchPatch from 'diff-match-patch';
import { DeviceRole } from '../../types';

export type ConflictStrategy = 'role-based' | 'last-write-wins' | 'create-conflict-file' | 'three-way-merge';

export interface ConflictResolutionOutcome {
    action: 'keep-local' | 'adopt-remote' | 'create-conflict-file' | 'write-merged';
    contentToSave?: string | ArrayBuffer;
    conflictFilePath?: string;
    conflictFileContent?: string | ArrayBuffer;
}

export interface ConflictResolutionInput {
    strategy: ConflictStrategy;
    filePath: string;
    localContent: string | ArrayBuffer;
    localMtime: number;
    remoteContent: string | ArrayBuffer;
    remoteMtime: number;
    remoteDeviceId: string;
    myRole: DeviceRole;
    localDeviceId?: string;
    /**
     * The last content both versions are known to share, when the caller tracks it.
     * Only with a common ancestor can a real three-way merge be attempted; without
     * it "merge" would just be adopting one side.
     */
    baseContent?: string;
}

export class ConflictResolver {
    private dmp = new DiffMatchPatch();

    constructor(public readonly mtimeToleranceMs: number = 2000) {}

    /**
     * Compute a conflict path for a file.
     * E.g. "path/note.md" -> "path/note.conflict-node2-1698765432.md"
     */
    public getConflictPath(originalPath: string, peerId: string, timestamp: number = Date.now()): string {
        const lastDot = originalPath.lastIndexOf('.');
        const sanitizedPeer = peerId.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 16);
        if (lastDot === -1 || lastDot === 0) {
            return `${originalPath}.conflict-${sanitizedPeer}-${timestamp}`;
        }
        const base = originalPath.substring(0, lastDot);
        const ext = originalPath.substring(lastDot);
        return `${base}.conflict-${sanitizedPeer}-${timestamp}${ext}`;
    }

    /**
     * Compare text or binary contents for exact equality.
     */
    public areContentsEqual(a: string | ArrayBuffer, b: string | ArrayBuffer): boolean {
        if (typeof a === 'string' && typeof b === 'string') {
            return a === b;
        }
        if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
            if (a.byteLength !== b.byteLength) return false;
            const ua = new Uint8Array(a);
            const ub = new Uint8Array(b);
            for (let i = 0; i < ua.length; i++) {
                if (ua[i] !== ub[i]) return false;
            }
            return true;
        }
        return false;
    }

    /**
     * Attempt a 3-way patch merge on text content using DiffMatchPatch.
     */
    public mergePatches(baseOrLocalText: string, patchText: string): { mergedText: string; success: boolean } {
        try {
            const patches = this.dmp.patch_fromText(patchText);
            const [mergedText, results] = this.dmp.patch_apply(patches, baseOrLocalText);
            const success = results.every((r: boolean) => r === true);
            return { mergedText, success };
        } catch {
            return { mergedText: baseOrLocalText, success: false };
        }
    }

    /**
     * Create diff-match-patch patches from base text to updated text.
     */
    public createPatch(baseText: string, updatedText: string): string {
        const patches = this.dmp.patch_make(baseText, updatedText);
        return this.dmp.patch_toText(patches);
    }

    /**
     * A real three-way merge: replay the remote side's changes (base -> remote) on top of
     * the local version. Both edits land when they touch different regions; edits that
     * overlap enough for patch application to fail report success: false and the caller
     * must fall back to a conflict copy — a "merged" result must never silently be one
     * side's content.
     */
    public mergeThreeWay(base: string, local: string, remote: string): { mergedText: string; success: boolean } {
        const patch = this.createPatch(base, remote);
        return this.mergePatches(local, patch);
    }

    /**
     * Resolve a conflict according to the selected strategy.
     *
     * mtimes from two devices are never compared at finer resolution than
     * mtimeToleranceMs: inside the window they are a tie (clocks skew), decided
     * deterministically by device ID so both ends pick the same winner.
     */
    public resolve({
        strategy,
        filePath,
        localContent,
        localMtime,
        remoteContent,
        remoteMtime,
        remoteDeviceId,
        myRole,
        localDeviceId,
        baseContent
    }: ConflictResolutionInput): ConflictResolutionOutcome {
        if (this.areContentsEqual(localContent, remoteContent)) {
            return { action: 'keep-local' };
        }

        const mtimesAreTied = Math.abs(remoteMtime - localMtime) <= this.mtimeToleranceMs;
        const remoteIsNewer = mtimesAreTied
            ? (remoteDeviceId > (localDeviceId ?? ''))
            : remoteMtime > localMtime;

        switch (strategy) {
            case 'role-based':
                if (myRole === 'primary') {
                    return { action: 'keep-local' };
                } else {
                    return { action: 'adopt-remote', contentToSave: remoteContent };
                }

            case 'last-write-wins':
                if (remoteIsNewer) {
                    return { action: 'adopt-remote', contentToSave: remoteContent };
                } else {
                    return { action: 'keep-local' };
                }

            case 'three-way-merge':
                if (typeof localContent === 'string' && typeof remoteContent === 'string'
                    && typeof baseContent === 'string') {
                    const { mergedText, success } = this.mergeThreeWay(baseContent, localContent, remoteContent);
                    if (success) {
                        return { action: 'write-merged', contentToSave: mergedText };
                    }
                }
                // No common ancestor (or the edits overlap, or the content is binary):
                // a merge is not possible, so keep both versions like any other conflict.
                // The copy holds the LOSING side: filling it with the remote content
                // when the remote also won the primary path dropped the local edit
                // entirely — the exact loss the copy exists to prevent.
                return {
                    action: 'create-conflict-file',
                    conflictFilePath: this.getConflictPath(filePath, remoteDeviceId, remoteMtime),
                    conflictFileContent: remoteIsNewer ? localContent : remoteContent,
                    contentToSave: remoteIsNewer ? remoteContent : undefined
                };

            case 'create-conflict-file':
            default:
                return {
                    action: 'create-conflict-file',
                    conflictFilePath: this.getConflictPath(filePath, remoteDeviceId, remoteMtime),
                    conflictFileContent: remoteIsNewer ? localContent : remoteContent,
                    contentToSave: remoteIsNewer ? remoteContent : undefined
                };
        }
    }
}
