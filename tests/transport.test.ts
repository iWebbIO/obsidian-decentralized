/**
 * Pairing, reconnection and version negotiation between real plugin instances.
 */
import { createDevice, connect, teardown, waitFor, notices, isLinked, sleep, peerjs } from './helpers/harness';
import { PROTOCOL_VERSION } from '../src/utils';

afterEach(teardown);

const A = 'device-aaaa0001';
const B = 'device-bbbb0002';

describe('Quick Pair', () => {
    test('the scanning device registers the link on its first connection, without warnings', async () => {
        const shower = await createDevice(B, { name: 'Phone' });
        const scanner = await createDevice(A, { name: 'Laptop' });

        // What the Connect screen does on each side.
        const psk = await shower.plugin.beginPairingWindow();
        scanner.plugin.settings.peerKeys[shower.id] = psk;
        const first = scanner.plugin.dialPeer(shower.id);

        // The showing device has no key when the link opens, so its first handshake is
        // plaintext and the scanner (which holds the key) must refuse it. It used to stop
        // there: the scanner never registered the link and its screen reported a failed
        // pairing, recovering only later through gossip and a redial.
        await waitFor(() => isLinked(scanner, shower) && isLinked(shower, scanner), {
            timeout: 2000,
            what: 'both sides to register the pairing',
        });
        expect(scanner.plugin.connections.get(shower.id)).toBe(first);
        expect(shower.plugin.settings.peerKeys[scanner.id]).toBe(psk);
        expect(notices().filter(n => /unencrypted/i.test(n))).toEqual([]);
    });
});

describe('interrupted uploads', () => {
    test('a file cut off by a dropped link is delivered after reconnecting', async () => {
        const settings = { chunkSize: 64 * 1024, enableTwoDeviceOptimizations: false };
        const a = await createDevice(A, { settings });
        const b = await createDevice(B, { settings });
        await connect(a, b);

        // Drop the link after the second chunk leaves.
        const conn: any = a.plugin.connections.get(b.id);
        const send = conn.send.bind(conn);
        let chunks = 0;
        conn.send = (msg: any) => {
            send(msg);
            if (msg?.type === 'file-chunk-data' && ++chunks === 2) conn.close();
        };

        const bytes = new Uint8Array(300 * 1024).map((_, i) => (i * 7 + 3) & 0xff);
        await a.vault.createBinary('big.bin', bytes.slice().buffer);

        // The drop triggers an immediate redial; once the handshake completes the upload is
        // sent again from the start. Resuming mid-file used to be attempted instead, and the
        // receiver — which had discarded the partial file when the link dropped — rejected
        // every chunk, so the file never arrived.
        await waitFor(() => chunks >= 2, { what: 'the link to drop mid-transfer' });
        await waitFor(() => b.vault.has('big.bin'), { what: 'the file to arrive after reconnecting' });
        expect(b.vault.store.get('big.bin')!.data).toEqual(bytes);
        await waitFor(() => a.plugin.activeTransfers.size === 0, { what: 'the interrupted transfer to clear' });
        expect(isLinked(a, b)).toBe(true);
    });

    test('forgetting a device drops its paused uploads', async () => {
        const a = await createDevice(A);
        a.plugin.activeTransfers.set('t1', {
            id: 't1', path: 'x.bin', direction: 'upload', peerId: B, totalChunks: 4, processedChunks: 1,
            startTime: Date.now(), lastUpdate: Date.now(), status: 'paused',
        });

        await a.plugin.forgetDevice(B);

        expect(a.plugin.activeTransfers.size).toBe(0);
    });
});

describe('protocol versions', () => {
    function handshakeFrom(version: number) {
        return { type: 'handshake' as const, peerInfo: { deviceId: B, friendlyName: 'Old Phone', ip: null }, protocolVersion: version };
    }

    test('a device on another version is refused with a single notice, and not redialled', async () => {
        const a = await createDevice(A);
        a.plugin.clusterPeers.set(B, { deviceId: B, friendlyName: 'Old Phone', ip: null });
        const { DataConnection } = peerjs();

        for (let i = 0; i < 3; i++) {
            const conn = new DataConnection(a.plugin.peer, B, {});
            conn.open = true;
            a.plugin.handleHandshake(handshakeFrom(PROTOCOL_VERSION - 1), conn);
            expect(conn.closed).toBe(true);
        }

        expect(notices().filter(n => /different version/.test(n))).toHaveLength(1);
        expect(notices().find(n => /different version/.test(n))).toMatch(/Update the plugin on Old Phone/);
        expect(a.plugin.connections.has(B)).toBe(false);

        a.plugin.tryToConnectToClusterPeers();
        await sleep(20);
        expect(a.plugin.pendingConnections.has(B)).toBe(false);
    });

    test('a newer device asks for this one to be updated', async () => {
        const a = await createDevice(A);
        const { DataConnection } = peerjs();
        const conn = new DataConnection(a.plugin.peer, B, {});
        conn.open = true;

        a.plugin.handleHandshake(handshakeFrom(PROTOCOL_VERSION + 1), conn);

        expect(notices().find(n => /different version/.test(n))).toMatch(/Update the plugin on this device/);
    });

    test('a handshake without device info is refused instead of throwing', async () => {
        const a = await createDevice(A);
        const { DataConnection } = peerjs();
        const conn = new DataConnection(a.plugin.peer, B, {});
        conn.open = true;

        expect(() => a.plugin.handleHandshake({ type: 'handshake', protocolVersion: PROTOCOL_VERSION } as any, conn)).not.toThrow();
        expect(conn.closed).toBe(true);
        expect(a.plugin.connections.has(B)).toBe(false);
    });
});
