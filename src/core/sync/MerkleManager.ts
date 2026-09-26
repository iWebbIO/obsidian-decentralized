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
    private hashCache: Map<string, { hash: string; mtime: number }> = new Map();
    private cachedTree: MerkleNode | null = null;
    private treeBuiltAt: number = 0;

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
        const files = await this.storage.listFiles();
        const tree: MerkleNode = { hash: '', children: {} };

        // 1. Resolve hashes for all files
        const fileHashes = new Map<string, string>();
        for (const file of files) {
            const cached = this.hashCache.get(file.path);
            if (cached && cached.mtime === file.mtime) {
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
                    this.hashCache.set(file.path, { hash, mtime: file.mtime });
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
        this.cachedTree = tree;
        this.treeBuiltAt = Date.now();
        return tree;
    }

    /**
     * Compare local tree against a remote tree and find differences without transmitting full file manifests.
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
            const isLocalLeaf = !local?.children || Object.keys(local.children).length === 0;
            const isRemoteLeaf = !remote?.children || Object.keys(remote.children).length === 0;

            if (local && !remote) {
                this.collectPaths(local, currentPath, result.missingRemotely);
                return;
            }

            if (!local && remote) {
                this.collectPaths(remote, currentPath, result.missingLocally);
                return;
            }

            if (local && remote) {
                if (local.hash === remote.hash && local.hash !== '') {
                    this.collectPaths(local, currentPath, result.identical);
                    return;
                }

                if (isLocalLeaf && isRemoteLeaf) {
                    if (local.hash !== remote.hash) {
                        result.changed.push(currentPath);
                    } else {
                        result.identical.push(currentPath);
                    }
                    return;
                }

                const allKeys = new Set([
                    ...Object.keys(local.children || {}),
                    ...Object.keys(remote.children || {})
                ]);

                for (const key of allKeys) {
                    const nextPath = currentPath ? `${currentPath}/${key}` : key;
                    walk(local.children?.[key], remote.children?.[key], nextPath);
                }
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
