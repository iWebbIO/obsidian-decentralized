/**
 * What a peer may make this device do. Every peer-initiated write, move or delete must stay
 * inside THIS device's sync scope, and removals must be recoverable.
 */
import { TFile } from 'obsidian';
import { createDevice, teardown, Device } from './helpers/harness';
import { FakeVault } from './helpers/fake-vault';
import { SyncPhase } from '../src/types';

afterEach(teardown);

const A = 'device-aaaa0001';
const B = 'device-bbbb0002';

/** A connection-shaped stand-in for "the message came from device A". */
function fromA() {
    return { peer: A, open: true, send: jest.fn() } as any;
}

async function deliver(device: Device, message: any) {
    await (device.plugin as any).processIncomingData(message, fromA());
    // Handlers run detached from processIncomingData; let them finish.
    await new Promise(resolve => setTimeout(resolve, 20));
}

describe('isPathSyncable', () => {
    test('folder rules match whole folders', async () => {
        const b = await createDevice(B, { settings: { syncMode: 'manual', excludedFolders: 'Work\nArchive/', includedFolders: '' } });
        expect(b.plugin.isPathSyncable('Work/plan.md')).toBe(false);
        expect(b.plugin.isPathSyncable('Archive/old.md')).toBe(false);
        expect(b.plugin.isPathSyncable('Workshop/plan.md')).toBe(true);
        expect(b.plugin.isPathSyncable('Work notes.md')).toBe(true);
    });

    test('hidden paths and the config folder never sync as notes', async () => {
        const b = await createDevice(B);
        expect(b.plugin.isPathSyncable('.git/hooks/pre-commit')).toBe(false);
        expect(b.plugin.isPathSyncable('.obsidian/snippets/x.css')).toBe(false);
        expect(b.plugin.isPathSyncable('notes/.hidden/x.md')).toBe(false);
        expect(b.plugin.isPathSyncable('notes/v1.2/x.md')).toBe(true);
    });

    test('a renamed config folder is recognised', async () => {
        const vault = new FakeVault();
        vault.configDir = 'config';
        const b = await createDevice(B, { vault });
        expect(b.plugin.isPathSyncable('config/plugins/x/main.js')).toBe(false);
        expect(b.plugin.isPathSyncable('configs/notes.md')).toBe(true);
    });
});

describe('peer renames', () => {
    test('cannot move a synced note into plugin code', async () => {
        const vault = new FakeVault();
        vault.seed('note.md', 'console.log("owned")');
        const b = await createDevice(B, { vault });
        vault.ensureHiddenFolder('.obsidian/plugins/evil');

        await deliver(b, { type: 'file-rename', oldPath: 'note.md', newPath: '.obsidian/plugins/evil/main.js', transferId: 't' });

        expect(vault.text('note.md')).toBe('console.log("owned")');
        expect(vault.has('.obsidian/plugins/evil/main.js')).toBe(false);
    });

    test('cannot pull an excluded note into a synced folder', async () => {
        const vault = new FakeVault();
        vault.seed('Private/secret.md', 'mine');
        const b = await createDevice(B, { vault, settings: { syncMode: 'manual', excludedFolders: 'Private' } });

        await deliver(b, { type: 'file-rename', oldPath: 'Private/secret.md', newPath: 'Shared/secret.md', transferId: 't' });

        expect(vault.text('Private/secret.md')).toBe('mine');
        expect(vault.has('Shared/secret.md')).toBe(false);
    });

    test('a folder rename carries only what this device syncs', async () => {
        const vault = new FakeVault();
        vault.seed('Projects/a.md', 'a');
        vault.seed('Projects/Private/p.md', 'local only');
        const b = await createDevice(B, { vault, settings: { syncMode: 'manual', excludedFolders: 'Projects/Private' } });

        await deliver(b, { type: 'folder-rename', oldPath: 'Projects', newPath: 'Work', transferId: 't' });

        expect(vault.text('Work/a.md')).toBe('a');
        // The excluded subfolder stays where it was instead of landing in a synced location.
        expect(vault.text('Projects/Private/p.md')).toBe('local only');
        expect(vault.has('Work/Private/p.md')).toBe(false);
    });

    test('a rename of a file this device never had asks for the file', async () => {
        const b = await createDevice(B);
        const conn = fromA();
        await (b.plugin as any).processIncomingData({ type: 'file-rename', oldPath: 'old.md', newPath: 'new.md', transferId: 't' }, conn);
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(conn.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'request-file', path: 'new.md' }));
    });
});

