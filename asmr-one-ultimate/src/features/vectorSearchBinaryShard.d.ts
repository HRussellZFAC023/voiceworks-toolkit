import type { SemanticVectorEntry } from './vectorSearchIndexTypes';

export const SEMANTIC_BINARY_MAGIC: 'ASMRVEC\0';
export const SEMANTIC_BINARY_VERSION: 1;
export const SEMANTIC_BINARY_HEADER_BYTES: 24;
export function stableSemanticJson(value: unknown): string;
export function encodeSemanticBinaryShard(entries: Array<SemanticVectorEntry & Record<string, unknown>>, dimension: number): Uint8Array;
export function decodeSemanticBinaryShard(input: ArrayBuffer | Uint8Array): {
    version: number;
    dimension: number;
    count: number;
    entries: Array<Omit<SemanticVectorEntry, 'vector'> & { vector: Float32Array }>;
};
