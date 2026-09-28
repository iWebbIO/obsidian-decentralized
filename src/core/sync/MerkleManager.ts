import { MerkleNode } from '../../types';
import { IVaultStorage } from '../storage/IVaultStorage';
import * as nodeCrypto from 'crypto';

export interface MerkleDiffResult {
    missingLocally: string[];
    missingRemotely: string[];
    changed: string[];
    identical: string[];
}

export class MerkleManager {
    private hashCache: Map<string, { hash: string; mtime: number; size: number }> = new Map();
    private cachedTree: MerkleNode | null = null;
    private treeBuiltAt: number = 0;
    /**
     * Bumped by every invalidation. A tree built while the vault changed underneath it
     * must not be cached as current: a mid-build change would otherwise stay invisible
     * until the next vault event, and anti-entropy would compare against a stale tree.
     */
    private generation = 0;

    constructor(
        private storage: IVaultStorage,
        private surrogateThresholdBytes: number = 5 * 1024 * 1024
    ) {}

    /**
     * Compute SHA-256 hex digest of string or ArrayBuffer.
     * Uses crypto.subtle if available, with node:crypto fallback.
     */
    public async computeHash(data: string | ArrayBuffer): Promise<string> {
        if (typeof globalThis.crypto?.subtle?.digest === 'function') {
            const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
            const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
            const arr = new Uint8Array(digest);
            let hex = '';
            for (let i = 0; i < arr.length; i++) {
                hex += arr[i].toString(16).padStart(2, '0');
            }
            return hex;
        }

        // Node.js fallback
        const hash = nodeCrypto.createHash('sha256');
        if (typeof data === 'string') {
            hash.update(data, 'utf8');
        } else {
            hash.update(Buffer.from(data));
        }
        return hash.digest('hex');
    }

    /**
     * Invalidate the cached Merkle tree so it is rebuilt on the next query.
     */
    public invalidate() {
        this.generation++;
        this.cachedTree = null;
        this.treeBuiltAt = 0;
    }

    /**
     * Purge a specific file from the hash cache.
     */
    public invalidateFile(filePath: string) {
        this.hashCache.delete(filePath);
        this.invalidate();
    }

    /**
     * Get or build the Merkle tree for the storage vault.
     */
    public async getMerkleTree(): Promise<MerkleNode> {
        if (this.cachedTree && this.treeBuiltAt > 0) {
            return this.cachedTree;
        }
        return this.buildMerkleTree();
    }

    /**
     * Rebuild the Merkle tree from storage.
     */
    public async buildMerkleTree(): Promise<MerkleNode> {
        const generationAtStart = this.generation;
        const files = await this.storage.listFiles();
        const tree: MerkleNode = { hash: '', children: {} };

        // 1. Resolve hashes for all files
        const fileHashes = new Map<string, string>();
        for (const file of files) {
            const cached = this.hashCache.get(file.path);
            if (cached && cached.mtime === file.mtime && cached.size === file.size) {
                fileHashes.set(file.path, cached.hash);
            } else if (file.size > this.surrogateThresholdBytes) {
                // Size+mtime surrogate for large files to avoid reading huge chunks into memory
                const surrogate = `size-${file.size}-mtime-${file.mtime}`;
                fileHashes.set(file.path, surrogate);
            } else {
                try {
                    const content = file.isBinary
                        ? await this.storage.readBinary(file.path)
                        : await this.storage.read(file.path);
                    const hash = await this.computeHash(content);
                    this.hashCache.set(file.path, { hash, mtime: file.mtime, size: file.size });
                    fileHashes.set(file.path, hash);
                } catch {
                    // File vanished or deleted concurrently mid-build; skip it
                    continue;
                }
            }
        }

        // 2. Insert into tree structure
        for (const file of files) {
            const hash = fileHashes.get(file.path);
            if (!hash) continue;

            const parts = file.path.split('/');
            let current = tree;
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (!current.children) current.children = {};
                if (!current.children[part]) current.children[part] = { hash: '' };
                current = current.children[part];
                if (i === parts.length - 1) {
                    current.hash = hash;
                }
            }
        }

