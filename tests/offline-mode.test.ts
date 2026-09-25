/**
 * Offline Mode (LAN WebSocket): mutual authentication without sending the token, and
 * encryption of everything after it. Runs the real DirectIpServer and DirectIpClient over
 * in-memory sockets, and two real plugin instances syncing through them.
 */
jest.mock('ws', () => require('./helpers/fake-ws').wsModule);

import { Platform } from 'obsidian';
import { createDevice, teardown, waitFor, sleep, notices, Device } from './helpers/harness';
import { wsNetwork, FakeBrowserSocket, FakeServerSocket } from './helpers/fake-ws';
import { DirectIpServer, DirectIpClient } from '../src/directip';
import { AUTH_CHALLENGE, AUTH_OK, bytesToBase64, randomNonce } from '../src/utils/direct-ip-auth';
import { FakeVault } from './helpers/fake-vault';
import { TFile } from 'obsidian';

(global as any).WebSocket = FakeBrowserSocket;

const TOKEN = '0123456789abcdef0123456789abcdef';
let nextPort = 42000;

afterEach(async () => {
    await teardown();
    for (const stop of stoppers.splice(0)) stop();
    wsNetwork.reset();
    (Platform as any).isMobile = true;
});

const stoppers: Array<() => void> = [];

/** A stand-in for the plugin: records what each side hands up to the sync layer. */
function stubPlugin(deviceId: string) {
    const received: Array<{ message: any; conn: any }> = [];
    const plugin: any = {
        settings: { deviceId },
        connections: new Map(),
        directIpServer: null,
        received,
        log: jest.fn(),
        showNotice: jest.fn(),
        updateStatus: jest.fn(),
        rejectPendingAck: jest.fn(),
        handleRawIncomingData: jest.fn(async (message: any, conn: any) => { received.push({ message, conn }); }),
    };
    return plugin;
}

async function startServer(pin = TOKEN) {
    (Platform as any).isMobile = false;
    const plugin = stubPlugin('host-device');
    const port = nextPort++;
    const server = new DirectIpServer(plugin, port, pin);
    await server.listening;
    stoppers.push(() => server.stop());
    return { server, plugin, port };
}

function startClient(port: number, pin = TOKEN, deviceId = 'joining-device', greeting?: () => any) {
    const plugin = stubPlugin(deviceId);
    const client = new DirectIpClient(plugin, { host: '127.0.0.1', port, pin }, greeting);
    stoppers.push(() => client.stop());
    return { client, plugin };
}

function wireContains(text: string): boolean {
    const needle = new TextEncoder().encode(text);
    return wsNetwork.wire.some(frame => {
        const hay = frame.bytes;
        outer: for (let i = 0; i + needle.length <= hay.length; i++) {
            for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
            return true;
        }
        return false;
    });
}

