import { mount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';
import { describe, expect, beforeEach, afterEach, it } from 'vitest';
import { EventBus } from '../../src/core/EventBus';
import { I18n } from '../../src/core/Utils';
import JoiBar from '../../src/features/components/JoiBar.vue';
import type { JoiState } from '../../src/features/joiDecisionUtils';

interface TestUiState {
    state: JoiState;
    instructionKey: string;
    contextIntensity: number;
    countdownSec: number;
}

function createUiState(overrides: Partial<TestUiState> = {}) {
    return reactive<TestUiState>({
        state: 'go',
        instructionKey: 'joiGoFast',
        contextIntensity: 2,
        countdownSec: 3,
        ...overrides,
    });
}

describe('JoiBar', () => {
    beforeEach(() => {
        EventBus.removeAllListeners('lang:change');
        I18n.setLang('en');
    });

    afterEach(() => {
        EventBus.removeAllListeners('lang:change');
    });

    it('renders reactive state and countdown updates', async () => {
        const uiState = createUiState();
        const wrapper = mount(JoiBar, { props: { uiState } });

        expect(wrapper.find('.asmr-joi-label').text()).toBe(I18n.t('joiGo'));
        expect(wrapper.find('.asmr-joi-instruction').text()).toBe(I18n.t('joiGoFast'));
        expect(wrapper.find('.asmr-joi-countdown').text()).toBe(I18n.format('joiResuming', { sec: 3 }));
        expect(wrapper.findAll('.asmr-joi-context-dot.active')).toHaveLength(2);

        uiState.state = 'stop';
        uiState.instructionKey = 'joiStopHands';
        uiState.contextIntensity = 1;
        uiState.countdownSec = 0;
        await nextTick();

        expect(wrapper.find('.asmr-joi-label').text()).toBe(I18n.t('joiStop'));
        expect(wrapper.find('.asmr-joi-instruction').text()).toBe(I18n.t('joiStopHands'));
        expect(wrapper.find('.asmr-joi-countdown').text()).toBe('');
        expect(wrapper.find('.asmr-joi-countdown').attributes('style')).toContain('display: none');
        expect(wrapper.findAll('.asmr-joi-context-dot.active')).toHaveLength(1);
    });

    it('emits close and cleans up lang listener on unmount', async () => {
        const uiState = createUiState();
        const wrapper = mount(JoiBar, { props: { uiState } });

        expect(EventBus.listenerCount('lang:change')).toBe(1);

        await wrapper.find('.asmr-joi-close').trigger('click');
        expect(wrapper.emitted('close')).toHaveLength(1);

        wrapper.unmount();
        expect(EventBus.listenerCount('lang:change')).toBe(0);
    });

    it('updates translated labels after lang:change', async () => {
        const uiState = createUiState({ state: 'denied', instructionKey: 'joiDeniedMsg', countdownSec: 0 });
        const wrapper = mount(JoiBar, { props: { uiState } });

        const englishLabel = wrapper.find('.asmr-joi-label').text();
        I18n.setLang('ja');
        EventBus.emit('lang:change', { lang: 'ja' });
        await nextTick();

        expect(wrapper.find('.asmr-joi-label').text()).toBe(I18n.t('joiDenied'));
        expect(wrapper.find('.asmr-joi-label').text()).not.toBe(englishLabel);
        expect(wrapper.find('.asmr-joi-instruction').text()).toBe(I18n.t('joiDeniedMsg'));
    });
});
