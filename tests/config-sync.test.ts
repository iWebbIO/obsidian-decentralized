/**
 * Obsidian settings sync between two real plugin instances: what is shared in each mode, the
 * newest-wins rule (deletions included), and what a device refuses to take or give.
 */
import { createDevice, connect, teardown, waitFor, sleep, notices, partition, heal, Device } from './helpers/harness';
import { FakeVault } from './helpers/fake-vault';
import { isConfigPathInScope, ConfigSync } from '../src/core/ConfigSync';
import { compressBytes } from '../src/utils';

afterEach(teardown);

const A = 'device-aaaa0001';
const B = 'device-bbbb0002';
const T = 1_700_000_000_000;
const OWN = 'plugins/obsidian-decentralized';
const FULL = { syncMode: 'manual' as const, syncObsidianConfig: true };

function vaultWith(files: Record<string, [string, number]>): FakeVault {
    const vault = new FakeVault();
    for (const [path, [text, mtime]] of Object.entries(files)) vault.seed(`.obsidian/${path}`, text, mtime);
    return vault;
}

function config(device: Device, rel: string): string | null {
    return device.vault.text(`.obsidian/${rel}`);
}

async function quiet(...devices: Device[]) {
    await waitFor(() => devices.every(d => d.plugin.queueManager.getQueueSize() === 0 && d.plugin.queueManager.getActiveTransfers() === 0),
        { what: 'queues to drain' });
    await sleep(100);
}

describe('isConfigPathInScope', () => {
    test('appearance covers the look only', () => {
        for (const rel of ['appearance.json', 'snippets/wide.css', 'themes/Minimal/theme.css', 'themes/Minimal/manifest.json']) {
            expect(isConfigPathInScope(rel, 'appearance', OWN)).toBe(true);
        }
        for (const rel of ['app.json', 'hotkeys.json', 'plugins/dataview/main.js', 'snippets/notes.txt', 'themes/Minimal/extra.js']) {
            expect(isConfigPathInScope(rel, 'appearance', OWN)).toBe(false);
        }
    });

    test('full adds settings and other plugins, never the layout or this plugin', () => {
        for (const rel of ['app.json', 'hotkeys.json', 'community-plugins.json', 'plugins/dataview/main.js', 'plugins/dataview/data.json']) {
            expect(isConfigPathInScope(rel, 'full', OWN)).toBe(true);
        }
        for (const rel of ['workspace.json', 'workspace-mobile.json', `${OWN}/data.json`, `${OWN}/main.js`, 'plugins/dataview/node_modules/x.js', 'cache/x.json']) {
            expect(isConfigPathInScope(rel, 'full', OWN)).toBe(false);
        }
    });

    test('rejects anything that could leave the config folder', () => {
        for (const rel of ['../notes.md', 'snippets/../../x.css', '/app.json', 'snippets\\a.css', 'snippets/.hidden.css', '', 'plugins/./x/main.js']) {
            expect(isConfigPathInScope(rel, 'full', OWN)).toBe(false);
        }
        expect(isConfigPathInScope('app.json', 'off', OWN)).toBe(false);
    });
});

