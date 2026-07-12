import { defineConfig, devices } from '@playwright/test';

/**
 * E2E Test Configuration
 *
 * Tests launch a headless browser and automatically inject the userscript.
 * No manual browser setup or Tampermonkey installation required.
 *
 * Usage:
 *   npm run dev          # Start Vite dev server first
 *   npm run test:e2e     # Run tests (headless)
 *   npm run test:e2e:ui  # Run with Playwright UI
 *
 * Environment variables:
 *   PW_WORKERS=N         # Override worker count (default: 1)
 *   PW_SLOWMO=N          # Override slowMo in ms (default: 200)
 */

// Set workers to undefined to let Playwright scale automatically based on CPU cores.
const workers = process.env.PW_WORKERS ? parseInt(process.env.PW_WORKERS, 10) : undefined;
const slowMo = parseInt(process.env.PW_SLOWMO || '', 10) || 0;
const isRealE2E = process.env.E2E_REAL === '1' || process.env.E2E_NO_MOCKS === '1';
const skipWebServer = process.env.E2E_SKIP_WEBSERVER === '1';
const baseURL = process.env.E2E_BASE_URL || 'https://www.asmr.one';

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: workers ?? 1,
    reporter: [['html', { open: 'never' }], ['list']],
    timeout: 60000,
    expect: {
        timeout: 10000,
    },
    use: {
        baseURL,
        trace: 'on-first-retry',
        // Disable video recording to save RAM — only enable on retry
        video: process.env.CI ? 'on-first-retry' : 'off',
        screenshot: 'only-on-failure',
        headless: true,
        // Viewport for consistent testing
        viewport: { width: 1280, height: 720 },
        // Ignore HTTPS errors (some CDN certs can be flaky)
        ignoreHTTPSErrors: true,
        launchOptions: {
            slowMo,
            args: [
                '--disable-web-security',
                // WebGPU (needed for Whisper E2E)
                '--enable-unsafe-webgpu',
                '--enable-features=Vulkan,UseSkiaRenderer',
                // RAM reduction flags
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-component-extensions-with-background-pages',
                '--no-sandbox',
                '--js-flags=--max-old-space-size=1024',
            ],
        },
        // Reuse browser context across tests in the same worker for lower RAM
        contextOptions: {
            reducedMotion: 'reduce',
        },
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    // Start dev server automatically if not running (not needed for real-site E2E).
    webServer: isRealE2E || skipWebServer ? undefined : {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: true,
        timeout: 30000,
    },
});
