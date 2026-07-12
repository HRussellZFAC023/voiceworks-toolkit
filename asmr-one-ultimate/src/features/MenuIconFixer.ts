
export class MenuIconFixer {
    private observer: MutationObserver | null = null;
    private enabled = false;
    // Map existing text labels (English) to Material Icon names
    // We can expand this for JP if needed, but English matching is usually safer as key
    private iconMap: Record<string, string> = {
        'Marked': 'bookmark',
        'Listening': 'headset',
        'Listened': 'check',
        'Replay': 'replay',
        'Postponed': 'schedule',
        // JP Fallbacks (just in case, though the UI seems English based on context)
        '気になる': 'bookmark',
        '視聴中': 'headset',
        '視聴済': 'check',
        'リプレイ': 'replay',
        '後で見る': 'schedule'
    };

    public enable(): void {
        if (this.enabled) return;
        this.enabled = true;

        this.observer = new MutationObserver((mutations) => {
            if (!this.enabled) return;
            for (const mutation of mutations) {
                // Check for added nodes
                mutation.addedNodes.forEach((node) => {
                    if (node instanceof HTMLElement) {
                        // If a menu was added directly or contains a menu
                        if (node.classList.contains('q-menu') || node.querySelector('.q-menu')) {
                            this.fixIcons(node);
                        }
                    }
                });
            }
        });

        // Watch the body for menu injections (Quasar appends menus to body)
        this.observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Initial check in case menu is already open
        this.fixIcons(document.body);
    }

    private fixIcons(root: HTMLElement): void {
        if (!this.enabled) return;
        // Find all menu items
        const items = root.querySelectorAll('.q-menu .q-item');
        items.forEach((item) => {
            const labelNode = item.querySelector('.q-item__label');
            const iconNode = item.querySelector('.q-item__section--avatar .q-icon');

            if (labelNode) {
                const labelText = labelNode.textContent?.trim() || '';
                const iconName = this.iconMap[labelText];

                if (iconName) {
                    if (iconNode) {
                        // Replace the existing icon text content
                        const icon = iconNode as HTMLElement;
                        if (icon.dataset.asmrIconOriginal === undefined) {
                            icon.dataset.asmrIconOriginal = icon.textContent || '';
                        }
                        icon.dataset.asmrIconPatched = 'true';
                        iconNode.textContent = iconName;
                    } else {
                        // Inject missing icon section
                        const section = document.createElement('div');
                        section.className = 'q-item__section column q-item__section--avatar';
                        section.dataset.asmrIconInjected = 'true';

                        const icon = document.createElement('i');
                        icon.className = 'q-icon material-icons';
                        icon.textContent = iconName;
                        icon.setAttribute('aria-hidden', 'true');
                        icon.setAttribute('role', 'presentation');

                        section.appendChild(icon);
                        item.insertBefore(section, item.firstChild);
                        // Mark as patched to avoid re-processing if needed, though mutation observer handles added nodes
                        (item as HTMLElement).dataset.asmrIconPatched = 'true';
                    }
                }
            }
        });
    }

    public disable(): void {
        this.enabled = false;
        this.observer?.disconnect();
        this.observer = null;
        document.querySelectorAll<HTMLElement>('[data-asmr-icon-injected="true"]')
            .forEach((section) => section.remove());
        document.querySelectorAll<HTMLElement>('[data-asmr-icon-original]')
            .forEach((icon) => {
                icon.textContent = icon.dataset.asmrIconOriginal || '';
                delete icon.dataset.asmrIconOriginal;
                delete icon.dataset.asmrIconPatched;
            });
        document.querySelectorAll<HTMLElement>('[data-asmr-icon-patched="true"]')
            .forEach((item) => delete item.dataset.asmrIconPatched);
    }
}
