import type { TranslationSourceHint } from '../types/store';

export interface WhisperTextRequestContext {
    text: string;
    generation: number;
    trackKey: string | null;
    sourceLanguageHint: TranslationSourceHint;
    targetLanguage: string;
}

/** Reject async translation results belonging to an older live-text update. */
export function isCurrentWhisperTextRequest(
    requested: WhisperTextRequestContext,
    current: WhisperTextRequestContext,
): boolean {
    return requested.text === current.text
        && requested.generation === current.generation
        && requested.trackKey === current.trackKey
        && requested.sourceLanguageHint === current.sourceLanguageHint
        && requested.targetLanguage === current.targetLanguage;
}
