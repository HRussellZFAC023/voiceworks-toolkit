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

import { type Component, markRaw, reactive } from 'vue';
import { Logger } from '../core/Utils';
import { EventBus } from '../core/EventBus';
import { CentralObserver } from '../core/CentralObserver';
import { mountApp, type MountedApp } from '../core/MountApp';
import { calculateBottomOffset, getAudioElement, syncOverflowButtonState } from '../core/DomUtils';
import { connectAudioAnalyser as connectSharedAudioAnalyser } from '../core/AudioAnalysis';
import { AppStore } from '../store/AppStore';
import type { WhisperUpdatePayload } from '../types';
import JoiBarVue from './components/JoiBar.vue';
import {
    aggregateContextScores,
    applyStopScoreMultiplier,
    applyVolumeTextAgreement,
    computeContextIntensity,
    createEmptyScores,
    pickDominantCategory,
    type ContextWindow,
    type JoiState,
    type ScoreMap,
    type SemanticCategory,
} from './joiDecisionUtils';

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
    // --- Sexual / Active context (43 patterns) ---
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
            // --- Added from h2k frequency corpus + nsfw-glossary ---
            /くちゅ|ぐちゅ|ぐちょ/i,                          // wet squelching
            /パンパン|ぱんぱん/i,                              // slapping
            /ハァハァ|はぁはぁ/i,                              // panting
            /ずぼずぼ|ズボズボ/i,                              // thrusting
            /ドクドク|どくどく/i,                              // pulsing
            /[ビヒピ][クク][ビヒピ][クク]|びくびく/i,          // trembling
            /ムラムラ|むらむら/i,                              // turned on
            /快感/i,                                          // pleasure
            /快楽/i,                                          // pleasure
            /興奮/i,                                          // arousal
            /敏感/i,                                          // sensitive
            /揉[むんで]|もみもみ/i,                           // groping
            /弄[るぶ]|いじ[るって]/i,                          // fondle
            /締め[付つ]|しめつ/i,                              // tighten
            /淫[乱語ら]|いやらし[いく]/i,                      // lewd
        ],
    },
    // --- Stop / Tease (17 patterns) ---
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
            // --- Added from nsfw-glossary + h2k ---
            /お預け|おあずけ/i,                               // denial
            /禁止/i,                                          // forbidden
            /許さな[いく]/i,                                  // won't allow
            /見るだけ|見てるだけ/i,                           // just watch
            /\b(?:forbidden|not\s*allowed|watch\s*only|look\s*(?:but\s*)?don'?t\s*touch)\b/i,
        ],
    },
    // --- Encouragement / Go (26 patterns) ---
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
            // --- Added from h2k frequency corpus + nsfw-glossary ---
            /[しシ][コこ][しシ][コこ]|しこしこ|シコシコ/i,    // stroking onomatopoeia
            /扱[いきく]|しご[いきく]/i,                       // jerk/stroke
            /欲し[いく]/i,                                    // want it
            /ゆっくり/i,                                      // slowly (pacing)
            /どんどん/i,                                      // more and more
            /もっともっと/i,                                  // more and more
            /思いっきり|おもいっきり/i,                        // with all your might
            /一気に|いっきに/i,                               // all at once
            /ちょうだい/i,                                    // give me
            /搾[っりる]|しぼ[っりる]/i,                       // squeeze/milk
            /奉仕[しして]/i,                                  // serve me
            /\b(?:squeeze|milk|service|slowly|want\s*it)\b/i,
        ],
    },
    // --- Climax (25 patterns) ---
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
            // --- Added from h2k frequency corpus + nsfw-glossary ---
            /逝[くっきかせ]|いっ[ちた]/i,                     // cum (alt kanji)
            /果て[るた]/i,                                    // climax/finish
            /発射/i,                                          // release
            /どぴゅ|びゅる|ぴゅー/i,                           // spurting onomatopoeia
            /噴[きく]出[すし]/i,                              // spurt out
            /溢[れら]|こぼ[れら]/i,                            // overflow
            /中出[しす]/i,                                    // creampie
            /カウントダウン/i,                                 // countdown
            /解放[しして]/i,                                   // release
            /\b(?:spurt|erupt|burst|overflow|countdown)\b/i,
        ],
    },
    // --- Edge / Almost (21 patterns) ---
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
            // --- Added from h2k frequency corpus + nsfw-glossary ---
            /たまらな[いく]/i,                                // can't stand it
            /我慢[でがき]きな[いく]/i,                         // can't hold back
            /止まらな[いく]/i,                                // can't stop
            /耐え[てろきれ]|たえ[きれ]/i,                     // endure
            /焦ら[しす]|じらし/i,                             // tease
            /狂[いう]そう|くるいそう/i,                        // about to go crazy
            /痺[れら]|しび[れら]/i,                            // going numb
            /\b(?:unbearable|can'?t\s*take|overwhelm|torture)\b/i,
        ],
    },
    // --- Neutral / Daily life (12 patterns) ---
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
            // --- Added for neutral balance ---
            /ただいま|おかえり/i,                              // I'm home / welcome back
            /準備[しして]|じゅんび/i,                          // preparing
            /\b(?:prepare|ready|setup|begin|start)\b/i,
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

