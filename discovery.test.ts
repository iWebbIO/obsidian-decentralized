jest.mock('dgram');
jest.mock('obsidian');

Object.defineProperty(global, 'window', {
    value: {
        setTimeout, clearTimeout, setInterval, clearInterval,
        addEventListener: jest.fn(), removeEventListener: jest.fn()
    },
    writable: true
});

import { DesktopLANDiscovery } from './discovery';
import { PeerInfo } from './types';

describe('DesktopLANDiscovery', () => {
    let discovery: DesktopLANDiscovery;

    beforeEach(() => {
        jest.useFakeTimers();
        discovery = new DesktopLANDiscovery();
    });

    afterEach(() => {
        discovery.stop();
        jest.useRealTimers();
    });

    test('should start listening and handle socket creation', () => {
        discovery.startListening();
        const socket = (discovery as any).socket;
        expect(socket).toBeDefined();

        // Emulate listening — restart bookkeeping resets and multicast is configured
        (discovery as any).socketRestartAttempts = 2;
        socket.emit('listening');
        expect((discovery as any).socketRestartAttempts).toBe(0);
        expect((discovery as any).socket).toBe(socket); // socket kept after successful bind
    });

    test('should broadcast dynamically serialized beacons', () => {
        const peerInfo: PeerInfo = { deviceId: 'my-device', friendlyName: 'My PC', ip: null };
        
        discovery.startBroadcasting(peerInfo);
        expect((discovery as any).broadcastTimer).not.toBeNull();
        expect((discovery as any).lastPeerInfo).toBe(peerInfo);

        const socket = (discovery as any).socket;
        const sendSpy = jest.spyOn(socket, 'send');

        jest.advanceTimersByTime(3000); // First timeout is scheduled for 3000ms (2000 + 1000 backoff)
        expect(sendSpy).toHaveBeenCalled();
        
        // Change the peer info (mutable)
        peerInfo.friendlyName = 'My Renamed PC';
        
        jest.advanceTimersByTime(4000); // Next interval is 4000ms
        expect(sendSpy).toHaveBeenCalledTimes(2);

        // Check the second call's payload to see if it picked up the new name
        const payload = sendSpy.mock.calls[1][0] as Buffer;
        const json = JSON.parse(payload.toString());
        expect(json.peerInfo.friendlyName).toBe('My Renamed PC');
    });

    test('should discover new peers and emit event', () => {
        const discoverSpy = jest.fn();
        discovery.on('discover', discoverSpy);
        discovery.startListening();
        
        const socket = (discovery as any).socket;
        const beacon = {
            type: 'obsidian-decentralized-beacon',
            peerInfo: { deviceId: 'other-device', friendlyName: 'Other PC' }
        };

        socket.emit('message', Buffer.from(JSON.stringify(beacon)), { address: '192.168.1.5' });
        
        expect(discoverSpy).toHaveBeenCalledTimes(1);
        const discoveredPeer = discoverSpy.mock.calls[0][0];
        expect(discoveredPeer.deviceId).toBe('other-device');
        expect(discoveredPeer.ip).toBe('192.168.1.5');
    });

    test('should emit lose when a peer times out', () => {
        const discoverSpy = jest.fn();
        const loseSpy = jest.fn();
        discovery.on('discover', discoverSpy);
        discovery.on('lose', loseSpy);
        discovery.startListening();
        
        const socket = (discovery as any).socket;
        const beacon = {
            type: 'obsidian-decentralized-beacon',
            peerInfo: { deviceId: 'other-device', friendlyName: 'Other PC' }
        };

        socket.emit('message', Buffer.from(JSON.stringify(beacon)), { address: '192.168.1.5' });
        expect(discoverSpy).toHaveBeenCalledTimes(1);
        
        // Wait for the timeout (15000ms as per discovery.ts)
        jest.advanceTimersByTime(15000);
        
        expect(loseSpy).toHaveBeenCalledTimes(1);
        expect(loseSpy.mock.calls[0][0].deviceId).toBe('other-device');
    });

    test('should guard onNetworkChange re-entry', () => {
        const spyStopBroadcasting = jest.spyOn(discovery, 'stopBroadcasting');
        const spyStart = jest.spyOn(discovery, 'startListening');
        
        discovery.startListening();
        
        const onNetworkChange = (discovery as any).onNetworkChange;
        
        // Call it directly
        onNetworkChange();
        
        expect(spyStopBroadcasting).toHaveBeenCalledTimes(1);
        expect(spyStart).toHaveBeenCalledTimes(2); // 1 initial + 1 on restart
        
        // To test re-entry, we'd need it to call itself. 
        // We can just verify the flag works.
        (discovery as any).isRestarting = true;
        onNetworkChange();
        // Should not have incremented calls
        expect(spyStopBroadcasting).toHaveBeenCalledTimes(1);
    });
});