describe('Automatic mode: the look', () => {
    test('theme, snippets and appearance settings reach the other device, and nothing else', async () => {
        const a = await createDevice(A, {
            vault: vaultWith({
                'snippets/wide.css': ['.x { width: 100% }', T + 10],
                'appearance.json': ['{"theme":"obsidian"}', T + 10],
                'themes/Minimal/theme.css': ['body {}', T + 10],
                'themes/Minimal/manifest.json': ['{"name":"Minimal"}', T + 10],
                'app.json': ['{"vimMode":true}', T + 10],
                'plugins/dataview/data.json': ['{"token":"secret"}', T + 10],
            }),
        });
        const b = await createDevice(B);
        await connect(a, b);

        await waitFor(() => config(b, 'themes/Minimal/manifest.json') !== null && config(b, 'snippets/wide.css') !== null
            && config(b, 'appearance.json') !== null && config(b, 'themes/Minimal/theme.css') !== null, { what: 'the look to arrive' });
        await quiet(a, b);

        expect(config(b, 'snippets/wide.css')).toBe('.x { width: 100% }');
        expect(config(b, 'appearance.json')).toBe('{"theme":"obsidian"}');
        expect(config(b, 'themes/Minimal/theme.css')).toBe('body {}');
        // Arrives with the time it was last changed, so both devices compare the same times.
        expect((await b.vault.adapter.stat('.obsidian/snippets/wide.css'))!.mtime).toBe(T + 10);
        expect(config(b, 'app.json')).toBeNull();
        expect(config(b, 'plugins/dataview/data.json')).toBeNull();
        await waitFor(() => notices().some(n => /Obsidian settings from .* were copied/.test(n)), { what: 'the reload notice' });
        expect(notices().filter(n => /Obsidian settings from/.test(n))).toHaveLength(1);
    });

    test('a change made later is sent once, and not sent back', async () => {
        const a = await createDevice(A, { vault: vaultWith({ 'snippets/wide.css': ['v1', T] }) });
        const b = await createDevice(B, { vault: vaultWith({ 'snippets/wide.css': ['v1', T] }) });
        await connect(a, b);
        await quiet(a, b);

        a.vault.seed('.obsidian/snippets/wide.css', 'v2', T + 1_000);
        await a.plugin.configSync.scan();
        await waitFor(() => config(b, 'snippets/wide.css') === 'v2', { what: 'the change to arrive' });
        await quiet(a, b);

        const sent = jest.spyOn(b.plugin, 'sendData');
        await b.plugin.configSync.scan();
        await quiet(a, b);
        expect(sent.mock.calls.filter(([, msg]) => (msg as any).type === 'config-file')).toEqual([]);
    });

    test('the newer version wins on both devices', async () => {
        const a = await createDevice(A, { vault: vaultWith({ 'appearance.json': ['{"from":"A"}', T + 10] }) });
        const b = await createDevice(B, { vault: vaultWith({ 'appearance.json': ['{"from":"B"}', T + 20] }) });
        await connect(a, b);
        await waitFor(() => config(a, 'appearance.json') === '{"from":"B"}', { what: 'B\'s newer settings to win' });
        await quiet(a, b);
        expect(config(b, 'appearance.json')).toBe('{"from":"B"}');
    });

    test('a deleted snippet goes to the trash on the other device', async () => {
        const a = await createDevice(A, { vault: vaultWith({ 'snippets/old.css': ['x', T] }) });
        const b = await createDevice(B, { vault: vaultWith({ 'snippets/old.css': ['x', T] }) });
        await connect(a, b);
        await quiet(a, b);

        await a.vault.adapter.remove('.obsidian/snippets/old.css');
        await a.plugin.configSync.scan();
        await waitFor(() => config(b, 'snippets/old.css') === null, { what: 'the deletion to arrive' });
        expect(b.vault.trashed).toContain('.obsidian/snippets/old.css');
    });

    test('a snippet edited after it was deleted elsewhere comes back', async () => {
        const a = await createDevice(A, { vault: vaultWith({ 'snippets/x.css': ['v1', T] }) });
        const b = await createDevice(B, { vault: vaultWith({ 'snippets/x.css': ['v1', T] }) });
        await connect(a, b);
        await quiet(a, b);
        await partition(a, b);

        await a.vault.adapter.remove('.obsidian/snippets/x.css');
        await a.plugin.configSync.scan();
        b.vault.seed('.obsidian/snippets/x.css', 'edited after the deletion', Date.now() + 60_000);
        await b.plugin.configSync.scan();

        heal(a, b);
        await connect(a, b);
        await waitFor(() => config(a, 'snippets/x.css') === 'edited after the deletion', { what: 'the edit to win' });
        await quiet(a, b);
        expect(config(b, 'snippets/x.css')).toBe('edited after the deletion');
    });
});

describe('manual mode with Obsidian settings on', () => {
    const everything = {
        'hotkeys.json': ['{"k":1}', T + 10],
        'workspace.json': ['{"layout":"A"}', T + 10],
        'plugins/dataview/main.js': ['module.exports = {}', T + 10],
        'plugins/dataview/data.json': ['{"x":1}', T + 10],
        'plugins/obsidian-decentralized/data.json': ['{"deviceId":"A"}', T + 10],
    } as Record<string, [string, number]>;

    test('settings and other plugins reach a paired device; the layout and this plugin do not', async () => {
        const a = await createDevice(A, { vault: vaultWith(everything), settings: FULL });
        const b = await createDevice(B, { vault: vaultWith({ 'plugins/obsidian-decentralized/data.json': ['{"deviceId":"B"}', T] }), settings: FULL });
        await connect(a, b, { encrypted: true });

        await waitFor(() => config(b, 'plugins/dataview/data.json') !== null && config(b, 'plugins/dataview/main.js') !== null
            && config(b, 'hotkeys.json') !== null, { what: 'settings to arrive' });
        await quiet(a, b);

        expect(config(b, 'plugins/dataview/main.js')).toBe('module.exports = {}');
        expect(config(b, 'hotkeys.json')).toBe('{"k":1}');
        expect(config(b, 'workspace.json')).toBeNull();
        expect(config(b, 'plugins/obsidian-decentralized/data.json')).toBe('{"deviceId":"B"}');
    });

    test('a device without a pairing key gets the look but not plugins or settings', async () => {
        const a = await createDevice(A, { vault: vaultWith({ ...everything, 'snippets/s.css': ['css', T + 10] }), settings: FULL });
        const b = await createDevice(B, { settings: FULL });
        await connect(a, b);

        await waitFor(() => config(b, 'snippets/s.css') === 'css', { what: 'the look to arrive' });
        await quiet(a, b);
        expect(config(b, 'plugins/dataview/main.js')).toBeNull();
        expect(config(b, 'plugins/dataview/data.json')).toBeNull();
        expect(config(b, 'hotkeys.json')).toBeNull();
    });

    test('with the option off, nothing in the config folder is shared', async () => {
        const off = { syncMode: 'manual' as const, syncObsidianConfig: false };
        const a = await createDevice(A, { vault: vaultWith({ 'snippets/s.css': ['css', T] }), settings: off });
        const b = await createDevice(B, { settings: off });
        await connect(a, b, { encrypted: true });
        await sleep(200);
        await quiet(a, b);
        expect(config(b, 'snippets/s.css')).toBeNull();
    });
});