// Volume thresholds — defaults / absolute floors (RMS 0-1 scale)
// Adaptive calibration overrides these once enough data is collected.
const VOL_QUIET = 0.015;           // Below this = silence
const VOL_MEDIUM = 0.04;           // Normal calm speech
const VOL_HIGH = 0.10;             // Elevated / excited
const VOL_PEAK = 0.20;             // Very intense

// Adaptive volume calibration
const CALIBRATION_WINDOW = 300;    // 30s at 10Hz
const CALIBRATION_MIN_SAMPLES = 50; // 5s before adaptive kicks in
const ADAPTIVE_FLOOR_RATIO = 0.30; // Adaptive thresholds never below 30% of defaults

// Fairness: state duration limits
const MAX_STOP_MS = 15_000;        // 15s max hands-off
const MAX_EDGE_MS = 25_000;        // 25s max edge
const MAX_IDLE_MS = 8_000;         // 8s max waiting at start
const MIN_GO_MS = 8_000;           // 8s minimum in go before stop/edge allowed

// Fairness: reentry cooldowns
const STOP_REENTRY_COOLDOWN_MS = 12_000;  // 12s after leaving stop
const EDGE_REENTRY_COOLDOWN_MS = 15_000;  // 15s after leaving edge

// Fairness: score modifiers
const STOP_SCORE_MULTIPLIER = 0.6; // Stop scores need 40% more to trigger

// Volume-only cum: requires sustained peak from edge + time buildup
const VOL_ONLY_CUM_MIN_EDGE_MS = 10_000; // 10s in edge before volume-only cum possible

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

interface JoiBarUiState {
    state: JoiState;
    instructionKey: string;
    contextIntensity: number;
    countdownSec: number;
}

interface JoiBarMount {
    container: HTMLElement;
    uiState: JoiBarUiState;
    mounted: MountedApp;
}

// ============================================================================
// JoiTool Class
// ============================================================================

export class JoiTool {
    private static instance: JoiTool;

    private state: JoiState = 'idle';
    private isActive = false;
    private collapsedBar: JoiBarMount | null = null;
    private expandedBar: JoiBarMount | null = null;
    private eventCleanups: (() => void)[] = [];
    private persistentCleanups: (() => void)[] = [];
    private contextWindows: ContextWindow[] = [];
    private lastTransitionAt = 0;
    private instructionIndex = 0;
    private terminalTimer: number | null = null;
    private countdownTimer: number | null = null;
    private countdownSec = 0;
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

    // Adaptive volume calibration (30s rolling window)
    private volumeCalibration: number[] = [];

    // Fairness: state timing
    private stateEnteredAt = 0;
    private lastStopExitAt = 0;
    private lastEdgeExitAt = 0;

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
        this.setupPersistentListeners();
        CentralObserver.register('joi-tool', () => {
            if (this.isActive) this.ensureUI();
        }, 800);

