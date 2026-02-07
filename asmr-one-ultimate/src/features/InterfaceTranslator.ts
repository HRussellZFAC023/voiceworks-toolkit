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

    public enable(): void {
        if (!AppStore.getConfig('translateMode')) {
            Logger.debug('[InterfaceTranslator] Translation disabled by config, skipping');
            return;
        }
        CentralObserver.register('InterfaceTranslator', () => this.translate(), 500);
        this.translate();
        Logger.debug('[InterfaceTranslator] Enabled');
    }

    private translate(): void {
        // Targeted selectors for efficiency
        const candidates = document.querySelectorAll('.q-btn__content span, .q-notification__message, .q-card__actions .block, .q-tooltip, .q-tooltip *, h2, .text-h5');

        candidates.forEach(el => {
            const htmlEl = el as HTMLElement;
            const text = htmlEl.textContent?.trim();
            if (!text) return;

            // Content-aware check: skip if we already processed this exact text on this element
            if (this.processedElements.has(htmlEl) && htmlEl.dataset.asmritran === text) return;

            // Direct mapping
            if (this.translationMap[text]) {
                const translated = this.translationMap[text];
                htmlEl.textContent = translated;
                htmlEl.dataset.asmritran = translated;
                this.processedElements.add(htmlEl);
                return;
            }

            // Pattern matching - apply ALL matching patterns
            let newText = text;
            let matched = false;

            for (const pattern of this.patterns) {
                // Reset lastIndex — /g regexes are stateful and test() advances it,
                // causing alternating match/miss on subsequent calls.
                pattern.regex.lastIndex = 0;

                if (pattern.regex.test(newText)) {
                    pattern.regex.lastIndex = 0;
                    newText = newText.replace(pattern.regex, pattern.replace);
                    matched = true;
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
