/**
 * JpdbService — JPDB.io API Client
 *
 * Handles parse, review, deck management, and caching.
 * Ported from anki-jpdb.reader by chinokusari (MIT License)
 */

import { AppStore } from '../store/AppStore';
import { Logger } from '../core/Logger';
import type {
    JPDBCard,
    JPDBCardState,
    JPDBDeck,
    JPDBErrorResponse,
    JPDBGrade,
    JPDBParsedResult,
    JPDBParseResult,
    JPDBRawVocabulary,
    JPDBRawToken,
    JPDBRuby,
    JPDBToken,
} from '../types/jpdb';

// ============================================================================
// Pitch Accent (ported from anki-jpdb.reader)
// ============================================================================

const SMALL_SYLLABLES = new Set(['ゃ', 'ゅ', 'ょ', 'ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ッ', 'ャ', 'ュ', 'ョ']);

function getPitchClass(pitchAccent: string[], reading: string): string {
    if (!pitchAccent.length) return '';

    const [pitch] = pitchAccent;
    const parts = pitch.split('');
    const first = parts.shift()!;
    const last = parts.pop();

    // Adjust for small syllables
    if (reading.length > 1 && SMALL_SYLLABLES.has(reading.charAt(1)) && first === parts[0]) {
        parts.shift();
    }

    const rises = (pitch.match(/LH/g) ?? []).length;
    const drops = (pitch.match(/HL/g) ?? []).length;
    const startsLow = first === 'L';
    const startsHigh = !startsLow;
    const endsLow = last === 'L';
    const endsHigh = !endsLow;
    const allHigh = !parts.includes('L');

    if (reading.length === 1 && pitch === 'HL') return 'odaka';
    if (startsHigh && drops === 1 && parts[0] === 'L') return 'atamadaka';
    if (startsLow && endsLow && rises === 1) return 'nakadaka';
    if (startsLow && rises === 1 && (endsLow || parts.length === 1)) return 'odaka';
    if (startsLow && allHigh && endsHigh) return 'heiban';
    if (rises > 1 || drops > 1) return 'kifuku';

    return '';
}

// ============================================================================
// LRU Cache
// ============================================================================

class LRUCache<K, V> {
    private map = new Map<K, V>();
    constructor(private maxSize: number) {}

    get(key: K): V | undefined {
        const val = this.map.get(key);
        if (val !== undefined) {
            // Move to end (most recent)
            this.map.delete(key);
            this.map.set(key, val);
        }
        return val;
    }

    set(key: K, value: V): void {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, value);
        if (this.map.size > this.maxSize) {
            const oldest = this.map.keys().next().value;
            if (oldest !== undefined) this.map.delete(oldest);
        }
    }

    has(key: K): boolean {
        return this.map.get(key) !== undefined;
    }

    forEach(fn: (value: V, key: K) => void): void {
        this.map.forEach(fn);
    }

    clear(): void {
        this.map.clear();
    }
}

// ============================================================================
// JpdbService
// ============================================================================

const API_BASE = 'https://jpdb.io/api/v1';

const TOKEN_FIELDS = ['vocabulary_index', 'position', 'length', 'furigana'] as const;
const VOCABULARY_FIELDS = [
    'vid', 'sid', 'rid', 'spelling', 'reading',
    'frequency_rank', 'part_of_speech', 'meanings_chunks',
    'meanings_part_of_speech', 'card_state', 'pitch_accent',
] as const;

class JpdbServiceImpl {
    private cardCache = new Map<string, JPDBCard>();
    private parseCache = new LRUCache<string, JPDBParsedResult>(500);
    private deckCache: JPDBDeck[] | null = null;
    private deckCacheTime = 0;

    // Retry state
    private retryAfter = 0;

    // =========================================================================
    // Core API
    // =========================================================================

    private getApiToken(): string {
        return AppStore.getConfig('jpdbApiToken');
    }

