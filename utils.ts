// @ts-ignore
import * as pako from 'pako';
import { SyncError, SyncErrorCategory } from './types';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function compressText(content: string): ArrayBuffer {
    try {
        const result = pako.deflate(content);
        // Fix: Slice the buffer to the exact compressed length instead of returning the entire underlying slab buffer.
        return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
    } catch (err: any) {
        throw new SyncError(
            SyncErrorCategory.INTEGRITY_ERROR,
            `Compression failed: ${err.message || err}`,
            true,
            'Check if the file content is valid text and retry.'
        );
    }
}

export function decompressText(data: ArrayBuffer): string {
    try {
        return pako.inflate(new Uint8Array(data), { to: 'string' });
    } catch (err: any) {
        throw new SyncError(
            SyncErrorCategory.INTEGRITY_ERROR,
            `Decompression failed: ${err.message || err}`,
            false,
            'The transferred file data might be corrupted. Please re-sync.'
        );
    }
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    try {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        const chunkSize = 8192;
        for (let i = 0; i < len; i += chunkSize) {
            binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
        }
        return window.btoa(binary);
    } catch (err: any) {
        throw new SyncError(
            SyncErrorCategory.INTEGRITY_ERROR,
            `Base64 encoding failed: ${err.message || err}`,
            true,
            'Verify the input buffer size/content and retry.'
        );
    }
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
    try {
        const binary_string = window.atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return bytes.buffer;
    } catch (err: any) {
        throw new SyncError(
            SyncErrorCategory.INTEGRITY_ERROR,
            `Base64 decoding failed: ${err.message || err}`,
            false,
            'Invalid base64 string provided. Check file transfer integrity.'
        );
    }
}

export interface PackedFile {
    path: string;
    mtime: number;
    isCompressed: boolean;
    encoding: 'utf8' | 'binary' | 'base64';
    content: ArrayBuffer | Uint8Array;
}

export function packFilesToTLV(files: PackedFile[]): ArrayBuffer {
    try {
        let totalSize = 0;
        
        // Calculate total size first to avoid reallocations
        const encodedPaths: Uint8Array[] = [];
        for (const file of files) {
            const pathEncoded = textEncoder.encode(file.path);
            encodedPaths.push(pathEncoded);
            // 2 (path len) + pathBytes + 8 (mtime) + 1 (isCompressed) + 1 (encoding) + 4 (content len) + contentBytes
            totalSize += 2 + pathEncoded.byteLength + 8 + 1 + 1 + 4 + file.content.byteLength;
        }
        
        const buffer = new ArrayBuffer(totalSize);
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);
        let offset = 0;
        
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const pathEncoded = encodedPaths[i];
            
            view.setUint16(offset, pathEncoded.byteLength, true); offset += 2;
            bytes.set(pathEncoded, offset); offset += pathEncoded.byteLength;
            
            view.setFloat64(offset, file.mtime, true); offset += 8;
            
            view.setUint8(offset, file.isCompressed ? 1 : 0); offset += 1;
            
            let encFlag = 0;
            if (file.encoding === 'binary') encFlag = 1;
            else if (file.encoding === 'base64') encFlag = 2;
            view.setUint8(offset, encFlag); offset += 1;
            
            view.setUint32(offset, file.content.byteLength, true); offset += 4;
            const contentBytes = file.content instanceof Uint8Array ? file.content : new Uint8Array(file.content);
            bytes.set(contentBytes, offset); offset += file.content.byteLength;
        }
        
        return buffer;
    } catch (err: any) {
        throw new SyncError(
            SyncErrorCategory.PROTOCOL_ERROR,
            `TLV packing failed: ${err.message || err}`,
            true,
            'Verify files schema and retry sync.'
        );
    }
}

export function unpackTLVToFiles(buffer: ArrayBuffer): PackedFile[] {
    try {
        const view = new DataView(buffer);
        const files: PackedFile[] = [];
        let offset = 0;
        
        while (offset < buffer.byteLength) {
            // 1. Check if we can read the path length (2 bytes)
            if (offset + 2 > buffer.byteLength) {
                throw new SyncError(
                    SyncErrorCategory.PROTOCOL_ERROR,
                    `TLV unpack failed: Truncated buffer when reading path length at offset ${offset}`,
                    false,
                    'Re-request the file sync batch.'
                );
            }
            const pathLen = view.getUint16(offset, true); offset += 2;
            
            // 2. Check if we can read the path bytes (pathLen bytes)
            if (offset + pathLen > buffer.byteLength) {
                throw new SyncError(
                    SyncErrorCategory.PROTOCOL_ERROR,
                    `TLV unpack failed: Truncated buffer when reading path of length ${pathLen} at offset ${offset}`,
                    false,
                    'Re-request the file sync batch.'
                );
            }
            const pathBytes = new Uint8Array(buffer, offset, pathLen);
            const path = textDecoder.decode(pathBytes); offset += pathLen;
            
            // 3. Check if we can read mtime (8 bytes), isCompressed (1 byte), encFlag (1 byte), and contentLen (4 bytes)
            if (offset + 14 > buffer.byteLength) {
                throw new SyncError(
                    SyncErrorCategory.PROTOCOL_ERROR,
                    `TLV unpack failed: Truncated buffer when reading metadata at offset ${offset}`,
                    false,
                    'Re-request the file sync batch.'
                );
            }
            const mtime = view.getFloat64(offset, true); offset += 8;
            const isCompressed = view.getUint8(offset) === 1; offset += 1;
            const encFlag = view.getUint8(offset); offset += 1;
            
            let encoding: 'utf8' | 'binary' | 'base64' = 'utf8';
            if (encFlag === 1) encoding = 'binary';
            else if (encFlag === 2) encoding = 'base64';
            
            const contentLen = view.getUint32(offset, true); offset += 4;
            
            // 4. Check if we can read content bytes (contentLen bytes)
            if (offset + contentLen > buffer.byteLength) {
                throw new SyncError(
                    SyncErrorCategory.PROTOCOL_ERROR,
                    `TLV unpack failed: Truncated buffer when reading content of length ${contentLen} at offset ${offset}`,
                    false,
                    'Re-request the file sync batch.'
                );
            }
            // Use slice to create an independent copy and prevent retaining the entire batch buffer
            const content = new Uint8Array(buffer.slice(offset, offset + contentLen));
            offset += contentLen;
            
            files.push({ path, mtime, isCompressed, encoding, content });
        }
        
        return files;
    } catch (err: any) {
        if (err instanceof SyncError) {
            throw err;
        }
        throw new SyncError(
            SyncErrorCategory.PROTOCOL_ERROR,
            `TLV unpacking failed: ${err.message || err}`,
            false,
            'Re-request the file sync batch.'
        );
    }
}
