import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TagFilters } from '../../src/features/TagFilters';
import { KikoeruBridge } from '../../src/infrastructure/KikoeruBridge';

describe('TagFilters', () => {
    let bridge: KikoeruBridge;
    let mockStore: any;
    let mockRouter: any;

    beforeEach(() => {
        (KikoeruBridge as any).instance = null;
        sessionStorage.clear();
        mockStore = {
            state: {},
            dispatch: vi.fn()
        };
        mockRouter = {
            currentRoute: { path: '/', query: {} },
            push: vi.fn().mockResolvedValue(undefined)
        };

        document.body.innerHTML = '<div id="q-app"></div>';
        const app = document.getElementById('q-app');
        if (app) (app as any).__vue__ = { $store: mockStore, $router: mockRouter, $axios: {}, $route: mockRouter.currentRoute, $watch: vi.fn() };

        bridge = KikoeruBridge.getInstance();
    });

    it('should intercept click on tag link', async () => {
        await bridge.initialize();
        const tagFilters = new TagFilters();
        tagFilters.enable();

        // Create a mock event
        const container = document.createElement('div');
        container.className = 'q-page-container';
        document.body.appendChild(container);

        const anchor = document.createElement('a');
        anchor.href = 'https://asmr.one/tags/53';
        container.appendChild(anchor);

        // Dispatch click - omit view to avoid JSDOM strictness
        const clickEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true
        });

        const preventSpy = vi.spyOn(clickEvent, 'preventDefault');

        anchor.dispatchEvent(clickEvent);

        expect(preventSpy).toHaveBeenCalled();
        expect(mockRouter.push).toHaveBeenCalledWith({ path: '/works', query: { tags: '53' } });
        expect(mockStore.dispatch).toHaveBeenCalledWith('Works/search', { tags: ['53'], tag_id: '53' });
    });

    it('should not intercept non-tag links', async () => {
        await bridge.initialize();
        const tagFilters = new TagFilters();
        tagFilters.enable();

        const anchor = document.createElement('a');
        anchor.href = 'https://asmr.one/works/RJ123';
        document.body.appendChild(anchor);

        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
        const preventSpy = vi.spyOn(clickEvent, 'preventDefault');

        anchor.dispatchEvent(clickEvent);

        expect(preventSpy).not.toHaveBeenCalled();
        expect(mockStore.dispatch).not.toHaveBeenCalled();
        expect(mockRouter.push).not.toHaveBeenCalled();
    });

    it('should clear tag_id for multi-tag filters', async () => {
        await bridge.initialize();
        const tagFilters = new TagFilters();
        tagFilters.enable();

        const container = document.createElement('div');
        container.className = 'q-page-container';
        document.body.appendChild(container);

        const anchorA = document.createElement('a');
        anchorA.href = 'https://asmr.one/tags/53';
        anchorA.textContent = 'Ear Cleaning';
        container.appendChild(anchorA);

        const anchorB = document.createElement('a');
        anchorB.href = 'https://asmr.one/tags/12';
        anchorB.textContent = 'Whispering';
        container.appendChild(anchorB);

        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
        anchorA.dispatchEvent(clickEvent);
        anchorB.dispatchEvent(clickEvent);

        expect(mockRouter.push).toHaveBeenLastCalledWith({ path: '/works', query: { tags: '53,12' } });
        expect(mockStore.dispatch).toHaveBeenLastCalledWith('Works/search', { tags: ['53', '12'] });
    });

    it('restores filters from storage and route tags', async () => {
        sessionStorage.setItem('asmr-ult:tag-filters', JSON.stringify([{ id: '53', label: 'Ear Cleaning' }]));
        mockRouter.currentRoute = { path: '/works', query: { tags: '53' } };
        const app = document.getElementById('q-app');
        if (app) (app as any).__vue__.$route = mockRouter.currentRoute;

        await bridge.initialize();
        const tagFilters = new TagFilters();
        tagFilters.enable();

        const overlay = document.querySelector('.asmr-filter-overlay') as HTMLElement;
        expect(overlay.textContent).toContain('Ear Cleaning');
    });

    it('renders persisted tag labels as text instead of executable HTML', async () => {
        sessionStorage.setItem('asmr-ult:tag-filters', JSON.stringify([{
            id: '53',
            label: '<img src=x onerror="alert(1)">Ear Cleaning',
        }]));
        mockRouter.currentRoute = { path: '/works', query: { tags: '53' } };
        const app = document.getElementById('q-app');
        if (app) (app as any).__vue__.$route = mockRouter.currentRoute;

        await bridge.initialize();
        const tagFilters = new TagFilters();
        tagFilters.enable();

        const overlay = document.querySelector('.asmr-filter-overlay') as HTMLElement;
        expect(overlay.querySelector('img')).toBeNull();
        expect(overlay.textContent).toContain('<img src=x onerror="alert(1)">Ear Cleaning');
    });
});
