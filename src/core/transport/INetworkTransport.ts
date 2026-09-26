/**
 * Abstract network transport contract.
 * Decouples the sync state machine from specific network protocols
 * (WebRTC/PeerJS, WebSocket/Direct-IP, or in-memory virtual routing).
 */

export type MessageHandler = (peerId: string, message: Uint8Array | string) => void;
export type PeerEventHandler = (peerId: string) => void;

export interface INetworkTransport {
    /** Send a message (raw binary or string) to a connected peer. */
    send(peerId: string, message: Uint8Array | string): Promise<void>;

    /** Register listener for incoming peer messages. Returns unsubscribe fn. */
    onMessage(handler: MessageHandler): () => void;

    /** Register listener for peer connection events. Returns unsubscribe fn. */
    onPeerConnect(handler: PeerEventHandler): () => void;

    /** Register listener for peer disconnection events. Returns unsubscribe fn. */
    onPeerDisconnect(handler: PeerEventHandler): () => void;

    /** Disconnect a specific peer. */
    disconnect(peerId: string): Promise<void>;

    /** Get list of currently connected peer IDs. */
    getConnectedPeers(): string[];

    /** Close and tear down the transport. */
    close(): Promise<void>;
}
