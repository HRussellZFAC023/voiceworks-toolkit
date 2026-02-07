export const HeaderActions = {
    ensure(): HTMLElement | null {
        // Try multiple selectors for the main toolbar
        const toolbar = document.querySelector('.q-header .q-toolbar') ||
            document.querySelector('.q-toolbar') ||
            document.querySelector('header .row');

        if (!toolbar) return null;

        let container = toolbar.querySelector('.asmr-header-actions') as HTMLElement | null;
        if (!container) {
            container = document.createElement('div');
            container.className = 'asmr-header-actions row items-center q-gutter-xs q-pl-md no-wrap';

            // Try to place after search bar
            const search = toolbar.querySelector('.q-field, .q-input, [role="search"]');
            if (search && search.closest('.q-toolbar') === toolbar) {
                // Add flexible space between search and actions
                const spacer = document.createElement('div');
                spacer.className = 'q-space asmr-header-spacer';
                search.insertAdjacentElement('afterend', spacer);
                spacer.insertAdjacentElement('afterend', container);
            } else {
                // Otherwise append to end
                toolbar.appendChild(container);
            }
        }

        // Re-check spacer if search exists (in case container was already there but spacer wasn't)
        const search = toolbar.querySelector('.q-field, .q-input, [role="search"]');
        if (search && search.closest('.q-toolbar') === toolbar) {
            if (!toolbar.querySelector('.asmr-header-spacer')) {
                const spacer = document.createElement('div');
                spacer.className = 'q-space asmr-header-spacer';
                search.insertAdjacentElement('afterend', spacer);
                spacer.insertAdjacentElement('afterend', container);
            }
        }

        return container;
    }
};
