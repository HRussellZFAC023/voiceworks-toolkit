import type { SemanticVectorEntry } from './vectorSearchIndexTypes';
import type { WorkTag } from '../types/api';

export const SEMANTIC_DOCUMENT_MAX_CHARS: 640;
export const SEMANTIC_DESCRIPTION_MAX_CHARS: 1500;
export const SEMANTIC_PAYLOAD_MAX_CHARS: 5000;

export interface SemanticWorkInput {
    id: string | number;
    title?: string;
    description?: string;
    summary?: string;
    release?: string;
    circle?: { name?: string };
    series?: { name?: string };
    vas?: Array<{ name?: string }>;
    tags?: WorkTag[];
    age_category_string?: string;
    language_editions?: Array<{ lang?: string; label?: string }>;
    dl_count?: number;
    rate_average_2dp?: number;
    nsfw?: boolean;
    has_subtitle?: boolean;
}

export interface SemanticEntryPreparationOptions {
    resolveTagAliases?: (tag: WorkTag) => readonly string[] | undefined;
}

export interface PreparedSemanticWork {
    entry: SemanticVectorEntry;
    payload: string;
}

export function prepareSemanticWorkEntry(
    work: SemanticWorkInput,
    options?: SemanticEntryPreparationOptions,
): PreparedSemanticWork | null;
export function canonicalSemanticDocumentPayload(value: string): string;
export function canonicalSemanticPassageModelInput(value: string): string;
export function semanticDotProduct(left: ArrayLike<number>, right: ArrayLike<number>): number;
