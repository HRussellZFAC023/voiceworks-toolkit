/**
 * JPDB.io API Types
 *
 * Ported from anki-jpdb.reader by chinokusari (MIT License)
 * https://github.com/Kagu-chan/anki-jpdb.reader
 */

// ============================================================================
// Card State
// ============================================================================

export enum JPDBCardState {
    NEW = 'new',
    LEARNING = 'learning',
    KNOWN = 'known',
    DUE = 'due',
    FAILED = 'failed',
    LOCKED = 'locked',
    NEVER_FORGET = 'never-forget',
    SUSPENDED = 'suspended',
    BLACKLISTED = 'blacklisted',
    REDUNDANT = 'redundant',
    NOT_IN_DECK = 'not-in-deck',
}

export type JPDBGrade = 'nothing' | 'something' | 'hard' | 'okay' | 'easy' | 'fail' | 'pass';

// ============================================================================
// Vocabulary & Token Types
// ============================================================================

export interface JPDBMeaning {
    glosses: string[];
    partOfSpeech: string[];
}

export interface JPDBCard {
    vid: number;
    sid: number;
    rid: number;
    spelling: string;
    reading: string;
    frequencyRank: number | null;
    partOfSpeech: string[];
    meanings: JPDBMeaning[];
    cardState: JPDBCardState[];
    pitchAccent: string[];
    wordWithReading: string | null;
}

export interface JPDBRuby {
    text: string;   // furigana reading
    start: number;  // UTF-16 position in paragraph
    end: number;
    length: number;
}

export interface JPDBToken {
    card: JPDBCard;
    start: number;  // UTF-16 position in paragraph
    end: number;
    length: number;
    rubies: JPDBRuby[];
    pitchClass: string;
    sentence?: string;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

type JPDBFuriganaEntry = string | [spelling: string, reading: string];
type JPDBFurigana = JPDBFuriganaEntry[] | null;

export type JPDBRawToken = [
    vocabularyIndex: number,
    position: number,
    length: number,
    furigana: JPDBFurigana,
];

export type JPDBRawVocabulary = [
    vid: number,
    sid: number,
    rid: number,
    spelling: string,
    reading: string,
    frequency_rank: number,
    part_of_speech: string[],
    meanings_chunks: string[][],
    meanings_part_of_speech: string[][],
    card_state: JPDBCardState[],
    pitch_accent: string[] | null,
];

export interface JPDBParseResult {
    tokens: JPDBRawToken[][];
    vocabulary: JPDBRawVocabulary[];
}

export interface JPDBDeck {
    id?: number | JPDBSpecialDeckName;
    name?: string;
    vocabulary_count?: number;
    word_count?: number;
    is_built_in?: boolean;
}

export type JPDBSpecialDeckName = 'blacklist' | 'never-forget' | 'forq';

export interface JPDBErrorResponse {
    error_message: string;
}

// ============================================================================
// Parsed Result (post-processing)
// ============================================================================

export interface JPDBParsedResult {
    tokens: JPDBToken[][];
    cards: JPDBCard[];
}
