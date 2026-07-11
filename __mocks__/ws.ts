import { EventEmitter } from 'events';

class MockWebSocket extends EventEmitter {
    readyState: number;
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url: string) {
        super();
        this.readyState = MockWebSocket.OPEN;
    }

    send(data: any) {
        // mock
    }

    close() {
        this.readyState = MockWebSocket.CLOSED;
        this.emit('close');
    }
}

class MockWebSocketServer extends EventEmitter {
    clients: Set<MockWebSocket>;
    
    constructor(options: any) {
        super();
        this.clients = new Set();
        // Simulate immediate listen
        setTimeout(() => this.emit('listening'), 0);
    }
    
    close() {
        this.emit('close');
    }
}

export default MockWebSocket;
export { MockWebSocketServer as Server, MockWebSocketServer as WebSocketServer, MockWebSocket as WebSocket };
