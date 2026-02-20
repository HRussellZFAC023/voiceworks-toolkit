/// <reference types="vitest" />
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import monkey, { cdn } from 'vite-plugin-monkey';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
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
                    '': 'Upgrade asmr.one with an all-in-one power suite: on-device Whisper transcription, local neural JA/CN→EN translation, AI semantic search, radio mode, learner mode with dual-language subtitles, JPDB vocabulary mining, media viewer, audio visualizer, auto-progress tracking, keyboard shortcuts, playlist mode, offline caching, and more. Everything runs locally in your browser with WebGPU acceleration.',
                    'zh-CN': 'asmr.one 全能增强套件。本地Whisper语音转文字、本地神经网络日/中→英翻译、AI语义向量搜索、电台模式、双语字幕学习模式、JPDB词汇挖掘、媒体查看器、音频可视化、自动进度追踪、键盘快捷键、播放列表模式、离线缓存等，全部在浏览器本地运行，支持WebGPU加速。',
                    'zh-TW': 'asmr.one 全能增強套件。本地Whisper語音轉文字、本地神經網路日/中→英翻譯、AI語義向量搜尋、電台模式、雙語字幕學習模式、JPDB詞彙挖掘、媒體檢視器、音頻視覺化、自動進度追蹤、鍵盤快捷鍵、播放清單模式、離線快取等，全部在瀏覽器本地執行，支援WebGPU加速。',
                    'ja': 'asmr.oneの総合拡張スイート。ローカルWhisper音声認識、ローカルニューラル翻訳（日/中→英）、AIセマンティック検索、ラジオモード、デュアル字幕学習モード、JPDB語彙マイニング、メディアビューア、オーディオビジュアライザー、自動進捗追跡、キーボードショートカット、プレイリストモード、オフラインキャッシュなど。すべてブラウザ内でローカル実行、WebGPU対応。',
                    'ko': 'asmr.one 올인원 확장 스위트. 로컬 Whisper 음성인식, 로컬 신경망 일/중→영 번역, AI 시맨틱 검색, 라디오 모드, 이중 자막 학습 모드, JPDB 어휘 마이닝, 미디어 뷰어, 오디오 비주얼라이저, 자동 진행 추적, 키보드 단축키, 재생목록 모드, 오프라인 캐시 등. 모두 브라우저에서 로컬로 실행, WebGPU 가속 지원.',
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
                    'GM_setValue',
                    'GM_getValue',
                    'GM_listValues',
                    'GM_deleteValue',
                    'GM_addStyle',
                    'unsafeWindow'
                ],
                'run-at': 'document-idle',
                license: 'MIT',
                downloadURL: 'https://update.greasyfork.org/scripts/563283/ASMRone%20Ultimate%20%28Radio%20%2B%20Learner%29.user.js',
                updateURL: 'https://update.greasyfork.org/scripts/563283/ASMRone%20Ultimate%20%28Radio%20%2B%20Learner%29.meta.js'
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
