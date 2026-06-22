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
    const chunkSize = 8192;
    for (let i = 0; i < len; i += chunkSize) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
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

export interface PackedFile {
    path: string;
    mtime: number;
    isCompressed: boolean;
    encoding: 'utf8' | 'binary' | 'base64';
    content: ArrayBuffer | Uint8Array;
}

export function packFilesToTLV(files: PackedFile[]): ArrayBuffer {
    const encoder = new TextEncoder();
    let totalSize = 0;
    
    // Calculate total size first to avoid reallocations
    const encodedPaths: Uint8Array[] = [];
    for (const file of files) {
        const pathEncoded = encoder.encode(file.path);
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
}

export function unpackTLVToFiles(buffer: ArrayBuffer): PackedFile[] {
    const decoder = new TextDecoder();
    const view = new DataView(buffer);
    const files: PackedFile[] = [];
    let offset = 0;
    
    while (offset < buffer.byteLength) {
        const pathLen = view.getUint16(offset, true); offset += 2;
        
        // Zero-copy view for decoding
        const pathBytes = new Uint8Array(buffer, offset, pathLen);
        const path = decoder.decode(pathBytes); offset += pathLen;
        
        const mtime = view.getFloat64(offset, true); offset += 8;
        const isCompressed = view.getUint8(offset) === 1; offset += 1;
        
        const encFlag = view.getUint8(offset); offset += 1;
        let encoding: 'utf8' | 'binary' | 'base64' = 'utf8';
        if (encFlag === 1) encoding = 'binary';
        else if (encFlag === 2) encoding = 'base64';
        
        const contentLen = view.getUint32(offset, true); offset += 4;
        
        // Use slice to create an independent copy and prevent retaining the entire batch buffer
        const content = new Uint8Array(buffer.slice(offset, offset + contentLen));
        offset += contentLen;
        
        files.push({ path, mtime, isCompressed, encoding, content });
    }
    
    return files;
}