        // 3. Compute post-order rolling hashes
        const computeHashes = async (root: MerkleNode): Promise<string> => {
            const stack: Array<{ node: MerkleNode; phase: 'push' | 'process' }> = [
                { node: root, phase: 'push' }
            ];
            while (stack.length > 0) {
                const entry = stack.pop()!;
                if (entry.phase === 'process') {
                    const node = entry.node;
                    if (node.children && Object.keys(node.children).length > 0) {
                        const childKeys = Object.keys(node.children).sort();
                        let combined = '';
                        for (const k of childKeys) combined += node.children[k].hash;
                        node.hash = await this.computeHash(combined);
                    }
                } else {
                    stack.push({ node: entry.node, phase: 'process' });
                    if (entry.node.children) {
                        for (const child of Object.values(entry.node.children)) {
                            stack.push({ node: child, phase: 'push' });
                        }
                    }
                }
            }
            return root.hash;
        };

        await computeHashes(tree);
        // A file changed while this tree was being built (hashing awaits): use it this
        // once, but build afresh next time — caching it would hide the change until
        // some later vault event, and anti-entropy would compare against a stale tree.
        if (generationAtStart === this.generation) {
            this.cachedTree = tree;
            this.treeBuiltAt = Date.now();
        } else {
            this.cachedTree = null;
            this.treeBuiltAt = 0;
        }
        return tree;
    }

    /**
     * Compare local tree against a remote tree and find differences without transmitting full file manifests.
     *
     * Two empty trees diff as fully identical (no phantom "" entry), and a file on one
     * side facing a directory on the other is reported for both sides — the file is
     * missing remotely and the directory's contents are missing locally — instead of
     * being silently dropped from the diff.
     */
    public diffTrees(localRoot: MerkleNode, remoteRoot: MerkleNode): MerkleDiffResult {
        const result: MerkleDiffResult = {
            missingLocally: [],
            missingRemotely: [],
            changed: [],
            identical: []
        };

        if (localRoot.hash === remoteRoot.hash && localRoot.hash !== '') {
            // Whole tree matches
            this.collectPaths(localRoot, '', result.identical);
            return result;
        }

        const walk = (local: MerkleNode | undefined, remote: MerkleNode | undefined, currentPath: string) => {
            if (local && !remote) {
                this.collectPaths(local, currentPath, result.missingRemotely);
                return;
            }

            if (!local && remote) {
                this.collectPaths(remote, currentPath, result.missingLocally);
                return;
            }

            if (!local || !remote) return;

            if (local.hash === remote.hash && local.hash !== '') {
                this.collectPaths(local, currentPath, result.identical);
                return;
            }

            const isLocalLeaf = !local.children || Object.keys(local.children).length === 0;
            const isRemoteLeaf = !remote.children || Object.keys(remote.children).length === 0;

            if (isLocalLeaf && isRemoteLeaf) {
                // The vault roots ("") of two empty trees are both childless with an empty
                // hash: that is "everything matches", not an identical file at "".
                if (currentPath === '') return;
                if (local.hash !== remote.hash) {
                    result.changed.push(currentPath);
                } else {
                    result.identical.push(currentPath);
                }
                return;
            }

            // A file facing a directory: the file has no counterpart remotely (and vice
            // versa), and the directory's contents still need walking.
            if (currentPath !== '') {
                if (isLocalLeaf) result.missingRemotely.push(currentPath);
                if (isRemoteLeaf) result.missingLocally.push(currentPath);
            }

            const allKeys = new Set([
                ...Object.keys(local.children || {}),
                ...Object.keys(remote.children || {})
            ]);

            for (const key of allKeys) {
                const nextPath = currentPath ? `${currentPath}/${key}` : key;
                walk(local.children?.[key], remote.children?.[key], nextPath);
            }
        };

        walk(localRoot, remoteRoot, '');
        return result;
    }

    private collectPaths(node: MerkleNode, prefix: string, target: string[]) {
        if (!node.children || Object.keys(node.children).length === 0) {
            if (prefix) target.push(prefix);
            return;
        }
        for (const [key, child] of Object.entries(node.children)) {
            const next = prefix ? `${prefix}/${key}` : key;
            this.collectPaths(child, next, target);
        }
    }
}