    private async request<T>(endpoint: string, body?: Record<string, unknown>): Promise<T> {
        const token = this.getApiToken();
        if (!token) {
            throw new Error('JPDB API token not set');
        }

        // Rate limit guard
        if (Date.now() < this.retryAfter) {
            throw new Error('Rate limited — try again later');
        }

        const response = await fetch(`${API_BASE}/${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        });

        if (response.status === 429) {
            // Backoff 30s on rate limit
            this.retryAfter = Date.now() + 30_000;
            Logger.warn('[JPDB] Rate limited, backing off 30s');
            throw new Error('Rate limited');
        }

        if (response.status === 403) {
            throw new Error('Invalid API key');
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`JPDB API error ${response.status}: ${text}`);
        }

        // Some endpoints return empty body (204-like)
        const text = await response.text();
        if (!text) return undefined as T;

        const json = JSON.parse(text) as T | JPDBErrorResponse;
        if (json && typeof json === 'object' && 'error_message' in json) {
            throw new Error((json as JPDBErrorResponse).error_message);
        }

        return json as T;
    }

    // =========================================================================
    // Parse
    // =========================================================================

    /**
     * Parse Japanese text into tokens with furigana, meanings, and card state.
     * Results are cached by text content.
     */
    async parse(paragraphs: string[]): Promise<JPDBParsedResult> {
        // Filter empty strings
        const nonEmpty = paragraphs.filter(p => p.trim().length > 0);
        if (!nonEmpty.length) {
            return { tokens: [], cards: [] };
        }

        // Check cache
        const cacheKey = nonEmpty.join('\n');
        const cached = this.parseCache.get(cacheKey);
        if (cached) return cached;

        const raw = await this.request<JPDBParseResult>('parse', {
            text: nonEmpty,
            position_length_encoding: 'utf16',
            token_fields: [...TOKEN_FIELDS],
            vocabulary_fields: [...VOCABULARY_FIELDS],
        });

        const cards = this.vocabToCards(raw.vocabulary);
        const tokens = this.parseTokens(raw.tokens, cards);
        this.addSentenceInfo(nonEmpty, tokens);

        // Cache cards
        for (const card of cards) {
            this.cardCache.set(`${card.vid}/${card.sid}`, card);
        }

        const result: JPDBParsedResult = { tokens, cards };
        this.parseCache.set(cacheKey, result);
        return result;
    }

    /**
     * Parse a single string. Convenience wrapper.
     */
    async parseSingle(text: string): Promise<JPDBToken[]> {
        const result = await this.parse([text]);
        return result.tokens[0] ?? [];
    }

    // =========================================================================
    // Card Management
    // =========================================================================

    async reviewCard(vid: number, sid: number, grade: JPDBGrade): Promise<void> {
        await this.request<void>('review', { vid, sid, grade });
        // Invalidate card cache
        this.cardCache.delete(`${vid}/${sid}`);
        Logger.debug(`[JPDB] Reviewed ${vid}/${sid} as ${grade}`);
    }

    /**
     * Fetch fresh card state from jpdb (bypasses parseCache).
     * Used after grading to get the actual SRS state.
     */
    async fetchCardState(vid: number, sid: number, spelling: string): Promise<JPDBCard | undefined> {
        const raw = await this.request<JPDBParseResult>('parse', {
            text: [spelling],
            position_length_encoding: 'utf16',
            token_fields: [...TOKEN_FIELDS],
            vocabulary_fields: [...VOCABULARY_FIELDS],
        });
        const cards = this.vocabToCards(raw.vocabulary);
        for (const card of cards) {
            this.cardCache.set(`${card.vid}/${card.sid}`, card);
        }
        const freshCard = this.cardCache.get(`${vid}/${sid}`);
        // Update card state in all cached parse results so future reads are fresh
        if (freshCard) {
            this.refreshCardInParseCache(vid, sid, freshCard.cardState);
        }
        return freshCard;
    }

    /**
     * Walk parseCache and update cardState for a specific word in all cached results.
     * Keeps parseCache consistent after grading without clearing the whole cache.
     */
    private refreshCardInParseCache(vid: number, sid: number, newState: JPDBCardState[]): void {
        this.parseCache.forEach((result) => {
            for (const paragraph of result.tokens) {
                for (const token of paragraph) {
                    if (token.card.vid === vid && token.card.sid === sid) {
                        token.card.cardState = newState;
                    }
                }
            }
        });
    }

    async addToDeck(deckId: number | string, vid: number, sid: number): Promise<void> {
        await this.request<void>('deck/add-vocabulary', {
            id: deckId,
            vocabulary: [[vid, sid]],
        });
        Logger.debug(`[JPDB] Added ${vid}/${sid} to deck ${deckId}`);
    }

    async removeFromDeck(deckId: number | string, vid: number, sid: number): Promise<void> {
        await this.request<void>('deck/remove-vocabulary', {
            id: deckId,
            vocabulary: [[vid, sid]],
        });
        Logger.debug(`[JPDB] Removed ${vid}/${sid} from deck ${deckId}`);
    }

    async listUserDecks(): Promise<JPDBDeck[]> {
        // Cache for 5 minutes
        if (this.deckCache && Date.now() - this.deckCacheTime < 300_000) {
            return this.deckCache;
        }

        const result = await this.request<{ decks: unknown[][] }>('list-user-decks', {
            fields: ['id', 'name', 'vocabulary_count', 'is_built_in'],
        });

        this.deckCache = result.decks.map(d => ({
            id: d[0] as number,
            name: d[1] as string,
            vocabulary_count: d[2] as number,
            is_built_in: d[3] as boolean,
        }));
        this.deckCacheTime = Date.now();
        return this.deckCache;
    }

    async ping(): Promise<boolean> {
        try {
            await this.request<void>('ping');
            return true;
        } catch {
            return false;
        }
    }

    // =========================================================================
    // Card Cache Access
    // =========================================================================

    getCard(vid: number, sid: number): JPDBCard | undefined {
        return this.cardCache.get(`${vid}/${sid}`);
    }

    updateCardState(vid: number, sid: number, state: JPDBCardState[]): void {
        const card = this.cardCache.get(`${vid}/${sid}`);
        if (card) {
            card.cardState = state;
        }
    }

    clearCaches(): void {
        this.cardCache.clear();
        this.parseCache.clear();
        this.deckCache = null;
    }

    // =========================================================================
    // Internal: Token Parsing (ported from anki-jpdb.reader Parser)
    // =========================================================================

    private vocabToCards(vocabulary: JPDBRawVocabulary[]): JPDBCard[] {
        return vocabulary.map(([
            vid, sid, rid, spelling, reading, frequencyRank,
            partOfSpeech, meaningsChunks, meaningsPartOfSpeech,
            cardState, pitchAccent,
        ]) => ({
            vid,
            sid,
            rid,
            spelling,
            reading,
            frequencyRank,
            partOfSpeech,
            meanings: meaningsChunks.map((glosses, i) => ({
                glosses,
                partOfSpeech: meaningsPartOfSpeech[i] ?? [],
            })),
            cardState: cardState?.length ? cardState : [('not-in-deck' as JPDBCardState)],
            pitchAccent: pitchAccent ?? [],
            wordWithReading: null,
        }));
    }

    private parseTokens(rawTokens: JPDBRawToken[][], cards: JPDBCard[]): JPDBToken[][] {
        return rawTokens.map(innerTokens => {
            let lastPitchClass = '';

            return innerTokens.map(([vocabularyIndex, position, length, furigana]) => {
                const card = cards[vocabularyIndex];
                let offset = position;

                const rubies: JPDBRuby[] = furigana === null
                    ? []
                    : furigana.flatMap(part => {
                        if (typeof part === 'string') {
                            offset += part.length;
                            return [];
                        }
                        const [base, ruby] = part;
                        const start = offset;
                        const len = base.length;
                        const end = (offset = start + len);
                        return [{ text: ruby, start, end, length: len }];
                    });

                const isParticle = card.partOfSpeech.includes('prt');
                const pitchClass = isParticle ? '' : getPitchClass(card.pitchAccent, card.reading);
                lastPitchClass = pitchClass || lastPitchClass;

                const token: JPDBToken = {
                    card,
                    start: position,
                    end: position + length,
                    length,
                    rubies,
                    pitchClass: lastPitchClass,
                };

                this.assignWordWithReading(token);
                return token;
            });
        });
    }

    private assignWordWithReading(token: JPDBToken): void {
        const { card, rubies, start: offset } = token;
        if (!rubies.length) return;

        const word = card.spelling.split('');
        for (let i = rubies.length - 1; i >= 0; i--) {
            const { text, start, length } = rubies[i];
            word.splice(start - offset + length, 0, `[${text}]`);
        }
        card.wordWithReading = word.join('');
    }

    private addSentenceInfo(paragraphs: string[], tokens: JPDBToken[][]): void {
        paragraphs.forEach((paragraph, i) => {
            const tokenData = tokens[i];
            if (!tokenData) return;

            // Simple approach: each paragraph is its own sentence context
            for (const token of tokenData) {
                token.sentence = paragraph;
            }
        });
    }
}

// Singleton
export const JpdbService = new JpdbServiceImpl();
