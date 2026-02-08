import { defineConfig, devices } from '@playwright/test';

/**
 * Performance Benchmark Configuration
 *
 * Extended timeouts for ML inference. JSON reporter for CI parsing.
 * No retries — benchmarks should be deterministic.
 *
 * Usage:
 *   npx playwright test --config playwright.bench.config.ts
 */

export default defineConfig({
    testDir: './tests/e2e/benchmarks',
    testMatch: '**/*.bench.ts',
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: 0,
    workers: 1,
    reporter: [['json', { outputFile: 'benchmark-results.json' }], ['list']],
    timeout: 180_000, // 3 minutes per test (ML inference is slow)
    expect: {
        timeout: 30_000,
    },
    use: {
        baseURL: 'https://asmr.one',
        trace: 'off',
        video: 'off',
        screenshot: 'only-on-failure',
        headless: true,
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true,
        launchOptions: {
            args: [
                '--disable-web-security',
                '--enable-unsafe-webgpu',
                '--enable-features=Vulkan,UseSkiaRenderer',
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--no-sandbox',
                '--js-flags=--max-old-space-size=2048',
                // Expose performance.memory for heap size measurement
                '--enable-precise-memory-info',
            ],
        },
        contextOptions: {
            reducedMotion: 'reduce',
        },
    },
    projects: [
        {
            name: 'benchmarks',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    webServer: {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: true,
        timeout: 30000,
    },
});