        // Auto-activate if "always show" is enabled
        if (AppStore.getConfig('alwaysShowJoi') && !this.isActive) {
            this.activate();
        }

        Logger.log('[JoiTool] Enabled');
    }

    public disable(): void {
        this.deactivate();
        CentralObserver.unregister('joi-tool');
        this.persistentCleanups.forEach(fn => fn());
        this.persistentCleanups = [];
        this.destroyBar(this.collapsedBar);
        this.destroyBar(this.expandedBar);
        this.collapsedBar = null;
        this.expandedBar = null;
        Logger.log('[JoiTool] Disabled');
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
        this.countdownSec = 0;
        this.volumeSmoothed = 0;
        this.volumePeak = 0;
        this.volumeHistory = [];
        this.volumeCalibration = [];
        this.stateEnteredAt = Date.now();
        this.lastStopExitAt = 0;
        this.lastEdgeExitAt = 0;

        this.ensureUI();
        this.updateDisplay();
        this.showBar();
        this.setupEventListeners();
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
                this.volumeCalibration = [];
                this.setState('idle');
                // Re-connect analyser in case audio element changed
                this.connectAudioAnalyser();
            }
        }));
    }

    /**
     * Persistent listeners that survive deactivate() — registered once in enable()
     */
    private setupPersistentListeners(): void {
        if (this.persistentCleanups.length > 0) return; // already registered

        // Toggle event from overflow menu — must persist across activate/deactivate cycles
        this.persistentCleanups.push(EventBus.on('joi:toggle', () => {
            this.toggle();
        }));

        // React to "always show" setting changes
        this.persistentCleanups.push(EventBus.on('config:change', ({ key, value }) => {
            if (key === 'alwaysShowJoi') {
                if (value && !this.isActive) this.activate();
                else if (!value && this.isActive) this.deactivate();
            }
        }));
    }

    // ------------------------------------------------------------------------
    // Audio Volume Analysis (Web Audio API)
    // ------------------------------------------------------------------------

    private connectAudioAnalyser(): void {
        const currentAudio = getAudioElement();
        if (currentAudio && this.connectedAudioEl === currentAudio && this.analyser) return;

        const connected = connectSharedAudioAnalyser({
            fftSize: 256,
            smoothingTimeConstant: 0.3,
            tag: 'JoiTool',
            requireValidSource: false,
        });
        if (!connected) {
            this.volumeAvailable = false;
            return;
        }

        this.audioCtx = connected.ctx;
        this.sourceNode = connected.source;
        this.analyser = connected.analyser;
        this.connectedAudioEl = connected.audio;
        this.volumeAvailable = true;
        Logger.debug('[JoiTool] Audio analyser connected');
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

        // Feed calibration window (30s rolling)
        this.volumeCalibration.push(raw);
        if (this.volumeCalibration.length > CALIBRATION_WINDOW) {
            this.volumeCalibration.shift();
        }

        // Evaluate combined signals periodically (every 5th sample = 2Hz)
        if (this.volumeHistory.length % 5 === 0) {
            this.evaluateCombined();
        }
    }

    /**
     * Compute adaptive volume thresholds from the calibration window.
     * Uses percentiles of the rolling 30s window so that a whispering track's
     * own dynamic range maps correctly to quiet/medium/high/peak.
     * Falls back to fixed defaults until enough data is collected.
     */
    private getAdaptiveThresholds(): { quiet: number; medium: number; high: number; peak: number } {
        if (this.volumeCalibration.length < CALIBRATION_MIN_SAMPLES) {
            return { quiet: VOL_QUIET, medium: VOL_MEDIUM, high: VOL_HIGH, peak: VOL_PEAK };
        }

        const sorted = [...this.volumeCalibration].sort((a, b) => a - b);
        const len = sorted.length;
        const pct = (p: number) => sorted[Math.min(len - 1, Math.floor(p * len))];

        const raw = {
            quiet: pct(0.15),
            medium: pct(0.45),
            high: pct(0.75),
            peak: pct(0.92),
        };

        // Enforce minimum floor at 30% of defaults to prevent degenerate thresholds
        return {
            quiet: Math.max(raw.quiet, VOL_QUIET * ADAPTIVE_FLOOR_RATIO),
            medium: Math.max(raw.medium, VOL_MEDIUM * ADAPTIVE_FLOOR_RATIO),
            high: Math.max(raw.high, VOL_HIGH * ADAPTIVE_FLOOR_RATIO),
            peak: Math.max(raw.peak, VOL_PEAK * ADAPTIVE_FLOOR_RATIO),
        };
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
        const thresh = this.getAdaptiveThresholds();

        // Calculate trend from last ~1s vs previous ~1s
        let trend = 0;
        if (h.length >= 20) {
            const recent = h.slice(-10).reduce((a, b) => a + b, 0) / 10;
            const previous = h.slice(-20, -10).reduce((a, b) => a + b, 0) / 10;
            trend = recent - previous;
        }

        // Normalize intensity to 0-1 using adaptive peak
        const intensity = Math.min(1, level / thresh.peak);

        return {
            level,
            trend,
            intensity,
            isSilent: level < thresh.quiet,
            isHigh: level > thresh.high,
            isPeak: level > thresh.peak,
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

    private scoreText(text: string): ScoreMap {
        const scores = createEmptyScores();

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
        const thresh = this.getAdaptiveThresholds();
        const timeInState = now - this.stateEnteredAt;

        // --- Fairness: state duration limits ---
        // Force transitions when a state has been held too long
        if (this.state === 'idle' && timeInState > MAX_IDLE_MS) {
            this.setState('go');
            EventBus.emit('joi:trigger', { state: 'go', keyword: 'timeout', source: 'jp' });
            return;
        }
        if (this.state === 'stop' && timeInState > MAX_STOP_MS) {
            this.setState('go');
            EventBus.emit('joi:trigger', { state: 'go', keyword: 'timeout', source: 'jp' });
            return;
        }
        if (this.state === 'edge' && timeInState > MAX_EDGE_MS) {
            this.setState('go');
            EventBus.emit('joi:trigger', { state: 'go', keyword: 'timeout', source: 'jp' });
            return;
        }

        // --- Fairness: minimum go protection ---
        // Block transitions out of go for MIN_GO_MS to guarantee stroking time
        if (this.state === 'go' && timeInState < MIN_GO_MS) {
            return;
        }

        // --- Volume-only path (works without subtitles) ---
        if (this.volumeAvailable) {
            // Transition idle → go when volume rises above quiet threshold
            if (this.state === 'idle' && vol.level > thresh.medium && !vol.isSilent) {
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
        let aggregated = aggregateContextScores(this.contextWindows, now, CONTEXT_WINDOW_SEC);

        // --- Fairness: de-boost stop scores ---
        aggregated = applyStopScoreMultiplier(aggregated, STOP_SCORE_MULTIPLIER);

        // --- Volume-text agreement: fuzzy confidence adjustments ---
        // Audio energy confirms or dampens text signals for accuracy.
        // "いく" during peak volume = real climax. During silence = just teasing.
        // "だめ" during high volume = dramatic acting. During silence = real stop.
        if (this.volumeAvailable) {
            aggregated = applyVolumeTextAgreement(aggregated, vol, this.state);
        }

        // Find dominant category
        const { dominant, maxScore } = pickDominantCategory(aggregated);

        // Neutral holdback: if neutral dominates but sexual context exists, hold state
        if (dominant === 'neutral' && aggregated.sexual > 1.0) return;

        // Below threshold: allow idle→go on light signal
        if (maxScore < CONTEXT_THRESHOLD) {
            if (this.state === 'idle' && (aggregated.sexual > 0.5 || (this.volumeAvailable && vol.level > thresh.medium))) {
                this.setState('go');
            }
            return;
        }

        // Require enough text context for non-idle transitions
        if (!hasEnoughContext && this.state !== 'idle') return;

        // Cooldown
        if (now - this.lastTransitionAt < TRANSITION_COOLDOWN_MS) return;

        // --- Fairness: reentry cooldowns ---
        // Prevent rapid cycling back into punishing states
        if (dominant === 'stop' && this.lastStopExitAt > 0 && (now - this.lastStopExitAt) < STOP_REENTRY_COOLDOWN_MS) {
            return;
        }
        if (dominant === 'edge' && this.lastEdgeExitAt > 0 && (now - this.lastEdgeExitAt) < EDGE_REENTRY_COOLDOWN_MS) {
            return;
        }

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
        const thresh = this.getAdaptiveThresholds();
        const timeInState = now - this.stateEnteredAt;

        // idle → go: any non-silent audio
        if (state === 'idle' && vol.level > thresh.medium) {
            this.setState('go');
            return;
        }

        // Minimum go protection
        if (state === 'go' && timeInState < MIN_GO_MS) return;

        // go → edge: sustained high volume with rising trend (with reentry cooldown)
        if (state === 'go' && vol.isHigh && vol.trend > 0.002 && this.volumeHistory.length >= 15) {
            if (this.lastEdgeExitAt === 0 || (now - this.lastEdgeExitAt) >= EDGE_REENTRY_COOLDOWN_MS) {
                this.setState('edge');
                return;
            }
        }

        // go → stop: sudden drop to silence (with reentry cooldown)
        if (state === 'go' && vol.isSilent && this.volumeHistory.length >= 10) {
            const recentAvg = this.volumeHistory.slice(-10).reduce((a, b) => a + b, 0) / 10;
            if (recentAvg < thresh.quiet) {
                if (this.lastStopExitAt === 0 || (now - this.lastStopExitAt) >= STOP_REENTRY_COOLDOWN_MS) {
                    this.setState('stop');
                    return;
                }
            }
        }

        // stop → go: volume picks back up
        if (state === 'stop' && vol.level > thresh.high) {
            this.setState('go');
            return;
        }

        // edge → cum: sustained peak volume after buildup in edge
        // Stricter than text path — needs 10s in edge + 60% of last 2s at peak
        if (state === 'edge' && vol.isPeak && timeInState > VOL_ONLY_CUM_MIN_EDGE_MS && this.volumeHistory.length >= 20) {
            const peakCount = this.volumeHistory.slice(-20).filter(v => v > thresh.peak).length;
            if (peakCount >= 12) { // 60% of last 2s above peak = sustained climax
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

    private evaluateContext(): void {
        this.evaluateCombined();
    }

    // ------------------------------------------------------------------------
    // State Machine
    // ------------------------------------------------------------------------

    private setState(newState: JoiState): void {
        const prevState = this.state;
        const now = Date.now();

        // Record exit timestamps for reentry cooldowns
        if (prevState === 'stop') this.lastStopExitAt = now;
        if (prevState === 'edge') this.lastEdgeExitAt = now;

        this.state = newState;
        this.lastTransitionAt = now;
        this.stateEnteredAt = now;
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
        const collapsedBar = this.collapsedBar?.container;
        if (!collapsedBar?.isConnected) return;

        const expandedBar = this.expandedBar?.container;

        const isPlayerMinimized = !!AppStore.player?.hide;

        if (isPlayerMinimized) {
            // Minimized player: collapsed bar above mini player bar (+ subs if visible)
            collapsedBar.style.display = '';

            const bottomOffset = calculateBottomOffset({
                includeJoiBar: false,
                includeVizBar: false,
            });
            collapsedBar.style.bottom = `${bottomOffset}px`;

            if (expandedBar?.isConnected) {
                expandedBar.style.display = 'none';
            }
        } else {
            // Expanded player: always show expanded bar inside the player
            collapsedBar.style.display = 'none';
            if (expandedBar?.isConnected) {
                expandedBar.style.display = '';
            }
        }
    }

    // ------------------------------------------------------------------------
    // Overflow Button State
    // ------------------------------------------------------------------------

    private syncOverflowButton(active: boolean): void {
        syncOverflowButtonState('.asmr-joi-btn', active);
    }

    // ------------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------------

    private ensureUI(): void {
        if (!this.collapsedBar?.container.isConnected) {
            this.destroyBar(this.collapsedBar);
            this.collapsedBar = this.createBar('asmr-joi-bar-collapsed');
            document.body.appendChild(this.collapsedBar.container);
            if (this.isActive) {
                this.collapsedBar.container.classList.remove('hidden');
                this.updateDisplay();
                this.updateCountdown(this.countdownSec);
            }
        }

        const player = document.querySelector('.audio-player');
        if (player && !this.expandedBar?.container.isConnected) {
            this.destroyBar(this.expandedBar);
            this.expandedBar = this.createBar('asmr-joi-bar-expanded');

            CentralObserver.withModification(() => {
                // Target the Vue container (not the element inside it) to avoid
                // inserting into Vue 3's managed DOM tree.
                const subsRoot = player.querySelector('#asmr-learner-subs-root');
                if (subsRoot) {
                    subsRoot.before(this.expandedBar!.container);
                } else {
                    const albumArt = player.querySelector('.albumart');
                    if (albumArt) {
                        albumArt.after(this.expandedBar!.container);
                    } else {
                        player.prepend(this.expandedBar!.container);
                    }
                }
            });

            if (this.isActive) {
                this.expandedBar.container.classList.remove('hidden');
                this.updateDisplay();
                this.updateCountdown(this.countdownSec);
            }
        }

        if (this.isActive) this.updatePosition();
    }

    private createBar(extraClass: string): JoiBarMount {
        const container = document.createElement('div');
        container.className = `asmr-joi-bar hidden ${extraClass}`;
        container.dataset.state = 'idle';
        container.setAttribute('role', 'status');
        container.setAttribute('aria-live', 'assertive');

        const uiState = reactive<JoiBarUiState>({
            state: this.state,
            instructionKey: INSTRUCTIONS.idle[0],
            contextIntensity: this.getContextIntensity(),
            countdownSec: this.countdownSec,
        });

        const mounted = mountApp(
            markRaw(JoiBarVue as Component),
            {
                uiState,
                onClose: () => this.deactivate(),
            },
            container
        );

        return { container, uiState, mounted };
    }

    private updateDisplay(): void {
        const instructions = INSTRUCTIONS[this.state];
        const instructionKey = instructions[this.instructionIndex % instructions.length];
        const intensity = this.getContextIntensity();

        for (const bar of this.getBarMounts()) {
            bar.container.dataset.state = this.state;
            bar.uiState.state = this.state;
            bar.uiState.instructionKey = instructionKey;
            bar.uiState.contextIntensity = intensity;
        }
    }

    private updateCountdown(sec: number): void {
        this.countdownSec = Math.max(0, sec);
        for (const bar of this.getBarMounts()) {
            bar.uiState.countdownSec = this.countdownSec;
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
        this.updateCountdown(0);
    }

    private getBars(): HTMLElement[] {
        return this.getBarMounts().map(bar => bar.container);
    }

    private getBarMounts(): JoiBarMount[] {
        const bars: JoiBarMount[] = [];
        if (this.collapsedBar?.container.isConnected) bars.push(this.collapsedBar);
        if (this.expandedBar?.container.isConnected) bars.push(this.expandedBar);
        return bars;
    }

    private destroyBar(bar: JoiBarMount | null): void {
        if (!bar) return;
        bar.mounted.unmount();
        bar.container.remove();
    }

    /**
     * Returns 0-3 indicating context intensity.
     * Now combines volume + text signals.
     */
    private getContextIntensity(): number {
        const volumeIntensity = this.volumeAvailable ? this.getVolumeDynamics().intensity : 0;
        return computeContextIntensity(this.contextWindows, volumeIntensity);
    }
}
