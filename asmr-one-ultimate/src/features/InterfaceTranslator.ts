import { CentralObserver } from '../core/CentralObserver';
import { I18n, Logger } from '../core/Utils';
import { TIMING } from '../core/Constants';
import { AppStore } from '../store/AppStore';
import { EventBus } from '../core/EventBus';

export class InterfaceTranslator {
    private static instance: InterfaceTranslator | null = null;
    private processedElements = new WeakSet<Element>();

    private readonly translationMap: Record<string, string> = {
        '取消定时': 'Cancel Timer',
        '取消': 'Cancel',
        '确定': 'OK',
        // Sort Options (CN)
        '加入时间': 'Newest',
        '发布时间': 'Release Date',
        '用户评分': 'User Rating',
        '销量排序': 'Downloads',
        '评论数': 'Reviews',
        '价格': 'Price',
        '评价排序': 'DLsite Rating',
        'R18排序': 'NSFW',
        '随机': 'Random',
        'RJ号排序': 'RJ Code',
        '排序方式': 'Sort',
        '降序': 'Descending',
        '升序': 'Ascending',
        // Sort Options (JP)
        '最新': 'Newest',
        'リリース日': 'Release Date',
        'ユーザー評価': 'User Rating',
        'ダウンロード数': 'Downloads',
        'レビュー数': 'Reviews',
        '評価': 'Rating', // Generic catch-all
        'DLsite 評価': 'DLsite Rating',
        'R18': 'NSFW',
        'ランダム': 'Random',
        'RJ コード': 'RJ Code',
        '並び替え': 'Sort',
        '降順': 'Descending',
        '昇順': 'Ascending',
    };

    /** CN → JP static map (used when translateCnToJp is on and translateMode is off) */
    private readonly cnToJpMap: Record<string, string> = {
        '取消定时': 'タイマーキャンセル',
        '取消': 'キャンセル',
        '确定': 'OK',
        '加入时间': '最新',
        '发布时间': 'リリース日',
        '用户评分': 'ユーザー評価',
        '销量排序': 'ダウンロード数',
        '评论数': 'レビュー数',
        '价格': '価格',
        '评价排序': 'DLsite 評価',
        'R18排序': 'R18',
        '随机': 'ランダム',
        'RJ号排序': 'RJ コード',
        '排序方式': '並び替え',
        '降序': '降順',
        '升序': '昇順',
    };

    /** JP → ZH static map for Chinese UI mode. */
    private readonly jpToZhMap: Record<string, string> = {
        '最新': '最新',
        'リリース日': '发布日期',
        'ユーザー評価': '用户评分',
        'ダウンロード数': '销量排序',
        'レビュー数': '评论数',
        '評価': '评分',
        'DLsite 評価': 'DLsite 评分',
        'R18': 'R18',
        'ランダム': '随机',
        'RJ コード': 'RJ号排序',
        '並び替え': '排序方式',
        '降順': '降序',
        '昇順': '升序',
    };

    private readonly cnToJpPatterns = [
        { regex: /将于(\d{2}:\d{2})停止播放/g, replace: '$1に再生を停止します' },
        { regex: /🔥 热门作品/g, replace: '🔥 人気作品' },
        { regex: /🌟 推荐作品/g, replace: '🌟 おすすめ作品' },
    ];

    private readonly jpToZhPatterns = [
        { regex: /(\d{2}:\d{2})に再生を停止します/g, replace: '将于$1停止播放' },
        { regex: /🔥 人気作品/g, replace: '🔥 热门作品' },
        { regex: /🌟 おすすめ作品/g, replace: '🌟 推荐作品' },
    ];

    private readonly patterns = [
        {
            regex: /将于(\d{2}:\d{2})停止播放/g,
            replace: 'Will stop playback at $1'
        },
        {
            regex: /(?:平均|Average): ([\d.]+)/g,
            replace: 'Average: $1'
        },
        {
            regex: /(\d)星/g,
            replace: '$1 Stars'
        },
        {
            regex: /🔥 热门作品/g,
            replace: '🔥 Popular works'
        },
        {
            regex: /🌟 推荐作品/g,
            replace: '🌟 Recommended works'
        }
    ];

    public static getInstance(): InterfaceTranslator {
        if (!InterfaceTranslator.instance) {
            InterfaceTranslator.instance = new InterfaceTranslator();
        }
        return InterfaceTranslator.instance;
    }

    private _enabled = false;
    private cleanups: Array<() => void> = [];

    public enable(): void {
        if (this._enabled) return;
        this._enabled = true;
        CentralObserver.register('InterfaceTranslator', () => this.translate(), TIMING.OBSERVER_REGISTER_DEBOUNCE_MS);
        this.cleanups.push(EventBus.on('lang:change', () => this.resetAndTranslate()));
        this.cleanups.push(EventBus.on('config:change', ({ key }) => {
            if (key === 'translateMode' || key === 'translateCnToJp') this.resetAndTranslate();
        }));
        this.translate();
        Logger.debug('[InterfaceTranslator] Enabled');
    }

