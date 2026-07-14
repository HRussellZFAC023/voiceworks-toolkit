import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import LearnerSecondarySubtitle from '../../src/features/components/LearnerSecondarySubtitle.vue';

describe('LearnerSecondarySubtitle', () => {
    it('renders the Chinese lane with an accurate language attribute and layout class', async () => {
        const wrapper = mount(LearnerSecondarySubtitle, {
            props: {
                text: '中文字幕', blurred: false, fallback: false,
                language: 'zh-CN', chineseLayout: true, ariaLabel: '隐藏翻译',
            },
        });
        const button = wrapper.get('button');
        expect(button.attributes('lang')).toBe('zh-CN');
        expect(button.classes()).toContain('learner-zh');
        expect(button.text()).toBe('中文字幕');
        await button.trigger('click');
        expect(wrapper.emitted('toggle')).toHaveLength(1);
    });

    it('keeps the default English lane semantics', () => {
        const wrapper = mount(LearnerSecondarySubtitle, {
            props: {
                text: 'English', blurred: true, fallback: false,
                language: 'en', chineseLayout: false, ariaLabel: 'Reveal translation',
            },
        });
        const button = wrapper.get('button');
        expect(button.attributes('lang')).toBe('en');
        expect(button.classes()).toContain('learner-en');
        expect(button.classes()).not.toContain('learner-zh');
        expect(button.classes()).toContain('blurred');
    });

    it('updates an already-mounted live lane when Chinese mode is selected', async () => {
        const wrapper = mount(LearnerSecondarySubtitle, {
            props: {
                text: 'Welcome back', blurred: false, fallback: false,
                language: 'en', chineseLayout: false, ariaLabel: 'Hide translation',
            },
        });

        await wrapper.setProps({
            text: '欢迎回来',
            language: 'zh-CN',
            chineseLayout: true,
            ariaLabel: '隐藏翻译',
        } as never);

        const button = wrapper.get('button');
        expect(button.text()).toBe('欢迎回来');
        expect(button.attributes('lang')).toBe('zh-CN');
        expect(button.attributes('aria-label')).toBe('隐藏翻译');
        expect(button.classes()).toContain('learner-zh');
    });
});
