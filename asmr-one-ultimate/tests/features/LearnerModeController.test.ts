import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/infrastructure/KikoeruBridge', () => ({
    KikoeruBridge: {
        getInstance: () => ({ $watch: vi.fn() }),
    },
}));

vi.mock('../../src/features/components/LearnerSubtitles.vue', () => ({
    default: {},
}));

const config = vi.hoisted(() => ({ enableLearnerMode: true }));
vi.mock('../../src/store/AppStore', () => ({
    AppStore: {
        getConfig: (key: string) => key === 'enableLearnerMode' && config.enableLearnerMode,
    },
}));

import { LearnerModeController } from '../../src/features/LearnerModeController';

describe('LearnerModeController injection point', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        config.enableLearnerMode = true;
    });

    it('prefers album art in the legacy expanded player', () => {
        document.body.innerHTML = '<div class="audio-player"><div class="albumart"></div></div>';
        const controller = new LearnerModeController();
        expect(controller.findInjectionPoint()).toBe(document.querySelector('.albumart'));
    });

    it('falls back to the current compact player bar', () => {
        document.body.innerHTML = '<footer class="q-footer"><div class="player-bar"></div></footer>';
        const controller = new LearnerModeController();
        expect(controller.findInjectionPoint()).toBe(document.querySelector('.q-footer'));
    });

    it('follows the learner-mode feature toggle', () => {
        const controller = new LearnerModeController();
        expect((controller as unknown as { shouldBeActive(): boolean }).shouldBeActive()).toBe(true);

        config.enableLearnerMode = false;
        expect((controller as unknown as { shouldBeActive(): boolean }).shouldBeActive()).toBe(false);
    });
});
