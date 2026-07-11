import { EventEmitter } from 'events';

class MockSocket extends EventEmitter {
    bind(port: number, address: string) {
        setTimeout(() => this.emit('listening'), 0);
    }
    setMulticastTTL(ttl: number) {}
    addMembership(multicastAddress: string, interfaceAddress?: string) {}
    send(msg: Buffer, offset: number, length: number, port: number, address: string, callback?: (error: Error | null) => void) {
        if (callback) setTimeout(() => callback(null), 0);
    }
    close() {
        this.emit('close');
    }
}

export function createSocket(options: any) {
    return new MockSocket();
}
