import { 
    compressText, 
    decompressText, 
    arrayBufferToBase64, 
    base64ToArrayBuffer,
    packFilesToTLV,
    unpackTLVToFiles,
    PackedFile
} from './utils';

// Mock window.btoa and window.atob for Node environment
if (typeof window === 'undefined') {
    (global as any).window = {
        btoa: btoa,
        atob: atob
    };
}

describe('Compression utils', () => {
    it('should compress and decompress text successfully', () => {
        const originalText = "Hello, Obsidian Decentralized Sync! This is a test string to be compressed and decompressed.";
        const compressed = compressText(originalText);
        
        expect(compressed).toBeInstanceOf(ArrayBuffer);
        expect(compressed.byteLength).toBeGreaterThan(0);
        
        const decompressed = decompressText(compressed);
        expect(decompressed).toBe(originalText);
    });

    it('should handle empty strings', () => {
        const originalText = "";
        const compressed = compressText(originalText);
        const decompressed = decompressText(compressed);
        expect(decompressed).toBe(originalText);
    });
});

describe('Base64 utils', () => {
    it('should convert ArrayBuffer to Base64 and back', () => {
        const testString = "Test array buffer to base64 conversion.";
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        
        const buffer = encoder.encode(testString).buffer;
        const base64 = arrayBufferToBase64(buffer);
        
        expect(typeof base64).toBe('string');
        expect(base64.length).toBeGreaterThan(0);
        
        const decodedBuffer = base64ToArrayBuffer(base64);
        const decodedString = decoder.decode(decodedBuffer);
        
        expect(decodedString).toBe(testString);
    });
});

describe('TLV packing/unpacking', () => {
    it('should pack and unpack files correctly', () => {
        const encoder = new TextEncoder();
        
        const files: PackedFile[] = [
            {
                path: 'folder/file1.md',
                mtime: 1234567890.123,
                isCompressed: true,
                encoding: 'utf8',
                content: encoder.encode('File 1 content').buffer
            },
            {
                path: 'file2.png',
                mtime: 9876543210.987,
                isCompressed: false,
                encoding: 'binary',
                content: new Uint8Array([1, 2, 3, 4, 5])
            }
        ];

        const packedBuffer = packFilesToTLV(files);
        expect(packedBuffer).toBeInstanceOf(ArrayBuffer);
        expect(packedBuffer.byteLength).toBeGreaterThan(0);

        const unpackedFiles = unpackTLVToFiles(packedBuffer);
        
        expect(unpackedFiles.length).toBe(2);
        
        // Check first file
        expect(unpackedFiles[0].path).toBe(files[0].path);
        expect(unpackedFiles[0].mtime).toBeCloseTo(files[0].mtime, 3);
        expect(unpackedFiles[0].isCompressed).toBe(files[0].isCompressed);
        expect(unpackedFiles[0].encoding).toBe(files[0].encoding);
        
        // Content comparison
        const unpackedContent1 = new Uint8Array(unpackedFiles[0].content);
        const originalContent1 = new Uint8Array(files[0].content);
        expect(unpackedContent1).toEqual(originalContent1);

        // Check second file
        expect(unpackedFiles[1].path).toBe(files[1].path);
        expect(unpackedFiles[1].mtime).toBeCloseTo(files[1].mtime, 3);
        expect(unpackedFiles[1].isCompressed).toBe(files[1].isCompressed);
        expect(unpackedFiles[1].encoding).toBe(files[1].encoding);
        
        const unpackedContent2 = new Uint8Array(unpackedFiles[1].content);
        const originalContent2 = new Uint8Array(files[1].content as Uint8Array);
        expect(unpackedContent2).toEqual(originalContent2);
    });
});
