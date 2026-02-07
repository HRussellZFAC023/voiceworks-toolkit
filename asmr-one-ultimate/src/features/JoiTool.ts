/**
 * JoiTool - Interactive edge game synced with audio intensity + live transcription
 *
 * Primary signal: Audio volume analysis via Web Audio API AnalyserNode.
 * Secondary signal: Subtitle text semantic scoring from .learner-jp/.learner-en DOM.
 *
 * The volume monitor captures real-time emotional intensity (moaning, breathing,
 * crescendos, silence) while text scoring refines what those dynamics mean
 * (stop vs. go vs. edge vs. climax keywords).
 *
 * v3: Volume-driven with text refinement, subtitle DOM polling, no whisper:update
 *     dependency. Works even without Whisper transcription.
 */

import { Logger, I18n } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import { CentralObserver } from '../core/CentralObserver';
import { getAudioElement } from '../core/DomUtils';
import { getOrCreateSourceNode } from '../core/AudioAnalysis';
import { AppStore } from '../store/AppStore';
import type { WhisperUpdatePayload } from '../types';

// ============================================================================
// Types
// ============================================================================

type JoiState = 'idle' | 'go' | 'stop' | 'edge' | 'cum' | 'denied' | 'ruined';
type SemanticCategory = 'sexual' | 'stop' | 'encouragement' | 'climax' | 'edge' | 'neutral';

interface ContextWindow {
    text: string;
    timestamp: number;
    scores: Record<SemanticCategory, number>;
}

// ============================================================================
// Semantic Patterns (pre-compiled for hot path)
// ============================================================================

interface PatternGroup {
    category: SemanticCategory;
    compiled: RegExp[];   // Pre-compiled with global flag for match counting
    weight: number;
}

function compilePatterns(defs: Array<{ category: SemanticCategory; patterns: RegExp[]; weight: number }>): PatternGroup[] {
    return defs.map(d => ({
        category: d.category,
        weight: d.weight,
        compiled: d.patterns.map(p => {
            const flags = p.flags.includes('g') ? p.flags : p.flags + 'g';
            return new RegExp(p.source, flags);
        }),
    }));
}