describe('authentication', () => {
    test('a device with the token joins, and messages flow both ways', async () => {
        const { server, plugin: host, port } = await startServer();
        const { client, plugin: joiner } = startClient(port);

        await waitFor(() => client.isOpen && server.hasClient('joining-device'), { what: 'the link to authenticate' });

        await client.send({ type: 'hello', text: 'from the joiner' });
        await waitFor(() => host.received.length === 1, { what: 'the host to receive' });
        expect(host.received[0].message).toEqual({ type: 'hello', text: 'from the joiner' });
        expect(host.received[0].conn.peer).toBe('joining-device');
        expect(host.received[0].conn.open).toBe(true);

        const body = new Uint8Array([0, 1, 2, 250, 251, 252]);
        server.sendTo('joining-device', { type: 'file-chunk-data', transferId: 't', index: 0, data: body });
        await waitFor(() => joiner.received.length === 1, { what: 'the joiner to receive' });
        const chunk = joiner.received[0].message;
        expect(chunk.type).toBe('file-chunk-data');
        expect(Array.from(new Uint8Array(chunk.data.buffer ?? chunk.data, chunk.data.byteOffset ?? 0, chunk.data.byteLength))).toEqual([0, 1, 2, 250, 251, 252]);
        expect(joiner.received[0].conn.peer).toBe('direct-ip-host');
    });

    test('neither the token nor the content ever crosses the network readably', async () => {
        const { server, port } = await startServer();
        const { client } = startClient(port);
        await waitFor(() => client.isOpen && server.hasClient('joining-device'), { what: 'the link to authenticate' });

        await client.send({ type: 'file-update', path: 'Diary/secret.md', content: 'MY-PRIVATE-NOTE', encoding: 'utf8' });
        server.sendTo('joining-device', { type: 'file-update', path: 'Diary/other.md', content: 'HOST-PRIVATE-NOTE', encoding: 'utf8' });
        await sleep(50);

        expect(wireContains(TOKEN)).toBe(false);
        expect(wireContains('MY-PRIVATE-NOTE')).toBe(false);
        expect(wireContains('HOST-PRIVATE-NOTE')).toBe(false);
        expect(wireContains('Diary')).toBe(false);
        expect(wsNetwork.clients[0].url).not.toContain(TOKEN);
    });

    test('a wrong token is refused, and the joining device stops retrying', async () => {
        const { server, plugin: host, port } = await startServer();
        const { client } = startClient(port, 'not-the-token');

        await waitFor(() => client.isFatalError, { what: 'the client to give up' });
        expect(client.isOpen).toBe(false);
        expect(client.fatalReason).toMatch(/rejected this device/);
        expect(server.getClients()).toEqual([]);
        expect(host.received).toEqual([]);

        await sleep(50);
        expect(wsNetwork.clients).toHaveLength(1);
    });

    test('a device running the old version is told to update', async () => {
        const { plugin: host, port } = await startServer();

        for (let i = 0; i < 2; i++) {
            const legacy = new FakeBrowserSocket(`ws://127.0.0.1:${port}/?pin=${TOKEN}&deviceId=old-device`);
            const closed = new Promise<any>(resolve => { legacy.onclose = resolve; });
            expect((await closed).code).toBe(1008);
        }
        expect(host.showNotice).toHaveBeenCalledTimes(1);
        expect(host.showNotice.mock.calls[0][0]).toMatch(/older version/);
    });

    test('a device that answers at the address without knowing the token is not trusted', async () => {
        const port = nextPort++;
        const received: string[] = [];
        wsNetwork.rawHosts.set(port, (socket: FakeServerSocket) => {
            socket.on('message', (data: Buffer, isBinary: boolean) => {
                received.push(isBinary ? '<binary>' : data.toString());
                if (!isBinary && JSON.parse(data.toString()).type === 'od-auth-proof') {
                    socket.send(JSON.stringify({ type: AUTH_OK, proof: bytesToBase64(randomNonce()) }));
                }
            });
            socket.send(JSON.stringify({ type: AUTH_CHALLENGE, v: 1, nonce: bytesToBase64(randomNonce()) }));
        });
        const { client } = startClient(port);
        client.send({ type: 'file-update', path: 'a.md', content: 'queued before the link was up', encoding: 'utf8' }).catch(() => { });

        await waitFor(() => client.isFatalError, { what: 'the client to reject the impostor' });
        expect(client.isOpen).toBe(false);
        expect(client.fatalReason).toMatch(/could not prove/);
        expect(received.filter(r => r === '<binary>')).toEqual([]);
    });

    test('frames sent before authenticating get the socket closed', async () => {
        const { server, port } = await startServer();
        const intruder = new FakeBrowserSocket(`ws://127.0.0.1:${port}/?deviceId=intruder&v=1`);
        const closed = new Promise<any>(resolve => { intruder.onclose = resolve; });
        intruder.onopen = () => intruder.send(new Uint8Array([1, 2, 3]));

        expect((await closed).code).toBe(1008);
        expect(server.getClients()).toEqual([]);
    });

    test('a device that reconnects replaces its old socket', async () => {
        const { server, port } = await startServer();
        const first = startClient(port);
        await waitFor(() => server.hasClient('joining-device'), { what: 'the first link' });
        const second = startClient(port);
        await waitFor(() => second.client.isOpen, { what: 'the second link' });

        await waitFor(() => wsNetwork.clients[0].readyState === 3, { what: 'the old socket to close' });
        expect(server.getClients()).toEqual(['joining-device']);
        first.client.stop();
    });
});

