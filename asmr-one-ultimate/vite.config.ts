/// <reference types="vitest" />
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import monkey from 'vite-plugin-monkey';

export default defineConfig({
    plugins: [
        vue(),
        monkey({
            entry: 'src/main.ts',
            userscript: {
                name: 'ASMR.one Ultimate — AI Transcription, Translation & 30+ Features',
                // @ts-ignore
                'name:zh-CN': 'ASMR.one 终极增强 — AI语音转录・神经翻译・30+功能',
                // @ts-ignore
                'name:ja': 'ASMR.one Ultimate — AI文字起こし・翻訳・30以上の機能',
                namespace: 'http://tampermonkey.net/',
                version: '121',
                description: 'All-in-one enhancement suite for asmr.one. On-device Whisper speech-to-text, local neural JA/CN→EN translation, AI semantic search, radio mode, learner mode with dual-language subtitles, media viewer, audio visualizer, auto-progress tracking, keyboard shortcuts, playlist mode, offline caching, and more — all running locally in your browser with WebGPU acceleration.',
                // @ts-ignore
                'description:zh-CN': 'asmr.one 全能增强套件。本地Whisper语音转文字、本地神经网络日/中→英翻译、AI语义向量搜索、电台模式、双语字幕学习模式、媒体查看器、音频可视化、自动进度追踪、键盘快捷键、播放列表模式、离线缓存等——全部在浏览器本地运行，支持WebGPU加速。',
                // @ts-ignore
                'description:ja': 'asmr.oneの総合拡張スイート。ローカルWhisper音声認識、ローカルニューラル翻訳（日/中→英）、AIセマンティック検索、ラジオモード、デュアル字幕学習モード、メディアビューア、オーディオビジュアライザー、自動進捗追跡、キーボードショートカット、プレイリストモード、オフラインキャッシュなど——すべてブラウザ内でローカル実行、WebGPU対応。',
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
                    'www.dlsite.com',
                    'www.asmr.one',
                    'api.jina.ai',
                    'r.jina.ai',
                    's.jina.ai',
                    'api.asmr.one',
                    'api.asmr-100.com',
                    'api.asmr-200.com',
                    'api.asmr-300.com',
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
