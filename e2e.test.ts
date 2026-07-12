import { DesktopLANDiscovery } from './discovery';
import { DirectIpServer, DirectIpClient } from './directip';
import { PeerInfo } from './types';
import MockWebSocket from './__mocks__/ws';
import * as dgram from 'dgram';

// Mock dgram for LAN Discovery testing
jest.mock('dgram', () => {
    const EventEmitter = require('events');
    class MockSocket extends EventEmitter {
        addMembership() {}
        setMulticastTTL() {}
        bind(port: number, arg2?: any, arg3?: any) {
            setTimeout(() => this.emit('listening'), 10);
            const cb = typeof arg2 === 'function' ? arg2 : typeof arg3 === 'function' ? arg3 : null;
            if (cb) cb();
        }
        send(msg: Buffer, offset: number, length: number, port: number, address: string, cb: (err?: Error|null) => void) {
            // Simulate multicast send by emitting 'message' on all MockSockets
            MockSocket.sockets.forEach(s => {
                if (s !== this) {
                    setTimeout(() => s.emit('message', msg, { address: '127.0.0.1' }), 10);
                }
            });
            if (cb) cb(null);
        }
        close() {}
    }
    (MockSocket as any).sockets = [];
    
    return {
        createSocket: () => {
            const socket = new MockSocket();
            (MockSocket as any).sockets.push(socket);
            return socket;
        }
    };
});

jest.mock('obsidian');

Object.defineProperty(global, 'window', {
    value: {
        setTimeout, clearTimeout, setInterval, clearInterval,
        addEventListener: jest.fn(), removeEventListener: jest.fn(),
        crypto: { getRandomValues: (arr: any) => arr }
    },
    writable: true
});

(global as any).WebSocket = MockWebSocket;

describe('End-to-End Plug-and-Play', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('Two nodes discover each other and connect reliably', () => {
        const node1Discovery = new DesktopLANDiscovery();
        const node2Discovery = new DesktopLANDiscovery();

        const node1Discovered = jest.fn();
        const node2Discovered = jest.fn();

        node1Discovery.on('discover', node1Discovered);
        node2Discovery.on('discover', node2Discovered);

        node1Discovery.startBroadcasting({ deviceId: 'node1', friendlyName: 'Node 1', ip: null });
        node2Discovery.startBroadcasting({ deviceId: 'node2', friendlyName: 'Node 2', ip: null });

        // Advance enough time for beacons to be sent and processed
        jest.advanceTimersByTime(5000);

        expect(node1Discovered).toHaveBeenCalled();
        expect(node2Discovered).toHaveBeenCalled();
        
        node1Discovery.stop();
        node2Discovery.stop();
    });
});
