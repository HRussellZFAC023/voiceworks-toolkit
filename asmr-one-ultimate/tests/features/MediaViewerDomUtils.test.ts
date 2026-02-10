import { describe, expect, it } from 'vitest';
import {
    getMediaTitleFromListItem,
    matchesRequestedMediaType,
    readMediaHashFromElement,
    readMediaItemFromVueElement,
    resolveMediaTypeForCandidate,
    resolveMediaTypeFromTypeField,
    resolveMediaTypeFromTitle,
    shouldIgnoreDelegatedClickTarget,
} from '../../src/features/media/mediaViewerDomUtils';

describe('mediaViewerDomUtils', () => {
    it('resolves media types from file titles', () => {
        expect(resolveMediaTypeFromTitle('image.png')).toBe('image');
        expect(resolveMediaTypeFromTitle('clip.mp4')).toBe('video');
        expect(resolveMediaTypeFromTitle('doc.pdf')).toBe('pdf');
        expect(resolveMediaTypeFromTitle('notes.vtt')).toBe('text');
        expect(resolveMediaTypeFromTitle('track.mp3')).toBeNull();
    });

    it('resolves media type from explicit type field', () => {
        expect(resolveMediaTypeFromTypeField('image')).toBe('image');
        expect(resolveMediaTypeFromTypeField('video')).toBe('video');
        expect(resolveMediaTypeFromTypeField('application/pdf')).toBe('pdf');
        expect(resolveMediaTypeFromTypeField('text')).toBe('text');
        expect(resolveMediaTypeFromTypeField('audio')).toBeNull();
    });

    it('prefers title extension but falls back to explicit type field', () => {
        expect(resolveMediaTypeForCandidate('sample.weird', 'video')).toBe('video');
        expect(resolveMediaTypeForCandidate('photo.jpg', 'text')).toBe('image');
    });

    it('matches requested media type using extension or media type field', () => {
        expect(matchesRequestedMediaType({ title: 'sample.unknown', type: 'video' }, 'video')).toBe(true);
        expect(matchesRequestedMediaType({ title: 'sample.unknown', type: 'application/pdf' }, 'pdf')).toBe(true);
        expect(matchesRequestedMediaType({ title: 'sample.unknown', type: 'text' }, 'text')).toBe(true);
        expect(matchesRequestedMediaType({ title: 'sample.bin', type: 'audio' }, 'video')).toBe(false);
    });

    it('extracts clean media title from list item label', () => {
        const qItem = document.createElement('div');
        qItem.innerHTML = '<div class="q-item__label">image01.jpg (Translated)</div>';
        expect(getMediaTitleFromListItem(qItem)).toBe('image01.jpg');
    });

    it('reads media item candidates from vue element data', () => {
        const el = document.createElement('div') as HTMLElement & { __vue__?: Record<string, unknown> };
        el.__vue__ = {
            $attrs: { item: { hash: 'h1', title: 'a.png', type: 'image' } },
        };

        const item = readMediaItemFromVueElement(el as any);
        expect(item?.hash).toBe('h1');
        expect(item?.title).toBe('a.png');
    });

    it('reads hash from data attributes and vue id fallback', () => {
        const el = document.createElement('div') as HTMLElement & { __vue__?: Record<string, unknown> };
        el.dataset.asmrHash = 'h-data';
        expect(readMediaHashFromElement(el as any)).toBe('h-data');

        delete el.dataset.asmrHash;
        el.setAttribute('data-hash', 'h-attr');
        expect(readMediaHashFromElement(el as any)).toBe('h-attr');

        el.removeAttribute('data-hash');
        el.__vue__ = { id: 'h-vue' };
        expect(readMediaHashFromElement(el as any)).toBe('h-vue');
    });

    it('ignores delegated click on interactive inner controls', () => {
        const qItem = document.createElement('div');
        qItem.className = 'q-item';
        const button = document.createElement('button');
        qItem.appendChild(button);
        const label = document.createElement('span');
        qItem.appendChild(label);

        expect(shouldIgnoreDelegatedClickTarget(button, qItem)).toBe(true);
        expect(shouldIgnoreDelegatedClickTarget(label, qItem)).toBe(false);
    });
});
