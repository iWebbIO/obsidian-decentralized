// @ts-ignore
import * as pako from 'pako';

export function compressText(content: string): ArrayBuffer {
    const result = pako.deflate(content);
    // Fix: Slice the buffer to the exact compressed length instead of returning the entire underlying slab buffer.
    return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
}

export function decompressText(data: ArrayBuffer): string {
    return pako.inflate(new Uint8Array(data), { to: 'string' });
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}
