/**
 * Smoke tests for the plugin harness itself: two real plugin instances, each with its own
 * in-memory vault, talking over the fake PeerJS network. If these fail, every integration
 * test built on the harness is suspect, so they stay deliberately simple.
 */
import { createDevice, connect, teardown, waitFor, isLinked } from './helpers/harness';

afterEach(teardown);

describe('plugin harness', () => {
    test('two devices reach the signalling server and complete a handshake', async () => {
        const a = await createDevice('device-aaaa0001', { name: 'Laptop' });
        const b = await createDevice('device-bbbb0002', { name: 'Phone' });

        await connect(a, b);

        expect(isLinked(a, b)).toBe(true);
        expect(isLinked(b, a)).toBe(true);
        expect(a.plugin.clusterPeers.get(b.id)?.friendlyName).toBe('Phone');
        expect(b.plugin.clusterPeers.get(a.id)?.friendlyName).toBe('Laptop');
    });

    test('a note created on one device arrives on the other', async () => {
        const a = await createDevice('device-aaaa0001');
        const b = await createDevice('device-bbbb0002');
        await connect(a, b);

        await a.vault.createFolder('Notes');
        await a.vault.create('Notes/hello.md', '# Hello\n\nFrom the laptop.');

        await waitFor(() => b.vault.text('Notes/hello.md') === '# Hello\n\nFrom the laptop.', {
            what: 'the note to reach the second vault',
        });
    });
});
