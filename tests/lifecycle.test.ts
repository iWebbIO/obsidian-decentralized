/**
 * PeerJS lifecycle and unload hygiene, run against the real plugin class.
 *
 * The fake PeerJS reproduces PeerJS 1.5.5's destroy() ordering: 'disconnected' fires while
 * `destroyed` is still false. The plugin used to answer that event with reconnect(), which
 * reopened a signalling socket that destroy() never closed, so the device ID stayed taken
 * and the next Peer failed with unavailable-id until Obsidian restarted.
 */
import { createDevice, connect, teardown, waitFor, sleep, network, isLinked } from './helpers/harness';

afterEach(teardown);

function activeTimers(): number {
    return (process as any).getActiveResourcesInfo().filter((r: string) => r === 'Timeout').length;
}

describe('PeerJS lifecycle', () => {
    test('unloading releases the device ID on the signalling server', async () => {
        const a = await createDevice('device-aaaa0001');
        const peer: any = a.plugin.peer;

        a.plugin.unload();

        expect(peer.reconnectCalls).toBe(0);
        expect(peer.holdsId).toBe(false);
        expect(network().peers.has('device-aaaa0001')).toBe(false);

        // The same vault enabled again must be able to claim its ID straight away.
        const again = await createDevice('device-aaaa0001');
        expect(again.plugin.peer?.open).toBe(true);
    });

    test('re-initialising the connection manager does not orphan the old socket', async () => {
        const a = await createDevice('device-aaaa0001');
        const oldPeer: any = a.plugin.peer;

        a.plugin.reinitializeConnectionManager();
        await waitFor(() => !!a.plugin.peer?.open && a.plugin.peer !== oldPeer, { what: 'the replacement peer to open' });

        expect(oldPeer.destroyed).toBe(true);
        expect(oldPeer.reconnectCalls).toBe(0);
        expect(oldPeer.holdsId).toBe(false);
        expect((a.plugin.peer as any).holdsId).toBe(true);
    });

    test('an unloaded plugin never re-creates its peer', async () => {
        const a = await createDevice('device-aaaa0001');
        const b = await createDevice('device-bbbb0002');
        await connect(a, b);
        const created = network().created.length;

        a.plugin.unload();
        // The retry backoff after a torn-down peer is 2 s; wait past it.
        await sleep(2300);

        expect(network().created.length).toBe(created);
        expect((a.plugin as any).peerInitRetryTimeout).toBeNull();
        expect((a.plugin as any).clusterConnectionInterval).toBeNull();
    });

    test('unload leaves no timers armed', async () => {
        const baseline = activeTimers();
        const a = await createDevice('device-aaaa0001');
        const b = await createDevice('device-bbbb0002');
        await connect(a, b);
        await a.vault.create('note.md', 'hello');
        await waitFor(() => b.vault.text('note.md') === 'hello', { what: 'the note to arrive' });

        a.plugin.unload();
        b.plugin.unload();
        await sleep(20);

        expect(activeTimers()).toBeLessThanOrEqual(baseline);
    });
});

describe('connection glare', () => {
    test('two devices dialling each other at once keep exactly one shared link', async () => {
        const a = await createDevice('device-aaaa0001');
        const b = await createDevice('device-bbbb0002');

        a.plugin.dialPeer(b.id);
        b.plugin.dialPeer(a.id);

        await waitFor(() => isLinked(a, b) && isLinked(b, a), { what: 'both handshakes' });
        // Let the losing duplicate's close events arrive on both sides.
        await sleep(50);

        const aConn: any = a.plugin.connections.get(b.id);
        const bConn: any = b.plugin.connections.get(a.id);
        expect(aConn.open).toBe(true);
        expect(bConn.open).toBe(true);
        // Both ends hold the two halves of the SAME channel.
        expect(aConn.partner).toBe(bConn);
        // The duplicate is gone on both peers.
        expect((a.plugin.peer as any).connections).toHaveLength(1);
        expect((b.plugin.peer as any).connections).toHaveLength(1);
    });

    test('the link kept is the one dialled by the lower device ID', async () => {
        const a = await createDevice('device-aaaa0001');
        const b = await createDevice('device-bbbb0002');

        b.plugin.dialPeer(a.id);
        a.plugin.dialPeer(b.id);

        await waitFor(() => isLinked(a, b) && isLinked(b, a), { what: 'both handshakes' });
        await sleep(50);

        // device-aaaa0001 sorts first, so the survivor is the connection it dialled.
        const kept: any = a.plugin.connections.get(b.id);
        expect((a.plugin as any).dialledConnections.has(kept)).toBe(true);
    });

    test('a connection that closes without being current does not drop the live link', async () => {
        const a = await createDevice('device-aaaa0001');
        const b = await createDevice('device-bbbb0002');
        await connect(a, b);

        // An attempt that opened but never completed its handshake — rejected, abandoned,
        // or a losing duplicate. Its close used to delete the live entry for the same peer.
        const { DataConnection } = jest.requireMock('peerjs');
        const ghost = new DataConnection(a.plugin.peer, b.id, { reliable: true });
        a.plugin.setupConnection(ghost);
        ghost.open = true;
        ghost.emit('close');
        await sleep(30);

        expect(isLinked(a, b)).toBe(true);
        expect(isLinked(b, a)).toBe(true);
    });

    test('dialling an already-connected device replaces the link on both ends', async () => {
        const a = await createDevice('device-aaaa0001');
        const b = await createDevice('device-bbbb0002');
        await connect(a, b);
        const original: any = a.plugin.connections.get(b.id);

        const redial: any = a.plugin.dialPeer(b.id);
        await waitFor(() => a.plugin.connections.get(b.id) === redial, { what: 'the new link to take over' });
        await waitFor(() => (b.plugin.connections.get(a.id) as any) === redial.partner, { what: 'the far end to switch too' });
        await sleep(30);

        expect(original.open).toBe(false);
        expect(isLinked(a, b)).toBe(true);
        expect(isLinked(b, a)).toBe(true);
    });
});