describe('peer deletions', () => {
    test('go to the trash', async () => {
        const vault = new FakeVault();
        vault.seed('note.md', 'bye');
        const b = await createDevice(B, { vault, settings: { enableTwoDeviceOptimizations: false } });

        await deliver(b, { type: 'file-delete', path: 'note.md', transferId: 't' });

        expect(vault.has('note.md')).toBe(false);
        expect(vault.trashed).toContain('note.md');
    });

    test('a file-delete naming a folder does not delete the folder', async () => {
        const vault = new FakeVault();
        vault.seed('Projects/a.md', 'a');
        const b = await createDevice(B, { vault });

        await deliver(b, { type: 'file-delete', path: 'Projects', transferId: 't' });

        expect(vault.text('Projects/a.md')).toBe('a');
    });

    test('a folder delete keeps content this device does not sync', async () => {
        const vault = new FakeVault();
        vault.seed('Projects/a.md', 'a');
        vault.seed('Projects/Private/p.md', 'local only');
        const b = await createDevice(B, { vault, settings: { syncMode: 'manual', excludedFolders: 'Projects/Private' } });

        await deliver(b, { type: 'folder-delete', path: 'Projects', transferId: 't' });

        expect(vault.has('Projects/a.md')).toBe(false);
        expect(vault.text('Projects/Private/p.md')).toBe('local only');
        // The removed file is tombstoned so a third device cannot bring it back.
        expect(b.plugin.tombstones['Projects/a.md']).toBeDefined();
    });

    test('a folder with nothing to protect is removed whole', async () => {
        const vault = new FakeVault();
        vault.seed('Old/a.md', 'a');
        vault.seed('Old/Sub/b.md', 'b');
        const b = await createDevice(B, { vault });

        await deliver(b, { type: 'folder-delete', path: 'Old', transferId: 't' });

        expect(vault.has('Old')).toBe(false);
        expect(vault.trashed).toContain('Old');
    });
});

describe('sync-plan deletions', () => {
    async function initiatorAwaitingPlan(vault: FakeVault, advertised: Record<string, number>, settings = {}) {
        const b = await createDevice(B, { vault, settings });
        const plugin: any = b.plugin;
        plugin.syncState.isSyncing = true;
        plugin.syncState.peerId = A;
        plugin.syncState.currentPhase = SyncPhase.REQUESTING;
        plugin.sentManifestMtimes = new Map(Object.entries(advertised));
        return b;
    }

    function plan(filesInitiatorMustDelete: string[]) {
        return {
            type: 'sync-plan', filesReceiverWillSend: [], filesInitiatorMustSend: [],
            filesReceiverMustDelete: [], filesInitiatorMustDelete, fileSizes: {},
        };
    }

    test('only delete advertised, unchanged files inside the scope', async () => {
        const vault = new FakeVault();
        vault.seed('gone.md', 'x', 1000);
        vault.seed('edited.md', 'y', 1000);
        vault.seed('never-sent.md', 'z', 1000);
        vault.seed('Projects/a.md', 'a', 1000);
        vault.seed('Private/p.md', 'p', 1000);
        const b = await initiatorAwaitingPlan(
            vault,
            { 'gone.md': 1000, 'edited.md': 1000, 'Private/p.md': 1000 },
            { syncMode: 'manual', excludedFolders: 'Private' },
        );
        // Edited after the manifest went out.
        const edited = vault.getAbstractFileByPath('edited.md') as TFile;
        await vault.modify(edited, 'y2', { mtime: 2000 });

        await b.plugin.handleSyncPlan(plan(['gone.md', 'edited.md', 'never-sent.md', 'Projects', 'Private/p.md']) as any, fromA());

        expect(vault.has('gone.md')).toBe(false);
        expect(vault.text('edited.md')).toBe('y2');
        expect(vault.text('never-sent.md')).toBe('z');
        expect(vault.text('Projects/a.md')).toBe('a');
        expect(vault.text('Private/p.md')).toBe('p');
    });
});

describe('Merkle traversal', () => {
    async function withTree(vault: FakeVault) {
        const b = await createDevice(B, { vault });
        await (b.plugin as any).buildMerkleTree();
        const sent: any[] = [];
        jest.spyOn(b.plugin, 'sendData').mockImplementation((_peer: string, msg: any) => { sent.push(msg); });
        return { b, sent };
    }

    test('a folder missing here is compared against nothing, not its parent', async () => {
        const vault = new FakeVault();
        vault.seed('root.md', 'r');
        const { b, sent } = await withTree(vault);

        await (b.plugin as any).handleMerkleNodeResponse(
            { type: 'merkle-node-response', path: 'missing/sub', children: { 'x.md': 'h1' }, folders: [] }, fromA());

        expect(sent).toEqual([{ type: 'request-file', path: 'missing/sub/x.md' }]);
    });

    test('folders are recognised by the peer\'s folder list, not by dots in names', async () => {
        const vault = new FakeVault();
        const { b, sent } = await withTree(vault);

        await (b.plugin as any).handleMerkleNodeResponse(
            { type: 'merkle-node-response', path: '', children: { 'v1.2': 'h1', 'README': 'h2' }, folders: ['v1.2'] }, fromA());

        expect(sent).toContainEqual({ type: 'merkle-node-request', path: 'v1.2' });
        expect(sent).toContainEqual({ type: 'request-file', path: 'README' });
    });

    test('node responses list which children are folders', async () => {
        const vault = new FakeVault();
        vault.seed('Notes/a.md', 'a');
        vault.seed('top.md', 't');
        const { b, sent } = await withTree(vault);

        await (b.plugin as any).handleMerkleNodeRequest({ type: 'merkle-node-request', path: '' }, fromA());

        expect(sent[0].folders).toEqual(['Notes']);
        expect(Object.keys(sent[0].children).sort()).toEqual(['Notes', 'top.md']);
    });
});
