/**
 * The ignore-window and debounce machinery: what happens to a user's own change when
 * it lands inside a window the plugin armed for something else. Every test here is a
 * data-loss regression — the windows used to swallow deletes, renames and unflushed
 * edits with no record, no copy and no send.
 */
import { TFile } from 'obsidian';
import { createDevice, connect, teardown, waitFor, sleep, Device } from './helpers/harness';
import { FakeVault } from './helpers/fake-vault';

afterEach(teardown);

const A = 'device-aaaa0001';
const B = 'device-bbbb0002';
const T = 1_700_000_000_000;
/** A remote mtime far in the future: the peer's copy wins every mtime comparison. */
const FUTURE = Date.now() + 100 * 24 * 60 * 60 * 1000;

function vaultWith(files: Record<string, [string, number]>): FakeVault {
    const vault = new FakeVault();
    for (const [path, [text, mtime]] of Object.entries(files)) vault.seed(path, text, mtime);
    return vault;
}

function conflictCopies(device: Device): string[] {
    return device.vault.getFiles().map(f => f.path).filter(p => p.includes('(conflict on'));
}

async function deliver(plugin: any, payload: any, peer = A) {
    await plugin.processIncomingData(payload, { peer, open: true, send: jest.fn() });
}

describe('a user change landing inside a plugin window', () => {
    test('an unflushed edit survives a newer remote update as a conflict copy', async () => {
        // The edit sits in the debounce (no version-vector entry yet) when the peer's
        // newer copy arrives. The causal fast path used to overwrite it, and the flush
        // then matched the echo hash — the edit vanished without a trace.
        // A peer must be connected: offline edits skip the debounce and are recorded
        // immediately, which is already safe — this test is about the pending window.
        const a = await createDevice(A, { vault: vaultWith({ 'note.md': ['v1', T] }) });
        const b = await createDevice(B, { vault: vaultWith({ 'note.md': ['v1', T] }), settings: { debounceDelay: 250 } });
        await connect(a, b);
        const plugin: any = b.plugin;

        await b.vault.modify(b.vault.getAbstractFileByPath('note.md') as TFile, 'the user words', { mtime: Date.now() });
        // The update arrives before the 250 ms flush.
        await deliver(plugin, {
            type: 'file-update', path: 'note.md', content: 'newer from the peer',
            mtime: FUTURE, encoding: 'utf8', transferId: 't1',
        });
        // Let the flush run behind the lock: it must recognize the echo and not re-send.
        await sleep(400);

        expect(b.vault.text('note.md')).toBe('newer from the peer');
        // The flush genuinely ran AND took the echo branch: the remote-write record
        // was consumed by the content comparison, not left to expire. (A re-send here
        // is not observable through the queue — the reconciliation's own legitimate
        // push of the newer content rides the same send path.)
        expect((b.plugin as any).remoteEchoHashes.has('note.md')).toBe(false);
        const copies = conflictCopies(b);
        expect(copies).toHaveLength(1);
        expect(b.vault.text(copies[0])).toBe('the user words');
    });

    test('a delete right after a remote write is recorded, not swallowed', async () => {
        // The write armed a 2 s ignore marker; a user delete inside that window used to
        // be swallowed (kindless suppression), leaving no tombstone — and the next
        // reconciliation resurrected the note.
        const a = await createDevice(A, { vault: vaultWith({ 'note.md': ['from A', T] }) });
        const b = await createDevice(B, { vault: vaultWith({}) });
        await connect(a, b);
        void a;
        const plugin: any = b.plugin;

        await deliver(plugin, {
            type: 'file-update', path: 'note.md', content: 'from A',
            mtime: T, encoding: 'utf8', transferId: 't2',
        });
        await waitFor(() => b.vault.has('note.md'), { what: 'the note to arrive' });

        // Delete inside the 2 s window.
        await b.vault.delete(b.vault.getAbstractFileByPath('note.md')!);

        await waitFor(() => plugin.tombstones['note.md'] !== undefined, { what: 'the deletion to be recorded' });
        expect(b.vault.has('note.md')).toBe(false);
    });

    test('an edit right after a local rename is counted and sent', async () => {
        // The local rename path used to arm 2 s markers on both paths although it
        // never writes anything — the user's next edit inside that window was dropped.
        const [a, b] = await (async () => {
            const va = vaultWith({ 'note.md': ['x', T] });
            const vb = vaultWith({ 'note.md': ['x', T] });
            const a = await createDevice(A, { vault: va });
            const b = await createDevice(B, { vault: vb });
            await connect(a, b);
            return [a, b] as const;
        })();

        await a.vault.rename(a.vault.getAbstractFileByPath('note.md')!, 'renamed.md');
        // An edit immediately, inside what used to be the rename marker's window.
        await a.vault.modify(a.vault.getAbstractFileByPath('renamed.md') as TFile, 'the edit after the rename', { mtime: Date.now() });

        await waitFor(
            () => (a.plugin as any).twoDeviceState.fileVersions['renamed.md']?.[A] >= 1,
            { what: 'the edit to be recorded' },
        );
        await waitFor(() => b.vault.has('renamed.md'), { what: 'the rename to reach B' });
        await waitFor(() => b.vault.text('renamed.md') === 'the edit after the rename', { what: 'the post-rename edit to reach B' });
    });

    test('an edit pending under the old name travels with a rename', async () => {
        // The pending debounce re-resolved the OLD path (gone) and silently dropped;
        // the rename itself carries no content, so the edit never reached the peer.
        const [a, b] = await (async () => {
            const va = vaultWith({ 'note.md': ['v1', T] });
            const vb = vaultWith({ 'note.md': ['v1', T] });
            const a = await createDevice(A, { vault: va, settings: { debounceDelay: 250 } });
            const b = await createDevice(B, { vault: vb });
            await connect(a, b);
            return [a, b] as const;
        })();

        await a.vault.modify(a.vault.getAbstractFileByPath('note.md') as TFile, 'the pending edit', { mtime: Date.now() });
        await a.vault.rename(a.vault.getAbstractFileByPath('note.md')!, 'moved.md');
        await sleep(400);

        await waitFor(() => b.vault.has('moved.md'), { what: 'the rename to reach B' });
        await waitFor(() => b.vault.text('moved.md') === 'the pending edit', { what: 'the pending edit to travel with the rename' });
    });

    test('a user save landing between the read and the write is not clobbered', async () => {
        // The receive path decides from one read and writes later; user writes never
        // take the path lock. A save landing in between used to be overwritten, and
        // the echo match then hid that it happened.
        const b = await createDevice(B, { vault: vaultWith({ 'note.md': ['old local', T] }) });
        const plugin: any = b.plugin;
        const file = b.vault.getAbstractFileByPath('note.md') as TFile;

        // First read of the decision: the user's save lands mid-read.
        const realCachedRead = b.vault.cachedRead.bind(b.vault);
        let intercepted = false;
        const spy = jest.spyOn(b.vault as any, 'cachedRead').mockImplementation(async (f: any) => {
            if (!intercepted) {
                intercepted = true;
                await b.vault.modify(file, 'the mid-flight save', { mtime: Date.now() + 50_000 });
            }
            return realCachedRead(f);
        });

        await plugin.applyFileUpdate({
            type: 'file-update', path: 'note.md', content: 'from the peer',
            mtime: FUTURE, encoding: 'utf8', transferId: 't3',
        }, A);
        spy.mockRestore();

        // The decision re-ran against the fresh bytes: the user's newer save wins and
        // the peer's copy is answered back, not written over it.
        expect(b.vault.text('note.md')).toBe('the mid-flight save');
    });

    test('a listening direct-ip host with nobody joined is offline, not online', async () => {
        // hasPeers treated the existence of the server object as a connection, so
        // changes took the online path, parked in failedSyncs and were thrown away
        // after five retries.
        // waitForOpen: false — a direct-ip device never opens a PeerJS peer.
        const b = await createDevice(B, { settings: { connectionMode: 'direct-ip' }, waitForOpen: false });
        const plugin: any = b.plugin;
        plugin.directIpServer = { getClients: () => [] };
        expect((plugin as any).hasPeers()).toBe(false);
        plugin.directIpServer = { getClients: () => ['device-cccc0003'] };
        expect((plugin as any).hasPeers()).toBe(true);
    });
});

