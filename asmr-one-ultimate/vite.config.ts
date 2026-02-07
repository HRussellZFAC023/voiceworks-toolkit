/// <reference types="vitest" />
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import monkey from 'vite-plugin-monkey';

export default defineConfig({
    build: {
        minify: false,
        cssMinify: false,
    },
    plugins: [
        vue(),
        monkey({
            entry: 'src/main.ts',
            userscript: {
                name: 'ASMR.one Ultimate',
                // @ts-ignore
                'name:zh-CN': 'ASMR.one \u7ec8\u6781\u589e\u5f3a',
                // @ts-ignore
                'name:ja': 'ASMR.one Ultimate',
                namespace: 'http://tampermonkey.net/',
                version: '124.1.0',
                description: 'Enhancement suite for ASMR.one — Radio Mode, Learner Mode, Whisper transcription, semantic search, playlist management, visualizer, and 20+ QoL features. All AI runs locally in your browser.',
                // @ts-ignore
                'description:zh-CN': '\u793e\u533a\u9a71\u52a8\u7684 ASMR.one \u589e\u5f3a\u5957\u4ef6\uff0c\u63d0\u4f9b\u7535\u53f0\u6a21\u5f0f\u3001\u5b66\u4e60\u6a21\u5f0f\u3001Whisper \u8bed\u97f3\u8f6c\u5f55\u3001\u8bed\u4e49\u641c\u7d22\u3001\u64ad\u653e\u5217\u8868\u7ba1\u7406\u3001\u97f3\u9891\u53ef\u89c6\u5316\u7b49 20+ \u9879\u529f\u80fd\u3002\u6240\u6709 AI \u5747\u5728\u6d4f\u89c8\u5668\u672c\u5730\u8fd0\u884c\u3002',
                // @ts-ignore
                'description:ja': 'ASMR.one \u306e\u30b3\u30df\u30e5\u30cb\u30c6\u30a3\u99c6\u52d5\u578b\u62e1\u5f35\u30b9\u30a4\u30fc\u30c8\u3002\u30e9\u30b8\u30aa\u30e2\u30fc\u30c9\u3001\u5b66\u7fd2\u30e2\u30fc\u30c9\u3001Whisper \u6587\u5b57\u8d77\u3053\u3057\u3001\u30bb\u30de\u30f3\u30c6\u30a3\u30c3\u30af\u691c\u7d22\u3001\u30d7\u30ec\u30a4\u30ea\u30b9\u30c8\u7ba1\u7406\u3001\u30aa\u30fc\u30c7\u30a3\u30aa\u30d3\u30b8\u30e5\u30a2\u30e9\u30a4\u30b6\u30fc\u306a\u3069 20 \u4ee5\u4e0a\u306e\u6a5f\u80fd\u3092\u642d\u8f09\u3002\u3059\u3079\u3066\u306e AI \u306f\u30d6\u30e9\u30a6\u30b6\u5185\u3067\u30ed\u30fc\u30ab\u30eb\u5b9f\u884c\u3002',
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
        hmr: false, // Disable hot module replacement / auto-refresh
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