    public disable(): void {
        this._enabled = false;
        CentralObserver.unregister('InterfaceTranslator');
        this.cleanups.forEach((cleanup) => cleanup());
        this.cleanups = [];
        this.resetTranslations();
    }

    private resetAndTranslate(): void {
        if (!this._enabled) return;
        this.resetTranslations();
        this.translate();
    }

    private resetTranslations(): void {
        document.querySelectorAll<HTMLElement>('[data-asmritran]').forEach((el) => {
            const source = el.dataset.asmritranSource;
            if (source && el.textContent?.trim() === el.dataset.asmritran) el.textContent = source;
            delete el.dataset.asmritran;
            delete el.dataset.asmritranSource;
            this.processedElements.delete(el);
        });
    }

    private translate(): void {
        if (!this._enabled) return;
        I18n.syncFromHost?.();
        const translateMode = !!AppStore.getConfig('translateMode');
        const cnToJp = !!AppStore.getConfig('translateCnToJp');
        if (!translateMode && !cnToJp) return;

        const cnOnlyMode = !translateMode && cnToJp;
        const uiLang = I18n.lang.toLowerCase().split('-')[0];
        const japaneseFirstEnglish = translateMode && cnToJp && uiLang === 'en';
        const map = cnOnlyMode || uiLang === 'ja'
            ? this.cnToJpMap
            : uiLang === 'zh'
                ? this.jpToZhMap
                : this.translationMap;
        const pats = cnOnlyMode || uiLang === 'ja'
            ? this.cnToJpPatterns
            : uiLang === 'zh'
                ? this.jpToZhPatterns
                : this.patterns;

        // Narrowed selectors: removed `.q-tooltip *` (unbounded descendant match).
        // Revisit processed nodes because Vue frequently reuses them with new text.
        const candidates = document.querySelectorAll(
            '.q-btn__content span, ' +
            '.q-notification__message, ' +
            '.q-card__actions .block, ' +
            '.q-tooltip, ' +
            'h2, ' +
            '.text-h5',
        );

        candidates.forEach(el => {
            const htmlEl = el as HTMLElement;

            const text = htmlEl.textContent?.trim();
            if (!text) return;
            if (this.processedElements.has(htmlEl) && htmlEl.dataset.asmritran === text) return;
            if (this.processedElements.has(htmlEl)) {
                this.processedElements.delete(htmlEl);
                delete htmlEl.dataset.asmritran;
                delete htmlEl.dataset.asmritranSource;
            }

            // Direct mapping
            if (japaneseFirstEnglish && this.cnToJpMap[text]) {
                const japanese = this.cnToJpMap[text];
                const english = this.translationMap[japanese] || this.translationMap[text];
                const translated = english && english !== japanese
                    ? `${japanese} (${english})`
                    : japanese;
                htmlEl.textContent = translated;
                htmlEl.dataset.asmritran = translated;
                htmlEl.dataset.asmritranSource = text;
                this.processedElements.add(htmlEl);
                return;
            }
            if (map[text]) {
                const translated = map[text];
                htmlEl.textContent = translated;
                htmlEl.dataset.asmritran = translated;
                htmlEl.dataset.asmritranSource = text;
                this.processedElements.add(htmlEl);
                return;
            }

            // Pattern matching — early-exit since patterns are mutually exclusive
            let newText = text;
            let matched = false;

            if (japaneseFirstEnglish) {
                for (const jpPattern of this.cnToJpPatterns) {
                    jpPattern.regex.lastIndex = 0;
                    const japanese = text.replace(jpPattern.regex, jpPattern.replace);
                    if (japanese !== text) {
                        let english = text;
                        for (const enPattern of this.patterns) {
                            enPattern.regex.lastIndex = 0;
                            const candidate = text.replace(enPattern.regex, enPattern.replace);
                            if (candidate !== text) {
                                english = candidate;
                                break;
                            }
                        }
                        newText = english && english !== text ? `${japanese} (${english})` : japanese;
                        matched = true;
                        break;
                    }
                }
            }

            for (const pattern of matched ? [] : pats) {
                pattern.regex.lastIndex = 0;
                const replaced = newText.replace(pattern.regex, pattern.replace);
                if (replaced !== newText) {
                    newText = replaced;
                    matched = true;
                    break; // Patterns are mutually exclusive
                }
            }

            if (matched) {
                htmlEl.textContent = newText;
                htmlEl.dataset.asmritran = newText;
                htmlEl.dataset.asmritranSource = text;
                this.processedElements.add(htmlEl);
            }
        });
    }
}