const SEMANTIC_PATTERNS = compilePatterns([
    // --- Sexual / Active context ---
    {
        category: 'sexual',
        weight: 1.0,
        patterns: [
            /気持ち[いよ良]/i,
            /きもちい/i,
            /エッチ|えっち/i,
            /おちんちん|おち[ん○]ぽ|ちんぽ|ちんちん/i,
            /おっぱい|おまんこ|まんこ/i,
            /挿[入れ]|挿し/i,
            /しゃぶ[っる]|舐め[てる]|なめ[てる]/i,
            /濡れ[てる]|ぬれ[てる]/i,
            /硬[いく]|かた[いく]/i,
            /膣|ヴァギナ|アナル|クリ/i,
            /フェラ|パイズリ|手[コマ]キ|てこき|手こき/i,
            /ご奉仕|奉仕/i,
            /エロ[いな]/i,
            /変態|ヘンタイ|へんたい/i,
            /お尻|おしり/i,
            /オナ[ニホ]|おな[にほ]/i,
            /射精|しゃせい/i,
            /精[液子]|ザーメン/i,
            /喘[ぎぐ]|あえ[ぎぐ]/i,
            /感じ[てる]|かんじ[てる]/i,
            /\b(?:stroke|stroking|jerk|jerking|rub|rubbing|pump|pumping|thrust|thrusting)\b/i,
            /\b(?:cock|dick|penis|pussy|clit|nipple|breast|ass|anal)\b/i,
            /\b(?:suck|sucking|lick|licking|blow|blowjob|handjob)\b/i,
            /\b(?:horny|naughty|dirty|lewd|perverted?|slutty?)\b/i,
            /\b(?:wet|hard|throb|throbbing|erect|aroused?|arousal)\b/i,
            /\b(?:fuck|fucking|sex|orgasm|masturbat)/i,
            /\b(?:moan|moaning|groan|panting|gasping)\b/i,
        ],
    },
    // --- Stop / Tease ---
    {
        category: 'stop',
        weight: 1.5,
        patterns: [
            /だめ[だよ！]|ダメ[だよ！]/i,
            /止[めま]て|やめて|ヤメテ/i,
            /ストップ/i,
            /触[らっ]ないで|さわらないで/i,
            /動[かい]ないで|うごかないで/i,
            /離[しれ]て|はなして/i,
            /我慢し[てろな]|がまんし[てろな]/i,
            /耐え[てろ]|たえ[てろ]/i,
            /\b(?:stop|halt|freeze|hands?\s*off)\b/i,
            /\b(?:hold\s*(?:on|it|still)|pause|cease)\b/i,
            /\b(?:endure|resist|deny|denied|forbid|no\s*touching)\b/i,
            /\b(?:too\s*(?:fast|much|soon)|slow\s*down|ease\s*up)\b/i,
        ],
    },
    // --- Encouragement / Go ---
    {
        category: 'encouragement',
        weight: 1.0,
        patterns: [
            /もっと/i,
            /続けて|つづけて/i,
            /頑張[っれ]|がんば[っれ]/i,
            /いいよ[～！]*/i,
            /上手|じょうず/i,
            /速[くい]|はや[くい]/i,
            /強[くい]|つよ[くい]/i,
            /激し[くい]|はげし[くい]/i,
            /そのまま|そのペース/i,
            /いい[子こ]|偉い|えらい/i,
            /気持ちいい[よ！]/i,
            /\b(?:yes|yeah|good|faster|harder|more|keep\s*going|don'?t\s*stop)\b/i,
            /\b(?:that'?s\s*(?:it|right|good)|just\s*like\s*that|perfect)\b/i,
            /\b(?:continue|go\s*on|nice|wonderful|amazing)\b/i,
        ],
    },
    // --- Climax ---
    {
        category: 'climax',
        weight: 2.0,
        patterns: [
            /[いイ][くっ][よ！ぅ]|いくいく|イクイク/i,
            /[いイ]っちゃ[うぅ]/i,
            /出[しす][てちゃ]|だし[てちゃ]/i,
            /射精[しして]/i,
            /中[にで]出[しす]/i,
            /[いイ][かっ]せて/i,
            /絶頂|ぜっちょう/i,
            /アクメ/i,
            /[いイ]って[もな]?いい/i,
            /出して[もな]?いい/i,
            /[いイ]っても/i,
            /\b(?:cum|cumming|cum\s*now|release|finish|let\s*it\s*(?:out|go))\b/i,
            /\b(?:climax|orgasm|coming)\b/i,
            /\b(?:shoot|squirt|explode)\b/i,
            /\b(?:you\s*(?:can|may)\s*cum|permission)\b/i,
        ],
    },
    // --- Edge / Almost ---
    {
        category: 'edge',
        weight: 1.3,
        patterns: [
            /もうすぐ/i,
            /[いイ]きそう/i,
            /ギリギリ|ぎりぎり/i,
            /限界|げんかい/i,
            /寸止[めま]/i,
            /あと[少ちょっ]/i,
            /危[ないな]|あぶな[いな]/i,
            /我慢[でできの]き/i,
            /まだ[だよ]|まだまだ/i,
            /待って|まって/i,
            /\b(?:edge|edging|almost|close|about\s*to|nearly|brink)\b/i,
            /\b(?:hold\s*it|right\s*there|don'?t\s*cum|not\s*yet)\b/i,
            /\b(?:tease|teasing|denial|so\s*close)\b/i,
        ],
    },
    // --- Neutral / Daily life ---
    {
        category: 'neutral',
        weight: 0.5,
        patterns: [
            /おはよう|こんにちは|こんばんは/i,
            /食べ[るてた]|飲[むんだ]|料理/i,
            /天気|雨|晴[れ]|寒[い]|暑[い]/i,
            /仕事|学校|勉強/i,
            /お風呂|ご飯/i,
            /買い物|散歩|旅行/i,
            /\b(?:hello|hi|good\s*(?:morning|evening|night))\b/i,
            /\b(?:eat|drink|cook|food|weather|rain|work|school|study)\b/i,
            /\b(?:walk|shop|trip|meal|sleep)\b/i,
        ],
    },
]);

// ============================================================================
// Constants
// ============================================================================

const CONTEXT_THRESHOLD = 2.5;
const CONTEXT_WINDOW_SEC = 15;
const TRANSITION_COOLDOWN_MS = 3000;
const TERMINAL_STATE_DURATION_MS = 6000;
const MIN_CONTEXT_DEPTH = 2;
const POSITION_POLL_MS = 500;

// Volume analysis
const VOLUME_POLL_MS = 100;        // 10 Hz volume sampling
const VOLUME_SMOOTHING = 0.15;     // EMA alpha (0 = no smoothing, 1 = instant)
const SUBTITLE_POLL_MS = 1500;     // 0.67 Hz subtitle DOM polling

// Volume thresholds (RMS 0-1 scale, typical speech is 0.02-0.15)
const VOL_QUIET = 0.015;           // Below this = silence
const VOL_MEDIUM = 0.04;           // Normal calm speech
const VOL_HIGH = 0.10;             // Elevated / excited
const VOL_PEAK = 0.20;             // Very intense

// ============================================================================
// State transition rules
// ============================================================================

const TRANSITIONS: Partial<Record<JoiState, Partial<Record<SemanticCategory, JoiState>>>> = {
    idle: {
        sexual: 'go',
        encouragement: 'go',
    },
    go: {
        stop: 'stop',
        edge: 'edge',
        climax: 'edge',       // go→edge first, not direct to cum
    },
    stop: {
        sexual: 'go',
        encouragement: 'go',
        edge: 'edge',
    },
    edge: {
        climax: 'cum',        // edge→cum is the only path to cum
        stop: 'denied',       // edge + stop = denial
        encouragement: 'go',  // encouraged off edge = back to go
    },
    // cum, denied, ruined are terminal - they auto-reset via timer
};

const INSTRUCTIONS: Record<JoiState, string[]> = {
    idle: ['joiIdle'],
    go: ['joiGoSlow', 'joiGoFast', 'joiGoGentle', 'joiGoSlow', 'joiGoFast'],
    stop: ['joiStopHands', 'joiStopWait', 'joiStopBreathe', 'joiStopWait'],
    edge: ['joiEdgeClose', 'joiEdgeHold', 'joiEdgeDanger', 'joiEdgeClose'],
    cum: ['joiCumNow'],
    denied: ['joiDeniedMsg'],
    ruined: ['joiRuinedMsg'],
};

// ============================================================================
// JoiTool Class
// ============================================================================

export class JoiTool {
    private static instance: JoiTool;

    private state: JoiState = 'idle';
    private isActive = false;
    private barEl: HTMLElement | null = null;
    private expandedBarEl: HTMLElement | null = null;
    private eventCleanups: (() => void)[] = [];
    private contextWindows: ContextWindow[] = [];
    private lastTransitionAt = 0;
    private instructionIndex = 0;
    private terminalTimer: number | null = null;
    private countdownTimer: number | null = null;
    private positionPollId: number | null = null;
    private lastSubtitleText = '';
    private isPaused = false;

    // Volume analysis state
    private audioCtx: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private sourceNode: MediaElementAudioSourceNode | null = null;
    private volumePollId: number | null = null;
    private subtitlePollId: number | null = null;
    private volumeSmoothed = 0;
    private volumePeak = 0;
    private volumeHistory: number[] = [];       // last ~3s of RMS samples
    private volumeAvailable = false;            // false if cross-origin blocks analyser
    private connectedAudioEl: HTMLAudioElement | null = null;

    private constructor() {}

    public static getInstance(): JoiTool {
        if (!JoiTool.instance) {
            JoiTool.instance = new JoiTool();
        }
        return JoiTool.instance;
    }

    // ------------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------------

    public enable(): void {
        this.setupEventListeners();
        CentralObserver.register('joi-tool', () => {
            if (this.isActive) this.ensureUI();
        }, 800);
        Logger.log('[JoiTool] Enabled');
    }

    public toggle(): void {
        if (this.isActive) {
            this.deactivate();
        } else {
            this.activate();
        }
    }

    public get active(): boolean {
        return this.isActive;
    }

    // ------------------------------------------------------------------------
    // Activation / Deactivation
    // ------------------------------------------------------------------------

    private activate(): void {
        this.isActive = true;
        this.state = 'idle';
        this.contextWindows = [];
        this.lastTransitionAt = 0;
        this.instructionIndex = 0;
        this.lastSubtitleText = '';
        this.isPaused = false;
        this.volumeSmoothed = 0;
        this.volumePeak = 0;
        this.volumeHistory = [];

        this.ensureUI();
        this.updateDisplay();
        this.showBar();
        this.startPositionPolling();
        this.syncPauseState();
        this.connectAudioAnalyser();
        this.startVolumePolling();
        this.startSubtitlePolling();

        // Bootstrap: seed context from existing subtitle text
        this.pollSubtitleText();

        this.syncOverflowButton(true);
        Logger.log('[JoiTool] Activated');
    }

    private deactivate(): void {
        this.isActive = false;
        this.state = 'idle';
        this.contextWindows = [];
        this.clearTimers();
        this.stopPositionPolling();
        this.stopVolumePolling();
        this.stopSubtitlePolling();
        this.hideBar();
        this.syncOverflowButton(false);
        CentralObserver.unregister('joi-tool');
        this.eventCleanups.forEach(fn => fn());
        this.eventCleanups = [];
        Logger.log('[JoiTool] Deactivated');
    }

    // ------------------------------------------------------------------------
    // Event Listeners
    // ------------------------------------------------------------------------

    private setupEventListeners(): void {
        // Whisper updates: supplementary text input (when available)
        this.eventCleanups.push(EventBus.on('whisper:update', (payload) => {
            if (this.isActive && !this.isPaused) this.processWhisperUpdate(payload);
        }));

        // Translated segments: re-evaluate context
        this.eventCleanups.push(EventBus.on('whisper:segment-translated', () => {
            if (this.isActive && !this.isPaused) this.evaluateContext();
        }));

        // Reset on track change
        this.eventCleanups.push(EventBus.on('track:change', () => {
            if (this.isActive) {
                this.contextWindows = [];
                this.lastSubtitleText = '';
                this.volumeSmoothed = 0;
                this.volumePeak = 0;
                this.volumeHistory = [];
                this.setState('idle');
                // Re-connect analyser in case audio element changed
                this.connectAudioAnalyser();
            }
        }));

        // Toggle event from overflow menu
        this.eventCleanups.push(EventBus.on('joi:toggle', () => {
            this.toggle();
        }));
    }

    // ------------------------------------------------------------------------
    // Audio Volume Analysis (Web Audio API)
    // ------------------------------------------------------------------------

    private connectAudioAnalyser(): void {
        const audio = getAudioElement();
        if (!audio) {
            Logger.debug('[JoiTool] No audio element found for volume analysis');
            this.volumeAvailable = false;
            return;
        }

        // Already connected to this element
        if (this.connectedAudioEl === audio && this.analyser) return;

        const result = getOrCreateSourceNode(audio);
        if (!result) {
            Logger.debug('[JoiTool] Audio analyser failed (cross-origin?), using text-only mode');
            this.volumeAvailable = false;
            return;
        }

        try {
            this.audioCtx = result.ctx;
            this.sourceNode = result.source;

            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.3;
            this.sourceNode.connect(this.analyser);

            this.connectedAudioEl = audio;
            this.volumeAvailable = true;
            Logger.debug('[JoiTool] Audio analyser connected');
        } catch (err) {
            Logger.debug('[JoiTool] Audio analyser failed:', err);
            this.volumeAvailable = false;
        }
    }

    private sampleVolume(): number {
        if (!this.analyser || !this.volumeAvailable) return 0;

        const data = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteTimeDomainData(data);

        // Calculate RMS (root mean square) amplitude
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128; // normalize to -1..1
            sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);

        // If RMS is exactly 0 for multiple samples, cross-origin is blocking data
        if (rms === 0 && this.volumeHistory.length > 20) {
            const allZero = this.volumeHistory.slice(-20).every(v => v === 0);
            if (allZero) {
                this.volumeAvailable = false;
                Logger.debug('[JoiTool] Volume data blocked (cross-origin), falling back to text-only');
            }
        }

        return rms;
    }

    private startVolumePolling(): void {
        this.stopVolumePolling();
        this.volumePollId = window.setInterval(() => {
            if (!this.isActive || this.isPaused) return;
            this.processVolumeSample();
        }, VOLUME_POLL_MS);
    }

    private stopVolumePolling(): void {
        if (this.volumePollId !== null) {
            clearInterval(this.volumePollId);
            this.volumePollId = null;
        }
    }

    private processVolumeSample(): void {
        // If analyser not connected yet, try again
        if (!this.analyser && !this.volumeAvailable) {
            this.connectAudioAnalyser();
        }

        const raw = this.sampleVolume();

        // Exponential moving average for smoothing
        this.volumeSmoothed = this.volumeSmoothed * (1 - VOLUME_SMOOTHING) + raw * VOLUME_SMOOTHING;

        // Track peak (slow decay)
        if (raw > this.volumePeak) {
            this.volumePeak = raw;
        } else {
            this.volumePeak *= 0.995; // slow decay
        }

        // Keep ~3s of history (30 samples at 10Hz)
        this.volumeHistory.push(this.volumeSmoothed);
        if (this.volumeHistory.length > 30) {
            this.volumeHistory.shift();
        }

        // Evaluate combined signals periodically (every 5th sample = 2Hz)
        if (this.volumeHistory.length % 5 === 0) {
            this.evaluateCombined();
        }
    }

    /**
     * Get volume dynamics for the current moment.
     * Returns an object describing the audio energy.
     */
    private getVolumeDynamics(): {
        level: number;        // current smoothed RMS
        trend: number;        // positive = rising, negative = falling
        intensity: number;    // 0-1 normalized intensity
        isSilent: boolean;
        isHigh: boolean;
        isPeak: boolean;
    } {
        const level = this.volumeSmoothed;
        const h = this.volumeHistory;

        // Calculate trend from last ~1s vs previous ~1s
        let trend = 0;
        if (h.length >= 20) {
            const recent = h.slice(-10).reduce((a, b) => a + b, 0) / 10;
            const previous = h.slice(-20, -10).reduce((a, b) => a + b, 0) / 10;
            trend = recent - previous;
        }

        // Normalize intensity to 0-1
        const intensity = Math.min(1, level / VOL_PEAK);

        return {
            level,
            trend,
            intensity,
            isSilent: level < VOL_QUIET,
            isHigh: level > VOL_HIGH,
            isPeak: level > VOL_PEAK,
        };
    }

    // ------------------------------------------------------------------------
    // Subtitle DOM Polling
    // ------------------------------------------------------------------------

    private startSubtitlePolling(): void {
        this.stopSubtitlePolling();
        this.subtitlePollId = window.setInterval(() => {
            if (!this.isActive || this.isPaused) return;
            this.pollSubtitleText();
        }, SUBTITLE_POLL_MS);
    }

    private stopSubtitlePolling(): void {
        if (this.subtitlePollId !== null) {
            clearInterval(this.subtitlePollId);
            this.subtitlePollId = null;
        }
    }

    private pollSubtitleText(): void {
        const jpEls = document.querySelectorAll('.learner-jp');
        const enEls = document.querySelectorAll('.learner-en');

        let text = '';
        jpEls.forEach(el => { if (el.textContent) text += ' ' + el.textContent; });
        enEls.forEach(el => { if (el.textContent) text += ' ' + el.textContent; });
        text = text.trim();

        if (!text || text === this.lastSubtitleText) return;
        this.lastSubtitleText = text;

        const now = Date.now();
        const scores = this.scoreText(text);

        this.contextWindows.push({ text, timestamp: now, scores });

        // Prune old windows
        const cutoff = now - (CONTEXT_WINDOW_SEC * 1000);
        this.contextWindows = this.contextWindows.filter(w => w.timestamp > cutoff);

        // Text change triggers evaluation
        this.evaluateCombined();
    }

    // ------------------------------------------------------------------------
    // Audio Pause Awareness
    // ------------------------------------------------------------------------

    private syncPauseState(): void {
        const audio = getAudioElement();
        if (!audio) return;

        const onPause = () => {
            if (!this.isActive) return;
            this.isPaused = true;
            this.updatePausedVisual();
        };
        const onPlay = () => {
            if (!this.isActive) return;
            this.isPaused = false;
            this.updatePausedVisual();
            // Resume audio context if suspended
            if (this.audioCtx?.state === 'suspended') {
                this.audioCtx.resume().catch(() => {});
            }
        };

        audio.addEventListener('pause', onPause);
        audio.addEventListener('play', onPlay);

        this.isPaused = audio.paused;
        this.updatePausedVisual();

        this.eventCleanups.push(() => {
            audio.removeEventListener('pause', onPause);
            audio.removeEventListener('play', onPlay);
        });
    }

    private updatePausedVisual(): void {
        for (const bar of this.getBars()) {
            bar.classList.toggle('asmr-joi-paused', this.isPaused);
        }
    }

    // ------------------------------------------------------------------------
    // Whisper Processing (supplementary)
    // ------------------------------------------------------------------------

    private processWhisperUpdate(payload: WhisperUpdatePayload): void {
        if (!payload.segments?.length && !payload.text) return;

        const now = Date.now();
        const audio = getAudioElement();
        const audioTime = audio?.currentTime || 0;

        let currentText = '';
        if (payload.segments?.length) {
            const relevantSegments = payload.segments.filter(s =>
                Math.abs(s.start - audioTime) < CONTEXT_WINDOW_SEC ||
                (s.start <= audioTime && s.end >= audioTime)
            );
            currentText = relevantSegments.map(s => s.text).join(' ');
        }
        if (!currentText) {
            currentText = payload.text || '';
        }
        if (!currentText.trim()) return;

        const scores = this.scoreText(currentText);
        this.contextWindows.push({ text: currentText, timestamp: now, scores });

        const cutoff = now - (CONTEXT_WINDOW_SEC * 1000);
        this.contextWindows = this.contextWindows.filter(w => w.timestamp > cutoff);

        this.evaluateCombined();
    }

    // ------------------------------------------------------------------------
    // Semantic Scoring
    // ------------------------------------------------------------------------

    private scoreText(text: string): Record<SemanticCategory, number> {
        const scores: Record<SemanticCategory, number> = {
            sexual: 0, stop: 0, encouragement: 0, climax: 0, edge: 0, neutral: 0,
        };

        for (const group of SEMANTIC_PATTERNS) {
            let matchCount = 0;
            for (const re of group.compiled) {
                re.lastIndex = 0;
                const matches = text.match(re);
                if (matches) matchCount += matches.length;
            }
            scores[group.category] += matchCount * group.weight;
        }

        return scores;
    }

    // ------------------------------------------------------------------------
    // Combined Evaluation (Volume + Text)
    // ------------------------------------------------------------------------

    /**
     * Core decision engine. Merges volume dynamics with text semantic scores
     * to determine state transitions.
     *
     * Volume provides the "energy" signal:
     *   - Rising volume → something is happening → boost go/edge scores
     *   - Peak volume → climax territory
     *   - Silence/drop → stop/edge/denied territory
     *
     * Text provides the "intent" signal:
     *   - Keywords refine WHAT the volume change means
     *   - "だめ" + high volume = stop/denial, not go
     *   - "いく" + rising volume = climax, not just encouragement
     */
    private evaluateCombined(): void {
        if (!this.isActive) return;

        const now = Date.now();
        const vol = this.getVolumeDynamics();

        // --- Volume-only path (works without subtitles) ---
        if (this.volumeAvailable) {
            // Transition idle → go when volume rises above quiet threshold
            if (this.state === 'idle' && vol.level > VOL_MEDIUM && !vol.isSilent) {
                if (now - this.lastTransitionAt > TRANSITION_COOLDOWN_MS) {
                    this.setState('go');
                    EventBus.emit('joi:trigger', { state: 'go', keyword: 'volume', source: 'jp' });
                    return;
                }
            }
        }

        // --- Text scoring (from subtitle polling + whisper events) ---
        if (this.contextWindows.length === 0) {
            // No text at all — use volume-only heuristics
            if (this.volumeAvailable) {
                this.evaluateVolumeOnly(vol, now);
            }
            return;
        }

        const hasEnoughContext = this.contextWindows.length >= MIN_CONTEXT_DEPTH;

        // Aggregate text scores
        const aggregated: Record<SemanticCategory, number> = {
            sexual: 0, stop: 0, encouragement: 0, climax: 0, edge: 0, neutral: 0,
        };
        for (const w of this.contextWindows) {
            const age = (now - w.timestamp) / 1000;
            const recency = Math.max(0.2, 1 - (age / CONTEXT_WINDOW_SEC));
            for (const cat of Object.keys(w.scores) as SemanticCategory[]) {
                aggregated[cat] += w.scores[cat] * recency;
            }
        }

        // --- Volume boost: amplify text scores based on audio energy ---
        if (this.volumeAvailable && vol.level > VOL_QUIET) {
            const volBoost = 1 + vol.intensity * 2; // 1x at silence → 3x at peak
            // Boost sexual/climax/edge/encouragement proportional to volume
            aggregated.sexual *= volBoost;
            aggregated.climax *= volBoost;
            aggregated.edge *= volBoost;
            aggregated.encouragement *= volBoost;

            // Volume trend modifiers
            if (vol.trend > 0.005) {
                // Rising volume → boost climax/edge
                aggregated.climax += vol.trend * 20;
                aggregated.edge += vol.trend * 15;
            }
            if (vol.isPeak) {
                // At peak volume → strong climax signal
                aggregated.climax += 1.5;
            }
            if (vol.isSilent && this.state === 'go') {
                // Sudden silence during go → could be a tease
                aggregated.stop += 0.5;
            }
        }

        // Find dominant category
        let dominant: SemanticCategory = 'neutral';
        let maxScore = 0;
        for (const cat of Object.keys(aggregated) as SemanticCategory[]) {
            if (aggregated[cat] > maxScore) {
                maxScore = aggregated[cat];
                dominant = cat;
            }
        }

        // Neutral holdback: if neutral dominates but sexual context exists, hold state
        if (dominant === 'neutral' && aggregated.sexual > 1.0) return;

        // Below threshold: allow idle→go on light signal
        if (maxScore < CONTEXT_THRESHOLD) {
            if (this.state === 'idle' && (aggregated.sexual > 0.5 || (this.volumeAvailable && vol.level > VOL_MEDIUM))) {
                this.setState('go');
            }
            return;
        }

        // Require enough text context for non-idle transitions
        if (!hasEnoughContext && this.state !== 'idle') return;

        // Cooldown
        if (now - this.lastTransitionAt < TRANSITION_COOLDOWN_MS) return;

        // Constrained transition
        const allowedTransitions = TRANSITIONS[this.state];
        if (!allowedTransitions) return;

        const nextState = allowedTransitions[dominant];
        if (nextState && nextState !== this.state) {
            this.setState(nextState);
            EventBus.emit('joi:trigger', { state: nextState, keyword: dominant, source: 'jp' });
        }
    }

    /**
     * Volume-only heuristics when no subtitle text is available.
     * Less accurate but keeps the game moving based on audio energy alone.
     */
    private evaluateVolumeOnly(vol: ReturnType<typeof JoiTool.prototype.getVolumeDynamics>, now: number): void {
        if (now - this.lastTransitionAt < TRANSITION_COOLDOWN_MS) return;

        const state = this.state;

        // idle → go: any non-silent audio
        if (state === 'idle' && vol.level > VOL_MEDIUM) {
            this.setState('go');
            return;
        }

        // go → edge: sustained high volume with rising trend
        if (state === 'go' && vol.isHigh && vol.trend > 0.002 && this.volumeHistory.length >= 15) {
            this.setState('edge');
            return;
        }

        // go → stop: sudden drop to silence (tease)
        if (state === 'go' && vol.isSilent && this.volumeHistory.length >= 10) {
            const recentAvg = this.volumeHistory.slice(-10).reduce((a, b) => a + b, 0) / 10;
            if (recentAvg < VOL_QUIET) {
                this.setState('stop');
                return;
            }
        }

        // stop → go: volume picks back up
        if (state === 'stop' && vol.level > VOL_HIGH) {
            this.setState('go');
            return;
        }

        // edge → cum: peak volume sustained
        if (state === 'edge' && vol.isPeak && this.volumeHistory.length >= 10) {
            const peakCount = this.volumeHistory.slice(-10).filter(v => v > VOL_PEAK).length;
            if (peakCount >= 5) { // 5 out of last 10 samples above peak
                this.setState('cum');
                return;
            }
        }

        // edge → denied: sudden drop from high
        if (state === 'edge' && vol.isSilent) {
            this.setState('denied');
            return;
        }
    }

    // ------------------------------------------------------------------------
    // Legacy evaluateContext (kept for whisper:segment-translated)
    // ------------------------------------------------------------------------

    private evaluateContext(): void {
        this.evaluateCombined();
    }

    // ------------------------------------------------------------------------
    // State Machine
    // ------------------------------------------------------------------------

    private setState(newState: JoiState): void {
        const prevState = this.state;
        this.state = newState;
        this.lastTransitionAt = Date.now();
        this.instructionIndex = 0;
        this.clearTimers();

        Logger.debug(`[JoiTool] ${prevState} → ${newState}`);

        // Flash animation on transition
        if (prevState !== newState) {
            for (const bar of this.getBars()) {
                bar.classList.remove('asmr-joi-flash');
                void bar.offsetWidth;
                bar.classList.add('asmr-joi-flash');
            }
        }

        // Terminal states auto-reset
        if (newState === 'cum' || newState === 'denied' || newState === 'ruined') {
            let countdown = TERMINAL_STATE_DURATION_MS / 1000;
            this.updateCountdown(countdown);

            this.countdownTimer = window.setInterval(() => {
                countdown--;
                if (countdown > 0) {
                    this.updateCountdown(countdown);
                } else {
                    this.clearTimers();
                    this.updateCountdown(0);
                    this.setState('go');
                }
            }, 1000);

            this.terminalTimer = window.setTimeout(() => {
                this.clearTimers();
                this.updateCountdown(0);
                if (this.state === newState) this.setState('go');
            }, TERMINAL_STATE_DURATION_MS + 500);
        }

        // Instruction cycling
        if (newState === 'edge') {
            this.countdownTimer = window.setInterval(() => {
                this.instructionIndex = (this.instructionIndex + 1) % INSTRUCTIONS.edge.length;
                this.updateDisplay();
            }, 1800);
        }
        if (newState === 'go') {
            this.countdownTimer = window.setInterval(() => {
                this.instructionIndex = (this.instructionIndex + 1) % INSTRUCTIONS.go.length;
                this.updateDisplay();
            }, 3500);
        }
        if (newState === 'stop') {
            this.countdownTimer = window.setInterval(() => {
                this.instructionIndex = (this.instructionIndex + 1) % INSTRUCTIONS.stop.length;
                this.updateDisplay();
            }, 2500);
        }

        this.updateDisplay();
    }

    private clearTimers(): void {
        if (this.terminalTimer !== null) {
            clearTimeout(this.terminalTimer);
            this.terminalTimer = null;
        }
        if (this.countdownTimer !== null) {
            clearInterval(this.countdownTimer);
            this.countdownTimer = null;
        }
    }

    // ------------------------------------------------------------------------
    // Dynamic Positioning
    // ------------------------------------------------------------------------

    private startPositionPolling(): void {
        this.stopPositionPolling();
        this.updatePosition();
        this.positionPollId = window.setInterval(() => this.updatePosition(), POSITION_POLL_MS);
    }

    private stopPositionPolling(): void {
        if (this.positionPollId !== null) {
            clearInterval(this.positionPollId);
            this.positionPollId = null;
        }
    }

    private updatePosition(): void {
        if (!this.barEl?.isConnected) return;

        const isPlayerMinimized = !!AppStore.state?.player?.hide ||
            !!AppStore.player?.hide;

        if (isPlayerMinimized) {
            // Minimized player: collapsed bar above mini player bar (+ subs if visible)
            this.barEl.style.display = '';

            const subsBar = document.querySelector('body > .learner-subs-collapsed') as HTMLElement | null;
            const playerBar = document.querySelector('.q-footer, .player-bar-container') as HTMLElement | null;

            let bottomOffset = playerBar?.offsetHeight || 60;

            // Stack above collapsed subs if truly visible (not opacity-hidden)
            if (subsBar && subsBar.style.display !== 'none' && !subsBar.classList.contains('hidden') && subsBar.offsetHeight > 0) {
                bottomOffset += subsBar.offsetHeight;
            }

            this.barEl.style.bottom = `${bottomOffset}px`;

            if (this.expandedBarEl?.isConnected) {
                this.expandedBarEl.style.display = 'none';
            }
        } else {
            // Expanded player: always show expanded bar inside the player
            this.barEl.style.display = 'none';
            if (this.expandedBarEl?.isConnected) {
                this.expandedBarEl.style.display = '';
            }
        }
    }

    // ------------------------------------------------------------------------
    // Overflow Button State
    // ------------------------------------------------------------------------

    private syncOverflowButton(active: boolean): void {
        const btns = document.querySelectorAll('.asmr-joi-btn');
        btns.forEach(btn => {
            const icon = btn.querySelector('.material-icons');
            if (icon) {
                icon.classList.toggle('asmr-accent', active);
            }
            btn.classList.toggle('learner-btn-active', active);
        });
    }

    // ------------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------------

    private ensureUI(): void {
        if (!this.barEl || !this.barEl.isConnected) {
            this.barEl?.remove();
            this.barEl = this.createBar('asmr-joi-bar-collapsed');
            document.body.appendChild(this.barEl);
            if (this.isActive) {
                this.barEl.classList.remove('hidden');
                this.updateDisplay();
            }
        }

        const player = document.querySelector('.audio-player');
        if (player && (!this.expandedBarEl || !this.expandedBarEl.isConnected)) {
            this.expandedBarEl?.remove();
            this.expandedBarEl = this.createBar('asmr-joi-bar-expanded');

            CentralObserver.withModification(() => {
                // Target the Vue container (not the element inside it) to avoid
                // inserting into Vue 3's managed DOM tree.
                const subsRoot = player.querySelector('#asmr-learner-subs-root');
                if (subsRoot) {
                    subsRoot.before(this.expandedBarEl!);
                } else {
                    const albumArt = player.querySelector('.albumart');
                    if (albumArt) {
                        albumArt.after(this.expandedBarEl!);
                    } else {
                        player.prepend(this.expandedBarEl!);
                    }
                }
            });

            if (this.isActive) {
                this.expandedBarEl.classList.remove('hidden');
                this.updateDisplay();
            }
        }

        if (this.isActive) this.updatePosition();
    }

    private createBar(extraClass: string): HTMLElement {
        const bar = document.createElement('div');
        bar.className = `asmr-joi-bar hidden ${extraClass}`;
        bar.dataset.state = 'idle';
        bar.setAttribute('role', 'status');
        bar.setAttribute('aria-live', 'assertive');

        bar.innerHTML = `
            <div class="asmr-joi-status">
                <span class="asmr-joi-label">${I18n.t('joiIdle')}</span>
            </div>
            <div class="asmr-joi-instruction"></div>
            <div class="asmr-joi-context">
                <span class="asmr-joi-context-dot"></span>
                <span class="asmr-joi-context-dot"></span>
                <span class="asmr-joi-context-dot"></span>
            </div>
            <div class="asmr-joi-countdown"></div>
            <div class="asmr-joi-progress">
                <div class="asmr-joi-ring"></div>
            </div>
            <button class="asmr-joi-close" title="${I18n.t('joiToggle')}">
                <i class="material-icons" aria-hidden="true">close</i>
            </button>
        `;

        bar.querySelector('.asmr-joi-close')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.deactivate();
        });

        return bar;
    }

    private updateDisplay(): void {
        const stateLabels: Record<JoiState, string> = {
            idle: 'joiIdle',
            go: 'joiGo',
            stop: 'joiStop',
            edge: 'joiEdge',
            cum: 'joiCum',
            denied: 'joiDenied',
            ruined: 'joiRuined',
        };

        const instructions = INSTRUCTIONS[this.state];
        const instructionKey = instructions[this.instructionIndex % instructions.length];

        for (const bar of this.getBars()) {
            bar.dataset.state = this.state;

            const label = bar.querySelector('.asmr-joi-label');
            if (label) label.textContent = I18n.t(stateLabels[this.state]);

            const instruction = bar.querySelector('.asmr-joi-instruction');
            if (instruction) {
                (instruction as HTMLElement).textContent = I18n.t(instructionKey);
            }

            const dots = bar.querySelectorAll('.asmr-joi-context-dot');
            const intensity = this.getContextIntensity();
            dots.forEach((dot, i) => {
                dot.classList.toggle('active', i < intensity);
            });
        }
    }

    private updateCountdown(sec: number): void {
        for (const bar of this.getBars()) {
            const el = bar.querySelector('.asmr-joi-countdown') as HTMLElement;
            if (!el) continue;
            if (sec > 0) {
                el.textContent = I18n.format('joiResuming', { sec });
                el.style.display = '';
            } else {
                el.textContent = '';
                el.style.display = 'none';
            }
        }
    }

    private showBar(): void {
        for (const bar of this.getBars()) {
            bar.classList.remove('hidden');
        }
    }

    private hideBar(): void {
        for (const bar of this.getBars()) {
            bar.classList.add('hidden');
        }
        for (const bar of this.getBars()) {
            const el = bar.querySelector('.asmr-joi-countdown') as HTMLElement;
            if (el) { el.textContent = ''; el.style.display = 'none'; }
        }
    }

    private getBars(): HTMLElement[] {
        const bars: HTMLElement[] = [];
        if (this.barEl?.isConnected) bars.push(this.barEl);
        if (this.expandedBarEl?.isConnected) bars.push(this.expandedBarEl);
        return bars;
    }

    /**
     * Returns 0-3 indicating context intensity.
     * Now combines volume + text signals.
     */
    private getContextIntensity(): number {
        let total = 0;

        // Text signal
        for (const w of this.contextWindows) {
            total += w.scores.sexual + w.scores.climax * 1.5 + w.scores.edge;
        }

        // Volume signal boost
        if (this.volumeAvailable) {
            const vol = this.getVolumeDynamics();
            total += vol.intensity * 5; // volume contributes up to 5 points
        }

        if (total > 8) return 3;
        if (total > 4) return 2;
        if (total > 1.5) return 1;
        return 0;
    }
}
