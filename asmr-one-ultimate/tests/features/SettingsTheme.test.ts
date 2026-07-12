import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const variablesCss = readFileSync(resolve(process.cwd(), 'src/styles/variables.css'), 'utf8');
const settingsCss = readFileSync(resolve(process.cwd(), 'src/styles/components/_settings.css'), 'utf8');

const settingsSources = [
    'src/features/settings/SettingsPanel.vue',
    'src/features/settings/SettingsToggle.vue',
    'src/features/settings/SettingsInput.vue',
    'src/features/settings/SettingsHotkeyInput.vue',
].map(path => readFileSync(resolve(process.cwd(), path), 'utf8'));

describe('settings theme surfaces', () => {
    afterEach(() => {
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        document.body.className = '';
    });

    it('does not mount fixed dark-mode utility classes', () => {
        const prohibited = /\b(?:q-list--dark|q-item--dark|q-field--dark|q-toggle--dark|q-separator--dark|bg-black)\b/;
        for (const source of settingsSources) expect(source).not.toMatch(prohibited);
    });

    it('defines contrasting light and dark variables for every owned surface', () => {
        const style = document.createElement('style');
        style.textContent = `${variablesCss}\n${settingsCss}`;
        document.head.appendChild(style);
        const read = (element: Element) => ({
            sectionBg: getComputedStyle(element).getPropertyValue('--asmr-bg-secondary'),
            sectionText: getComputedStyle(element).getPropertyValue('--asmr-text-primary'),
            inputBg: getComputedStyle(element).getPropertyValue('--asmr-input-bg'),
            separatorBg: getComputedStyle(element).getPropertyValue('--asmr-border-color'),
            actionBg: getComputedStyle(element).getPropertyValue('--asmr-hover-bg'),
        });

        const light = read(document.documentElement);
        document.body.classList.add('body--dark');
        const dark = read(document.body);

        expect(light.sectionBg).not.toBe(dark.sectionBg);
        expect(light.sectionText).not.toBe(dark.sectionText);
        expect(light.inputBg).not.toBe(dark.inputBg);
        expect(light.separatorBg).not.toBe(dark.separatorBg);
        expect(light.actionBg).not.toBe(dark.actionBg);
        expect(settingsCss).toMatch(/\.asmr-settings-section\s*\{[\s\S]*background:\s*var\(--asmr-bg-secondary\)/);
        expect(settingsCss).toMatch(/\.asmr-settings-separator\s*\{[\s\S]*background:\s*var\(--asmr-border-color\)/);
        expect(settingsCss).toMatch(/\.asmr-settings-separator\s*\{[\s\S]*transition:\s*none\s*!important/);
        expect(settingsCss).toMatch(/:is\(\.body--dark, \.q-dark\) \.asmr-settings-separator\s*\{[\s\S]*background-color:\s*rgba\(255, 255, 255, 0\.1\)/);
        expect(settingsCss).toMatch(/\.asmr-settings-section :is\(\.asmr-input, \.asmr-hotkey-input\)\s*\{[\s\S]*background:\s*var\(--asmr-input-bg\)/);
        expect(settingsCss).toMatch(/\.asmr-settings-section \.q-btn[^\{]*\{[\s\S]*background:\s*var\(--asmr-input-bg\)/);
    });

    it('exposes fullscreen and gallery feature controls in the panel', () => {
        expect(settingsSources[0]).toContain("key: 'enablePlayerFullscreen'");
        expect(settingsSources[0]).toContain("key: 'enablePlayerGallery'");
    });
});
