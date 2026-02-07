import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AdvancedSearch } from '../../src/features/AdvancedSearch';
import { RouteStateSync } from '../../src/features/RouteStateSync';
import { AppStore } from '../../src/store/AppStore';
import { KikoeruBridge } from '../../src/infrastructure/KikoeruBridge';
vi.mock('../../src/infrastructure/KikoeruBridge');
vi.mock('../../src/services/TranslationService');

describe('AdvancedSearch Sort Integration', () => {
    let advancedSearch: AdvancedSearch;
    let bridge: any;

    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();

        const mockSortOptions = [
            { label: 'works.releaseDesc', order: 'release', sort: 'desc' },
            { label: 'works.releaseAsc', order: 'release', sort: 'asc' },
            { label: 'works.ratingDesc', order: 'rating', sort: 'desc' },
            { label: 'works.new', order: 'create_date', sort: 'desc' },
        ];
        const mockWorksVm = {
            sortOption: mockSortOptions[0],
            sortOptions: mockSortOptions,
        };

        // Mock Bridge
        bridge = {
            router: { push: vi.fn().mockResolvedValue(undefined) },
            findComponent: vi.fn().mockReturnValue(mockWorksVm),
            app: { $t: (key: string) => key },
        };
        vi.spyOn(KikoeruBridge, 'getInstance').mockReturnValue(bridge);

        // Mock RouteStateSync
        const mockSync = {
            syncDisplayToHost: vi.fn(),
            getSortLabel: vi.fn().mockReturnValue('Sorted Label'),
        };
        vi.spyOn(RouteStateSync, 'getInstance').mockReturnValue(mockSync as any);

        // Mock AppStore
        vi.spyOn(AppStore, 'setSearchState').mockImplementation(() => { });
        vi.spyOn(AppStore, 'state', 'get').mockReturnValue({ search: {} } as any);

        // Setup DOM for dialog
        document.body.innerHTML = '<div id="asmr-overlay-root"></div>';

        advancedSearch = new AdvancedSearch();
    });

    it('should update AppStore and RouteStateSync display when sort order changes', async () => {
        // Initialize dialog
        await advancedSearch.open();
        const dialog = document.querySelector('.asmr-advanced-search-dialog') as HTMLElement;
        const select = dialog.querySelector('.asmr-sort-order') as HTMLSelectElement;

        // Simulate change
        select.value = 'rating';
        select.dispatchEvent(new Event('change'));

        // Verify AppStore update
        expect(AppStore.setSearchState).toHaveBeenCalledWith(expect.objectContaining({
            pendingOrder: 'rating'
        }));

        // Verify RouteStateSync display update
        const mockSync = RouteStateSync.getInstance();
        expect(mockSync.syncDisplayToHost).toHaveBeenCalled();
        expect(mockSync.getSortLabel).toHaveBeenCalledWith('rating', 'desc');
    });

    it('should update AppStore and RouteStateSync display when sort direction changes', async () => {
        await advancedSearch.open();
        const dialog = document.querySelector('.asmr-advanced-search-dialog') as HTMLElement;
        const ascBtn = dialog.querySelector('.asmr-sort-asc') as HTMLElement;

        // Simulate click
        ascBtn.click();

        // Verify AppStore update
        expect(AppStore.setSearchState).toHaveBeenCalledWith(expect.objectContaining({
            pendingSort: 'asc'
        }));

        // Verify RouteStateSync display update
        const mockSync = RouteStateSync.getInstance();
        expect(mockSync.syncDisplayToHost).toHaveBeenCalled();
        expect(mockSync.getSortLabel).toHaveBeenCalledWith('release', 'asc');
    });
});