describe('what a device refuses', () => {
    async function withPairedPeer() {
        const b = await createDevice(B, { settings: FULL });
        b.plugin.settings.peerKeys[A] = 'k';
        const sent = jest.spyOn(b.plugin, 'sendData');
        return { b, sync: b.plugin.configSync as ConfigSync, sent };
    }

    async function fileMessage(configPath: string, text: string, hashOf = text) {
        const bytes = new TextEncoder().encode(text);
        const hash = await (globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashOf)))
            .then(d => Array.from(new Uint8Array(d)).map(x => x.toString(16).padStart(2, '0')).join(''));
        return { type: 'config-file' as const, configPath, mtime: T, hash, data: compressBytes(bytes) };
    }

    test('files outside the config scope, its own settings, or with a wrong hash', async () => {
        const { b, sync } = await withPairedPeer();
        b.vault.seed(`.obsidian/${OWN}/data.json`, 'mine', T);

        await sync.handleFile(await fileMessage('../escape.md', 'x'), A);
        await sync.handleFile(await fileMessage(`${OWN}/data.json`, 'theirs'), A);
        await sync.handleFile(await fileMessage('workspace.json', '{}'), A);
        await sync.handleFile(await fileMessage('hotkeys.json', 'tampered', 'original'), A);

        expect(b.vault.has('escape.md')).toBe(false);
        expect(config(b, `${OWN}/data.json`)).toBe('mine');
        expect(config(b, 'workspace.json')).toBeNull();
        expect(config(b, 'hotkeys.json')).toBeNull();
    });

    test('requests for what it does not share', async () => {
        const { b, sync, sent } = await withPairedPeer();
        b.vault.seed(`.obsidian/${OWN}/data.json`, 'keys', T);
        b.vault.seed('.obsidian/workspace.json', '{}', T);
        await sync.scan();

        await sync.handleRequest({ type: 'config-request', configPaths: [`${OWN}/data.json`, 'workspace.json', '../x'] }, A);
        expect(sent.mock.calls.filter(([, m]) => (m as any).type === 'config-file')).toEqual([]);
    });

    test('plugin files from a device without a pairing key', async () => {
        const b = await createDevice(B, { settings: FULL });
        await b.plugin.configSync.handleFile(await fileMessage('plugins/evil/main.js', 'steal()'), A);
        expect(config(b, 'plugins/evil/main.js')).toBeNull();
    });

    test('a file it cannot check is not taken for deleted', async () => {
        const { b, sync, sent } = await withPairedPeer();
        b.vault.seed('.obsidian/snippets/a.css', 'x', T);
        await sync.scan();
        jest.spyOn(b.vault.adapter, 'stat').mockRejectedValue(new Error('EIO'));
        await sync.scan();
        expect(sync.state.baseline['snippets/a.css']).toBeDefined();
        expect(sent.mock.calls.filter(([, m]) => (m as any).type === 'config-delete')).toEqual([]);
    });

    test('a folder it cannot read is not taken for deleted files', async () => {
        const { b, sync, sent } = await withPairedPeer();
        b.vault.seed('.obsidian/snippets/a.css', 'x', T);
        await sync.scan();
        jest.spyOn(b.vault.adapter, 'list').mockRejectedValue(new Error('EIO'));
        await sync.scan();
        expect(sync.state.baseline['snippets/a.css']).toBeDefined();
        expect(sent.mock.calls.filter(([, m]) => (m as any).type === 'config-delete')).toEqual([]);
    });
});
