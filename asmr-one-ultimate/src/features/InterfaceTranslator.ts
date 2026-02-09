import { CentralObserver } from '../core/CentralObserver';
import { Logger } from '../core/Utils';
import { AppStore } from '../store/AppStore';

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

    private readonly cnToJpPatterns = [
        { regex: /将于(\d{2}:\d{2})停止播放/g, replace: '$1に再生を停止します' },
        { regex: /🔥 热门作品/g, replace: '🔥 人気作品' },
        { regex: /🌟 推荐作品/g, replace: '🌟 おすすめ作品' },
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

    public enable(): void {
        if (this._enabled) return;
        this._enabled = true;
        CentralObserver.register('InterfaceTranslator', () => this.translate(), 500);
        this.translate();
        Logger.debug('[InterfaceTranslator] Enabled');
    }

    public disable(): void {
        this._enabled = false;
        CentralObserver.unregister('InterfaceTranslator');
    }

    private translate(): void {
        const translateMode = !!AppStore.getConfig('translateMode');
        const cnToJp = !!AppStore.getConfig('translateCnToJp');
        if (!translateMode && !cnToJp) return;

        const cnOnlyMode = !translateMode && cnToJp;
        const map = cnOnlyMode ? this.cnToJpMap : this.translationMap;
        const pats = cnOnlyMode ? this.cnToJpPatterns : this.patterns;

        // Narrowed selectors: removed `.q-tooltip *` (unbounded descendant match).
        // `:not([data-asmritran])` skips already-processed elements at browser engine level.
        const candidates = document.querySelectorAll(
            '.q-btn__content span:not([data-asmritran]), ' +
            '.q-notification__message:not([data-asmritran]), ' +
            '.q-card__actions .block:not([data-asmritran]), ' +
            '.q-tooltip:not([data-asmritran]), ' +
            'h2:not([data-asmritran]), ' +
            '.text-h5:not([data-asmritran])',
        );

        candidates.forEach(el => {
            const htmlEl = el as HTMLElement;

            // WeakSet check before textContent read — avoids DOM property access on re-processed elements
            if (this.processedElements.has(htmlEl)) return;

            const text = htmlEl.textContent?.trim();
            if (!text) return;

            // Direct mapping
            if (map[text]) {
                const translated = map[text];
                htmlEl.textContent = translated;
                htmlEl.dataset.asmritran = translated;
                this.processedElements.add(htmlEl);
                return;
            }

            // Pattern matching — early-exit since patterns are mutually exclusive
            let newText = text;
            let matched = false;

            for (const pattern of pats) {
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
                this.processedElements.add(htmlEl);
            }
        });
    }
}
