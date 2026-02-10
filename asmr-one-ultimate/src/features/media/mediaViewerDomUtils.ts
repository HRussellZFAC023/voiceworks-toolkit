import { getCleanText } from '../../core/DomUtils';
import type { MediaFile } from './types';
import {
    getFileExtension,
    isImageExtension,
    isPdfExtension,
    isTextExtension,
    isVideoExtension,
    stripTrailingTranslationLabel,
} from './mediaFileUtils';

export type ViewerMediaType = 'image' | 'video' | 'pdf' | 'text';

export type Vue2MediaElement = HTMLElement & {
    __vue__?: Record<string, unknown> & {
        $attrs?: Record<string, unknown>;
        $props?: Record<string, unknown>;
        id?: string;
    };
};

export function resolveMediaTypeFromTitle(title: string): ViewerMediaType | null {
    const clean = stripTrailingTranslationLabel(title);
    const ext = getFileExtension(clean);
    if (isImageExtension(ext)) return 'image';
    if (isVideoExtension(ext)) return 'video';
    if (isPdfExtension(ext)) return 'pdf';
    if (isTextExtension(ext)) return 'text';
    return null;
}

function normalizeMediaType(type: string | undefined): string {
    return String(type || '').trim().toLowerCase();
}

export function resolveMediaTypeFromTypeField(type: string | undefined): ViewerMediaType | null {
    const mediaType = normalizeMediaType(type);
    if (!mediaType) return null;
    if (mediaType === 'image') return 'image';
    if (mediaType === 'video') return 'video';
    if (mediaType === 'pdf' || mediaType === 'application/pdf') return 'pdf';
    if (mediaType === 'text') return 'text';
    return null;
}

export function resolveMediaTypeForCandidate(
    title: string,
    explicitType?: string,
): ViewerMediaType | null {
    return resolveMediaTypeFromTitle(title) || resolveMediaTypeFromTypeField(explicitType);
}

export function matchesRequestedMediaType(
    item: Pick<MediaFile, 'title' | 'type'>,
    requestedType: ViewerMediaType,
): boolean {
    const mediaType = resolveMediaTypeForCandidate(item.title || '', item.type);
    return mediaType === requestedType;
}

export function getMediaLabelElement(qItem: Element): Element | null {
    return qItem.querySelector('.q-item__label')
        || qItem.querySelector('.q-item__section--main');
}

export function getMediaTitleFromListItem(qItem: Element): string {
    const label = getMediaLabelElement(qItem);
    if (!label) return '';
    const raw = getCleanText(label).replace(/\s+/g, ' ');
    return stripTrailingTranslationLabel(raw);
}

export function readMediaItemFromVueElement(vueEl: Vue2MediaElement): MediaFile | null {
    const vm = vueEl.__vue__;
    if (!vm) return null;

    const candidates = [
        vm.$attrs?.item,
        vm.item,
        vm.$props?.item,
        vm.file,
        vm.$props?.file,
        vm.node,
        vm.$props?.node,
    ] as unknown[];

    for (const candidate of candidates) {
        const media = candidate as MediaFile | null | undefined;
        if (media && typeof media.hash === 'string' && media.hash) {
            return media;
        }
    }
    return null;
}

export function readMediaHashFromElement(qItem: Vue2MediaElement): string {
    const fromData = qItem.dataset.asmrHash
        || qItem.dataset.asmrFlatHash
        || qItem.getAttribute('data-hash')
        || '';
    if (fromData) return fromData;
    return typeof qItem.__vue__?.id === 'string' ? qItem.__vue__!.id : '';
}

const IGNORE_CLICK_SELECTOR = [
    '[data-xxcopy]',
    '[data-asmr-transcript]',
    '.asmr-transcript-btn',
    'button',
    'a',
    'input',
    'textarea',
    'select',
    '[role="button"]',
].join(', ');

export function shouldIgnoreDelegatedClickTarget(target: HTMLElement, qItem: HTMLElement): boolean {
    const interactive = target.closest(IGNORE_CLICK_SELECTOR) as HTMLElement | null;
    return !!interactive && qItem.contains(interactive);
}
