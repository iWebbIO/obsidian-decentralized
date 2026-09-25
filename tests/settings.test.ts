/**
 * Settings loading, run against the real plugin class.
 */
import { createDevice, teardown } from './helpers/harness';
import { DEFAULT_SETTINGS } from '../src/types';

afterEach(teardown);

describe('loadSettings', () => {
    test('each instance gets its own copy of the defaults', async () => {
        // A shallow merge handed every instance DEFAULT_SETTINGS' own nested objects, so a
        // pairing key stored by one was visible to — and persisted by — the other.
        const a = await createDevice('device-aaaa0001');
        const b = await createDevice('device-bbbb0002');

        a.plugin.settings.peerKeys['device-cccc0003'] = 'key';
        a.plugin.settings.blockedPeers.push('device-dddd0004');
        a.plugin.settings.customPeerServerConfig.port = 1234;

        expect(b.plugin.settings.peerKeys).toEqual({});
        expect(b.plugin.settings.blockedPeers).toEqual([]);
        expect(DEFAULT_SETTINGS.peerKeys).toEqual({});
        expect(DEFAULT_SETTINGS.blockedPeers).toEqual([]);
        expect(DEFAULT_SETTINGS.customPeerServerConfig.port).toBe(9000);
    });

    test('a stored server config missing newer fields keeps their defaults', async () => {
        const a = await createDevice('device-aaaa0001', {
            settings: { customPeerServerConfig: { host: 'peers.example', port: 443 } as any },
        });

        expect(a.plugin.settings.customPeerServerConfig).toEqual({
            host: 'peers.example', port: 443, path: '/myapp', secure: false,
        });
    });
});
