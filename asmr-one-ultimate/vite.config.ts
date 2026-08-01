/// <reference types="vitest" />
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import monkey, { cdn } from 'vite-plugin-monkey';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
    build: {
        // vite-plugin-monkey otherwise keeps the SystemJS payload readable,
        // pushing the userscript over the script host's 2 MiB code limit.
        minify: 'esbuild',
        // The userscript is the only shipped asset, so the 128 KiB local icon
        // font must be a data URL rather than an unreachable dist sidecar.
        assetsInlineLimit: 160 * 1024,
    },
    plugins: [
        vue(),
        monkey({
            entry: 'src/main.ts',
            userscript: {
                name: {
                    '': 'ASMR.one Ultimate - AI Transcription, Translation & 30+ Features',
                    'zh-CN': 'ASMR.one 终极增强 - AI语音转录・神经翻译・30+功能',
                    'zh-TW': 'ASMR.one 終極增強 - AI語音轉錄・神經翻譯・30+功能',
                    'ja': 'ASMR.one Ultimate - AI文字起こし・翻訳・30以上の機能',
                    'ko': 'ASMR.one Ultimate - AI 음성인식・번역・30+ 기능',
                },
                namespace: 'http://tampermonkey.net/',
                version: pkg.version,
                description: {
                    '': 'Upgrade asmr.one with on-device Whisper, cached or custom translation, semantic search, radio and learner modes, JPDB, separate playlist backups, and automatic recovery from the English-language gate.',
                    'zh-CN': 'asmr.one 全能增强：本地 Whisper、缓存或自定义翻译 API、语义搜索、电台与学习模式、JPDB、播放列表分离备份及英文优先语言封锁自动恢复。',
                    'zh-TW': 'asmr.one 全能增強：本地 Whisper、快取或自訂翻譯 API、語意搜尋、電台與學習模式、JPDB、播放清單分離備份及英文優先語言封鎖自動復原。',
                    'ja': 'asmr.one総合拡張：オンデバイスWhisper、キャッシュ/カスタム翻訳API、意味検索、ラジオ/学習モード、JPDB、プレイリスト分離バックアップ、英語優先言語ゲートの自動復旧。',
                    'ko': 'asmr.one 확장 도구: 온디바이스 Whisper, 캐시/사용자 지정 번역 API, 시맨틱 검색, 라디오·학습 모드, JPDB, 재생목록 분리 백업 및 영어 우선 언어 차단 자동 복구.',
                },
                author: 'Henry',
                match: [
                    'https://asmr.one/*',
                    'https://www.asmr.one/*',
                    'https://asmr-100.com/*',
                    'https://asmr-200.com/*',
                    'https://asmr-300.com/*'
                ],
                connect: [
                    'translate.googleapis.com',
                    'translate.google.com',
                    'translate.google.co.jp',
                    'translate.google.de',
                    'translate.google.fr',
                    'translate.google.es',
                    'translate.google.co.kr',
                    'translate.google.com.tw',
                    'www.dlsite.com',
                    'www.asmr.one',
                    'jpdb.io',
                    'www.google.com',
                    'api.asmr.one',
                    'api.asmr-100.com',
                    'api.asmr-200.com',
                    'api.asmr-300.com',
                    'raw.kiko-play-niptan.one',
                    '*'
                ],
                icon: 'https://images2.imgbox.com/c8/21/h1DhlGPW_o.png',
                grant: [
                    'GM_xmlhttpRequest',
                    'GM_download',
                    'GM_setValue',
                    'GM_getValue',
                    'GM_listValues',
                    'GM_deleteValue',
                    'GM_addStyle',
                    'unsafeWindow'
                ],
                // Register before the blocked document is painted. main.ts
                // resolves immediately only for the exact gate signature and
                // otherwise waits for DOMContentLoaded before normal startup.
                'run-at': 'document-start',
                license: 'MIT; bundled Material Icons font: Apache-2.0',
                downloadURL: 'https://update.sleazyfork.org/scripts/563283.user.js',
                updateURL: 'https://update.sleazyfork.org/scripts/563283.meta.js'
            },
            build: {
                externalGlobals: {
                    vue: cdn.jsdelivr('Vue', 'dist/vue.global.prod.js'),
                    'fuse.js': cdn.jsdelivr('Fuse', 'dist/fuse.min.js'),
                },
            },
        }),
    ],
    server: {
        origin: 'http://127.0.0.1:5173',
        port: 5173,
        strictPort: false,
        cors: true,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
            'Access-Control-Allow-Headers': '*',
        },
    },
    test: {
        environment: 'jsdom',
        setupFiles: ['./tests/setup.ts'],
        globals: true,
        // The release-state specs intentionally spawn many child processes.
        // Vitest's fork pool can leave its `onTaskUpdate` RPC unanswered even
        // after every assertion passes; the thread pool completes the same
        // tests cleanly. Bound file fan-out so its coordinator stays responsive.
        pool: 'threads',
        maxWorkers: 4,
        exclude: ['**/tests/e2e/**', '**/node_modules/**', '**/dist/**'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.d.ts', 'src/main.ts']
        },
        server: {
            deps: {
                inline: ['vuetify']
            }
        }
    }
});
