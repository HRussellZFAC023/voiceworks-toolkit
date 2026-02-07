
export class MenuIconFixer {
    private observer: MutationObserver | null = null;
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
        if (this.observer) return;

        this.observer = new MutationObserver((mutations) => {
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
                        iconNode.textContent = iconName;
                    } else {
                        // Inject missing icon section
                        const section = document.createElement('div');
                        section.className = 'q-item__section column q-item__section--avatar';

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
        this.observer?.disconnect();
        this.observer = null;
    }
}
