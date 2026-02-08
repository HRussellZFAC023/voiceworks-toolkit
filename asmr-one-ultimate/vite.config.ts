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
                name: 'ASMR.one Ultimate (Radio + Learner)',
                // @ts-ignore
                'name:zh-CN': 'ASMR.one \u7ec8\u6781\u589e\u5f3a (\u7535\u53f0 + \u5b66\u4e60\u6a21\u5f0f)',
                namespace: 'http://tampermonkey.net/',
                version: '121',
                description: 'The ultimate enhancement suite for ASMR.one. Features: Radio Mode (Continuous random playback, smart navigation, shuffling) and Learner Mode (Bilingual subtitles, auto-translation, study mode).',
                // @ts-ignore
                'description:zh-CN': 'ASMR.one \u7684\u7ec8\u6781\u589e\u5f3a\u5957\u4ef6\u3002\u529f\u80fd\uff1a\u7535\u53f0\u6a21\u5f0f\uff08\u8fde\u7eed\u968f\u673a\u64ad\u653e\u3001\u667a\u80fd\u5bfc\u822a\u3001\u6df7\u6d17\uff09\u548c\u5b66\u4e60\u6a21\u5f0f\uff08\u53cc\u8bed\u5b57\u5e55\u3001\u81ea\u52a8\u7ffb\u8bd1\u3001\u5b66\u4e60/\u6a21\u7cca\u6a21\u5f0f\uff09\u3002',
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