describe('delivery', () => {
    test('messages arrive in the order they were sent', async () => {
        const { server, plugin: host, port } = await startServer();
        const { client } = startClient(port);
        await waitFor(() => client.isOpen && server.hasClient('joining-device'), { what: 'the link to authenticate' });

        for (let i = 0; i < 40; i++) {
            void client.send(i % 2
                ? { type: 'file-chunk-data', transferId: 't', index: i, data: new Uint8Array(1000 * (40 - i)) }
                : { type: 'note', index: i });
        }
        await waitFor(() => host.received.length === 40, { what: 'all 40 messages' });
        expect(host.received.map(r => r.message.index)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    });

    test('the greeting goes first on every link, reconnects included', async () => {
        const { server, plugin: host, port } = await startServer();
        const { client } = startClient(port, TOKEN, 'joining-device', () => ({ type: 'handshake', n: host.received.length }));
        void client.send({ type: 'queued-while-connecting' });

        await waitFor(() => host.received.length === 2, { what: 'the first link\'s messages' });
        expect(host.received.map(r => r.message.type)).toEqual(['handshake', 'queued-while-connecting']);

        // The host drops the socket (e.g. it was reaped); the device reconnects and greets again.
        (server as any).clients.get('joining-device').socket.close(1001, 'going away');
        await waitFor(() => host.received.length === 3, { what: 'a new handshake', timeout: 6000 });
        expect(host.received[2].message.type).toBe('handshake');
    }, 10000);

    test('stopping rejects what was still waiting to be sent', async () => {
        const { port } = await startServer();
        const { client } = startClient(port);
        const sent = client.send({ type: 'x' });
        client.stop();
        await expect(sent).rejects.toThrow('Client stopped');
    });
});

describe('reconnecting', () => {
    test('repeated reconnect requests do not keep pushing the retry back', async () => {
        const port = nextPort++; // nothing listens here
        const { client } = startClient(port);
        await waitFor(() => (client as any).reconnectTimeout !== null, { what: 'a retry to be scheduled' });
        const scheduled = (client as any).reconnectTimeout;

        client.triggerReconnect();
        client.triggerReconnect();
        expect((client as any).reconnectTimeout).toBe(scheduled);

        // A network change retries promptly instead.
        client.triggerReconnect({ resetBackoff: true });
        expect((client as any).reconnectTimeout).not.toBe(scheduled);
        expect((client as any).reconnectAttempts).toBe(1);
    });

    test('an address that is not a host name fails with a message instead of throwing', () => {
        const plugin = stubPlugin('joining-device');
        let client!: DirectIpClient;
        expect(() => { client = new DirectIpClient(plugin, { host: 'not an address', port: 1, pin: TOKEN }); }).not.toThrow();
        stoppers.push(() => client.stop());
        expect(client.isFatalError).toBe(true);
        expect(client.fatalReason).toMatch(/not a valid address/);
    });

    test('IPv6 hosts are bracketed in the URL', () => {
        const plugin = stubPlugin('joining-device');
        const v6 = new DirectIpClient(plugin, { host: 'fe80::1', port: 41235, pin: TOKEN });
        stoppers.push(() => v6.stop());
        expect(wsNetwork.clients.at(-1)!.url.startsWith('ws://[fe80::1]:41235/')).toBe(true);
    });
});

describe('two plugins in Offline Mode', () => {
    const HOST = 'device-host0001';
    const JOIN = 'device-join0002';

    async function offlinePair(hostVault?: FakeVault, joinVault?: FakeVault): Promise<[Device, Device]> {
        const settings = { connectionMode: 'direct-ip' as const, directIpHostPort: nextPort++ };
        const host = await createDevice(HOST, { settings, vault: hostVault, waitForOpen: false });
        const join = await createDevice(JOIN, { settings, vault: joinVault, waitForOpen: false });
        (Platform as any).isMobile = false;
        const token = await host.plugin.startDirectIpHost();
        (Platform as any).isMobile = true;
        expect(token).toBeTruthy();
        await join.plugin.connectToDirectIpHost({ host: '127.0.0.1', port: settings.directIpHostPort, pin: token! });
        await waitFor(() => host.plugin.connections.has(JOIN) && join.plugin.clusterPeers.get('direct-ip-host')?.deviceId === HOST
            && join.plugin.connections.get('direct-ip-host')?.open === true, { what: 'the offline handshake' });
        return [host, join];
    }

    test('a note written on the joining device reaches the host, encrypted', async () => {
        const [host, join] = await offlinePair();

        await join.vault.create('Offline note.md', 'WRITTEN-WITHOUT-INTERNET');
        await waitFor(() => host.vault.text('Offline note.md') === 'WRITTEN-WITHOUT-INTERNET', { what: 'the note to reach the host' });

        const created = host.vault.getAbstractFileByPath('Offline note.md');
        expect(created).toBeInstanceOf(TFile);
        expect(wireContains('WRITTEN-WITHOUT-INTERNET')).toBe(false);
        expect(notices().some(n => /older version|rejected/.test(n))).toBe(false);
    });

    test('a note written on the host reaches the joining device', async () => {
        const [host, join] = await offlinePair();

        await host.vault.create('From host.md', 'hello from the host');
        await waitFor(() => join.vault.text('From host.md') === 'hello from the host', { what: 'the note to reach the joiner' });
    });
});
