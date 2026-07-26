import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { enLocale } from '../../src/core/locales/en';
import { zhLocale } from '../../src/core/locales/zh';
import { jaLocale } from '../../src/core/locales/ja';

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');

const settingsCss = read('src/styles/components/_settings.css');
const panelSource = read('src/features/settings/SettingsPanel.vue');
const rangeSource = read('src/features/settings/SettingsRangeSelect.vue');
const backupDocs = read('docs/resilience-and-backups.md');

const locales: Array<[string, Record<string, string>]> = [
    ['en', enLocale],
    ['zh', zhLocale],
    ['ja', jaLocale],
];

/**
 * Copy the user rejected verbatim. These must never come back in any language
 * file, in the panel, or in the range control.
 */
const REJECTED_COPY = [
    'Auto picks before loading. A manual tier stays pinned and reports an error instead of silently switching models or backends.',
    'ASMR-safe: silence skipping and speech VAD are disabled, so quiet words, breaths, and long pauses stay in the transcription input.',
    '; lower it only if first-caption latency matters more than accuracy.',
];

function contrastRatio(foreground: string, background: string): number {
    const channels = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
    const luminance = (rgb: number[]) => {
        const linear = rgb.map(value => {
            const channel = value / 255;
            return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const [lighter, darker] = [luminance(channels(foreground)), luminance(channels(background))]
        .sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
}

function cssVarValue(scopeSelector: string, name: string): string {
    const block = settingsCss.split(scopeSelector)[1] ?? '';
    const body = block.slice(0, block.indexOf('}'));
    const match = body.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
    if (!match) throw new Error(`${name} is not declared under ${scopeSelector}`);
    return match[1];
}

describe('settings copy the user rejected', () => {
    it('never reappears in en, zh, or ja', () => {
        for (const [name, locale] of locales) {
            const serialized = JSON.stringify(locale);
            for (const rejected of REJECTED_COPY) {
                expect(serialized, `${name} still contains rejected copy`).not.toContain(rejected);
            }
        }
    });

    it('never reappears in the settings sources', () => {
        for (const rejected of REJECTED_COPY) {
            expect(panelSource).not.toContain(rejected);
            expect(rangeSource).not.toContain(rejected);
        }
    });

    it('tops the quality and overlap scales with Accurate rather than ASMR', () => {
        expect(enLocale.whisperContextMaximum).toContain('Accurate');
        expect(enLocale.whisperOverlapAsmr).toContain('Accurate');
        for (const [name, locale] of locales) {
            expect(locale.whisperContextMaximum, `${name} context scale top`).not.toMatch(/ASMR/i);
            expect(locale.whisperOverlapAsmr, `${name} overlap scale top`).not.toMatch(/ASMR/i);
        }
    });
});

describe('whisper model preset labels', () => {
    // Sizes measured against the app's own dtype policy for each preset.
    const expectedSizes: Array<[string, RegExp]> = [
        ['whisperPresetTiny', /120\s*MB/],
        ['whisperPresetBase', /206\s*MB/],
        ['whisperPresetSmall', /586\s*MB/],
        ['whisperPresetMedium', /1\.7\s*GB/],
        ['whisperPresetLargeTurbo', /2\.9\s*GB/],
    ];

    it('states the measured download size in every language', () => {
        for (const [name, locale] of locales) {
            for (const [key, size] of expectedSizes) {
                expect(locale[key], `${name}.${key}`).toMatch(size);
            }
        }
    });

    it('no longer advertises the wrong Small download size', () => {
        for (const [name, locale] of locales) {
            expect(locale.whisperPresetSmall, `${name}.whisperPresetSmall`).not.toMatch(/560/);
        }
    });
});

describe('user control over model and backend selection', () => {
    it('describes a manual model choice as pinned with an error, not a switch', () => {
        expect(enLocale.whisperModelPresetSub).toMatch(/error/i);
        expect(enLocale.whisperModelPresetSub).toMatch(/never a different model/i);
        for (const [name, locale] of locales) {
            expect(locale.whisperModelPresetSub, `${name}.whisperModelPresetSub`).toBeTruthy();
            // Generic one-liners do not tell the user what happens on failure.
            expect(locale.whisperModelPresetSub.length, `${name}.whisperModelPresetSub`).toBeGreaterThan(30);
        }
    });

    it('describes the backend choice as kept', () => {
        expect(enLocale.forceWhisperWasmSub).toMatch(/kept as picked/i);
        for (const [name, locale] of locales) {
            expect(locale.forceWhisperWasmSub, `${name}.forceWhisperWasmSub`).toBeTruthy();
        }
    });

    it('exposes both the model preset and the backend toggle in the panel', () => {
        expect(panelSource).toContain('config-key="whisperModelPreset"');
        expect(panelSource).toContain('config-key="forceWhisperWasm"');
    });
});

describe('Google Drive OAuth client id stays internal', () => {
    it('renders no client id control or explanatory copy', () => {
        expect(panelSource).not.toContain('config-key="googleDriveClientId"');
        expect(panelSource).not.toContain('emergencyDriveClientId');
        for (const [name, locale] of locales) {
            const clientIdKeys = Object.keys(locale).filter(key => /DriveClientId/i.test(key));
            expect(clientIdKeys, `${name} still ships client-id copy`).toEqual([]);
            expect(locale.emergencyDriveUnavailable, `${name}.emergencyDriveUnavailable`).toBeTruthy();
            expect(locale.emergencyDriveUnavailable, `${name}.emergencyDriveUnavailable`).not.toMatch(/OAuth|client/i);
        }
    });

    it('documents the client as internal configuration', () => {
        expect(backupDocs).not.toMatch(/Settings → Emergency Backup → Google Drive OAuth Client ID/);
        expect(backupDocs).toMatch(/There is no client-ID field in the settings panel/);
    });
});

describe('settings row layout', () => {
    it('uses no negative offsets that can pull one row over another', () => {
        const negativeMargins = settingsCss.match(/margin(?:-top|-bottom)?:\s*-/g) ?? [];
        expect(negativeMargins).toEqual([]);
        expect(settingsCss).toMatch(/\.asmr-settings-hint\s*\{[^}]*margin-top:\s*0/);
    });

    it('lets the text column shrink so rows wrap instead of clipping', () => {
        expect(settingsCss).toMatch(/\.asmr-settings-section \.q-item__section--main\s*\{[^}]*min-width:\s*0/);
        expect(settingsCss).toMatch(/\.asmr-settings-section \.q-item__section--side:not\(\.col-grow\)\s*\{[^}]*flex:\s*0 0 auto/);
        expect(settingsCss).toMatch(/\.asmr-settings-section \.q-item__section--side\.col-grow\s*\{[^}]*flex-shrink:\s*1/);
        expect(settingsCss).toMatch(/\.asmr-input, \.asmr-hotkey-input, \.asmr-select\)\s*\{[^}]*max-width:\s*100%/);
    });

    it('keeps label and caption text wrapping rather than truncating', () => {
        expect(settingsCss).toMatch(/white-space:\s*normal/);
        expect(settingsCss).toMatch(/overflow-wrap:\s*anywhere/);
        expect(settingsCss).toMatch(/text-overflow:\s*clip/);
    });

    it('separates the range hint from the tick row it follows', () => {
        const match = settingsCss.match(/\.asmr-settings-range-hint\s*\{[^}]*margin-top:\s*(\d+)px/);
        expect(match).not.toBeNull();
        expect(Number(match![1])).toBeGreaterThan(0);
    });
});

describe('settings hint colors in both themes', () => {
    it('declares theme-specific warning and error colors', () => {
        const lightWarning = cssVarValue('.asmr-settings-panel {', '--asmr-settings-warning');
        const lightError = cssVarValue('.asmr-settings-panel {', '--asmr-settings-error');
        const darkWarning = cssVarValue(':is(.body--dark, .q-dark) .asmr-settings-panel {', '--asmr-settings-warning');
        const darkError = cssVarValue(':is(.body--dark, .q-dark) .asmr-settings-panel {', '--asmr-settings-error');

        expect(lightWarning).not.toBe(darkWarning);
        expect(lightError).not.toBe(darkError);

        // --asmr-bg-secondary resolves to #f5f5f5 (light) and #222222 (dark).
        expect(contrastRatio(lightWarning, '#f5f5f5')).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(lightError, '#f5f5f5')).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(darkWarning, '#222222')).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(darkError, '#222222')).toBeGreaterThanOrEqual(4.5);
    });

    it('uses the tokens instead of a single fixed hex in the panel', () => {
        expect(panelSource).toContain('hint-color="var(--asmr-settings-warning)"');
        expect(panelSource).not.toContain("'#e57373' : ''");
        expect(panelSource).toContain("'var(--asmr-settings-error)' : ''");
    });
});
