import { expect, test } from '@playwright/test';

const RUNTIME_TIMEOUT_MS = 5 * 60 * 1000;

test.describe('Whisper worker real runtime', () => {
    test.skip(!process.env.WHISPER_E2E, 'Downloads and runs the real Whisper model');
    test.setTimeout(RUNTIME_TIMEOUT_MS);

    test('loads the bounded WASM model and completes one quiet-audio inference', async ({ page }) => {
        page.on('console', message => {
            if (message.text().includes('[Whisper Worker]')) {
                console.log(`[runtime] ${message.type()}: ${message.text()}`);
            }
        });

        await page.route('http://localhost:5173/whisper-runtime-host', route => {
            route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: '<!doctype html><title>Whisper runtime host</title>',
            });
        });
        await page.goto('http://localhost:5173/whisper-runtime-host');
        const result = await page.evaluate(async ({ timeoutMs }) => {
            const moduleUrl = new URL('/src/features/WhisperWorkerLoader.ts', location.origin).href;
            const loader = await import(moduleUrl);
            const worker = loader.createWhisperWorker();
            const startedAt = performance.now();
            const events: Array<{ status: string; model?: string; backend?: string; dtype?: string; message?: string }> = [];

            return await new Promise<{
                backend: string;
                dtype: string;
                model: string;
                loadMs: number;
                inferenceMs: number;
                events: typeof events;
            }>((resolve, reject) => {
                let readyAt = 0;
                let inferenceSent = false;
                const timer = window.setTimeout(() => {
                    worker.terminate();
                    reject(new Error(`Whisper runtime timed out: ${JSON.stringify(events.slice(-20))}`));
                }, timeoutMs - 5_000);

                worker.onerror = (event: ErrorEvent) => {
                    window.clearTimeout(timer);
                    worker.terminate();
                    reject(new Error(`Whisper worker crashed: ${event.message}`));
                };
                worker.onmessage = (event: MessageEvent) => {
                    const message = event.data || {};
                    const status = String(message.status || 'unknown');
                    if (['initiate', 'ready', 'queued', 'started', 'complete', 'error', 'load-failed', 'worker-poisoned', 'fallback'].includes(status)) {
                        events.push({
                            status,
                            model: message.model,
                            backend: message.backend,
                            dtype: message.dtype,
                            message: message.data?.message,
                        });
                    }
                    if (status === 'error' || status === 'load-failed') {
                        window.clearTimeout(timer);
                        worker.terminate();
                        reject(new Error(`Whisper runtime error: ${JSON.stringify(events.slice(-20))}`));
                        return;
                    }
                    if (status === 'ready' && message.backend && !inferenceSent) {
                        readyAt = performance.now();
                        inferenceSent = true;
                        worker.postMessage({
                            model: 'onnx-community/whisper-tiny',
                            multilingual: true,
                            subtask: 'transcribe',
                            language: 'ja',
                            audio: new Float32Array(16_000 * 2),
                            timeOffset: 0,
                            chunkLengthS: 2,
                            strideLengthS: 0,
                            chunkId: 1,
                            priority: 0,
                            playheadDistance: 0,
                            inputRms: 0,
                        });
                        return;
                    }
                    if (status === 'complete') {
                        const completedAt = performance.now();
                        const ready = events.find(entry => entry.status === 'ready' && entry.backend);
                        window.clearTimeout(timer);
                        worker.terminate();
                        resolve({
                            backend: ready?.backend || '',
                            dtype: ready?.dtype || '',
                            model: ready?.model || '',
                            loadMs: readyAt - startedAt,
                            inferenceMs: completedAt - readyAt,
                            events,
                        });
                    }
                };

                worker.postMessage({ type: 'skip-webgpu' });
                worker.postMessage({
                    type: 'init',
                    model: 'onnx-community/whisper-tiny',
                    multilingual: true,
                    subtask: 'transcribe',
                    language: 'ja',
                    chunkLengthS: 2,
                    strideLengthS: 0,
                });
            });
        }, { timeoutMs: RUNTIME_TIMEOUT_MS });

        console.log(`[runtime] result ${JSON.stringify(result)}`);
        expect(result.backend).toBe('wasm');
        expect(result.model).toBe('onnx-community/whisper-tiny');
        expect(result.dtype).toBeTruthy();
        expect(result.events.some(event => event.status === 'started')).toBe(true);
        expect(result.events.some(event => event.status === 'complete')).toBe(true);
    });
});
