import { describe, expect, it, vi } from 'vitest';
import {
    buildRegionGateProxyUrl,
    discoverWebpackRuntimeAssets,
    isRegionGateDocument,
    isTrustedAsmrFrontendHost,
    recoverRegionGateIfNeeded,
    requestRegionGateResource,
    rewriteRegionGateCssUrls,
    validateRegionGateResponse,
    validateWebpackJsonpChunk,
    waitForRegionGateOrDomReady,
} from '../../src/core/RegionGateRecovery';
import type { GmResponse } from '../../src/infrastructure/HttpClient';

describe('RegionGateRecovery', () => {
    it('recognizes the exact ASMR.one language gate without matching normal pages', () => {
        const gated = document.implementation.createHTMLDocument('remember, no english');
        gated.body.textContent = 'I have an idea: how about not using asmr.one?';
        expect(isRegionGateDocument(gated)).toBe(true);

        const markerOnly = document.implementation.createHTMLDocument('Unexpected response');
        markerOnly.body.textContent = '  I HAVE AN IDEA: HOW ABOUT NOT USING ASMR.ONE?  ';
        expect(isRegionGateDocument(markerOnly)).toBe(false);

        const titleOnly = document.implementation.createHTMLDocument('remember, no english');
        titleOnly.body.textContent = 'Different error';
        expect(isRegionGateDocument(titleOnly)).toBe(false);

        const normal = document.implementation.createHTMLDocument('ASMR Online');
        normal.body.innerHTML = '<div id="q-app">I have an idea: how about not using asmr.one?</div>';
        expect(isRegionGateDocument(normal)).toBe(false);

        const appWithGateSignature = document.implementation.createHTMLDocument('remember, no english');
        appWithGateSignature.body.innerHTML = '<div id="q-app">I have an idea: how about not using asmr.one?</div>';
        expect(isRegionGateDocument(appWithGateSignature)).toBe(false);
    });

    it('detects the exact gate while a document-start parser is still running', async () => {
        const parsing = document.implementation.createHTMLDocument('Loading');
        Object.defineProperty(parsing, 'readyState', { configurable: true, value: 'loading' });
        const detected = waitForRegionGateOrDomReady(parsing);

        parsing.title = 'remember, no english';
        parsing.body.textContent = 'I have an idea: how about not using asmr.one?';

        await expect(detected).resolves.toBe('gate');
    });

    it('allows only the userscript frontend hosts', () => {
        expect(isTrustedAsmrFrontendHost('asmr.one')).toBe(true);
        expect(isTrustedAsmrFrontendHost('www.asmr.one')).toBe(true);
        expect(isTrustedAsmrFrontendHost('asmr-100.com')).toBe(true);
        expect(isTrustedAsmrFrontendHost('api.asmr-200.com')).toBe(false);
        expect(isTrustedAsmrFrontendHost('asmr.one.example.com')).toBe(false);
    });

    it('maps trusted frontend requests to a scoped proxy URL', () => {
        const proxied = new URL(buildRegionGateProxyUrl(
            'https://asmr.one/js/app.123.js?cache=1#ignored',
            'https://proxy.example/base/',
        ));
        expect(proxied.origin).toBe('https://proxy.example');
        expect(proxied.pathname).toBe('/base/js/app.123.js');
        expect(proxied.searchParams.get('cache')).toBe('1');
        expect(proxied.searchParams.get('__host')).toBe('asmr.one');
        expect(proxied.hash).toBe('');

        expect(() => buildRegionGateProxyUrl(
            'https://evil.example/payload.js',
            'https://proxy.example/',
        )).toThrow(/untrusted frontend host/i);
    });

    it('rewrites same-host CSS assets through the proxy and leaves safe URLs alone', () => {
        const css = [
            '@font-face{src:url(../fonts/icon.woff2)}',
            '.hero{background:url("/statics/hero.png?v=1")}',
            '.inline{background:url(data:image/png;base64,abc)}',
            '.external{background:url(https://cdn.example/image.png)}',
        ].join('\n');

        const rewritten = rewriteRegionGateCssUrls(
            css,
            'https://asmr.one/css/app.123.css',
            'https://proxy.example/',
        );

        expect(rewritten).toContain(
            'url("https://proxy.example/fonts/icon.woff2?__host=asmr.one")',
        );
        expect(rewritten).toContain(
            'url("https://proxy.example/statics/hero.png?v=1&__host=asmr.one")',
        );
        expect(rewritten).toContain('url(data:image/png;base64,abc)');
        expect(rewritten).toContain('url(https://cdn.example/image.png)');
    });

    it('discovers the verified Webpack lazy JS/CSS maps without evaluating code', () => {
        const runtime = [
            'function o(e){return l.p+"js/"+({0:"chunk-common"}[e]||e)+"."+{0:"4dfcadbf",10:"e4d7ad88"}[e]+".js"}',
            'l.e=function(e){var t=[],a={0:1,10:1};s[e]?t.push(s[e]):0!==s[e]&&a[e]&&t.push(',
            'new Promise(function(t,a){var i="css/"+({0:"chunk-common"}[e]||e)+"."+{0:"c2bfd879",10:"5accf6b0"}[e]+".css"}))}',
            'var c=window["webpackJsonp"]=window["webpackJsonp"]||[];',
        ].join('');

        expect(discoverWebpackRuntimeAssets(runtime, 'https://asmr.one/settings')).toEqual({
            scripts: [
                { id: 0, dataHref: 'js/chunk-common.4dfcadbf.js', url: 'https://asmr.one/js/chunk-common.4dfcadbf.js' },
                { id: 10, dataHref: 'js/10.e4d7ad88.js', url: 'https://asmr.one/js/10.e4d7ad88.js' },
            ],
            styles: [
                { id: 0, dataHref: 'css/chunk-common.c2bfd879.css', url: 'https://asmr.one/css/chunk-common.c2bfd879.css' },
                { id: 10, dataHref: 'css/10.5accf6b0.css', url: 'https://asmr.one/css/10.5accf6b0.css' },
            ],
        });
        expect(() => discoverWebpackRuntimeAssets(
            runtime.replace('{0:"4dfcadbf",10:"e4d7ad88"}', '{0:"4dfcadbf",0:"e4d7ad88"}'),
            'https://asmr.one/',
        )).toThrow(/duplicate Webpack chunk IDs/i);
        expect(() => discoverWebpackRuntimeAssets(
            runtime.replace('a={0:1,10:1}', 'a={0:1,11:1}'),
            'https://asmr.one/',
        )).toThrow(/unmapped Webpack CSS chunk/i);
        expect(() => discoverWebpackRuntimeAssets(
            runtime.replace('a={0:1,10:1}', 'a={0:1,0:1}'),
            'https://asmr.one/',
        )).toThrow(/duplicate active Webpack CSS chunks/i);
    });

    it('accepts only JSONP chunks that register their expected numeric ID', () => {
        const valid = '(window["webpackJsonp"]=window["webpackJsonp"]||[]).push([[10],{"abc":function(){}}]);';
        expect(() => validateWebpackJsonpChunk(valid, 10)).not.toThrow();
        expect(() => validateWebpackJsonpChunk(valid, 11)).toThrow(/mismatched/i);
        expect(() => validateWebpackJsonpChunk(
            valid.replace('[[10]', '[[10,11]'),
            10,
        )).toThrow(/mismatched/i);
        expect(() => validateWebpackJsonpChunk('window.evil()', 10)).toThrow(/invalid/i);
    });

    it('rejects redirects, missing final URLs, wrong MIME types, and oversized bodies', () => {
        const requestUrl = 'https://asmr.one/js/app.123.js';
        const response = (overrides: Partial<GmResponse> = {}): GmResponse => ({
            status: 200,
            statusText: 'OK',
            responseText: 'window.__appLoaded = true;',
            response: 'window.__appLoaded = true;',
            responseHeaders: 'Content-Type: application/javascript\r\n',
            finalUrl: requestUrl,
            ...overrides,
        });

        expect(validateRegionGateResponse(requestUrl, response(), 'script', 1_000))
            .toContain('__appLoaded');
        expect(() => validateRegionGateResponse(
            requestUrl,
            response({ finalUrl: 'https://asmr.one/js/redirected.js' }),
            'script',
            1_000,
        )).toThrow(/redirected response/i);
        expect(() => validateRegionGateResponse(
            requestUrl,
            response({ finalUrl: undefined }),
            'script',
            1_000,
        )).toThrow(/final response URL/i);
        expect(() => validateRegionGateResponse(
            requestUrl,
            response({ responseHeaders: 'Content-Type: text/html\r\n' }),
            'script',
            1_000,
        )).toThrow(/content type/i);
        expect(() => validateRegionGateResponse(
            requestUrl,
            response({ responseText: 'x'.repeat(50), response: 'x'.repeat(50) }),
            'script',
            10,
        )).toThrow(/safety limit/i);
    });

    it('aborts the privileged transport as soon as its byte budget is exceeded', async () => {
        const originalRequest = (globalThis as Record<string, unknown>).GM_xmlhttpRequest;
        const abort = vi.fn();
        (globalThis as Record<string, unknown>).GM_xmlhttpRequest = vi.fn((options: {
            onprogress?: (event: { loaded: number; total: number; lengthComputable: boolean }) => void;
        }) => {
            queueMicrotask(() => options.onprogress?.({ loaded: 101, total: 101, lengthComputable: true }));
            return { abort };
        });

        try {
            await expect(requestRegionGateResource(
                'https://asmr.one/js/app.123.js',
                'script',
                100,
            )).rejects.toThrow(/safety limit/i);
            expect(abort).toHaveBeenCalledTimes(1);
        } finally {
            (globalThis as Record<string, unknown>).GM_xmlhttpRequest = originalRequest;
        }
    });

    it('does no network work when a mounted host app merely contains the marker', async () => {
        const originalTitle = document.title;
        const originalBody = document.body.innerHTML;
        const gmRequestMock = vi.mocked((globalThis as Record<string, unknown>).GM_xmlhttpRequest as (...args: unknown[]) => unknown);
        gmRequestMock.mockClear();
        document.title = 'remember, no english';
        document.body.innerHTML = '<div id="q-app">I have an idea: how about not using asmr.one?</div>';

        try {
            await expect(recoverRegionGateIfNeeded()).resolves.toBe('not-needed');
            expect(gmRequestMock).not.toHaveBeenCalled();
        } finally {
            document.title = originalTitle;
            document.body.innerHTML = originalBody;
        }
    });
});
