import type { DownloadMediaCategory } from './DownloadDomain';

const EXTENSION_CATEGORIES: Readonly<Record<string, DownloadMediaCategory>> = Object.freeze({
    // Audio
    aac: 'audio', aiff: 'audio', alac: 'audio', ape: 'audio', flac: 'audio', m4a: 'audio',
    mp3: 'audio', oga: 'audio', ogg: 'audio', opus: 'audio', wav: 'audio', wma: 'audio',
    // Video
    avi: 'video', flv: 'video', m4v: 'video', mkv: 'video', mov: 'video', mp4: 'video',
    mpeg: 'video', mpg: 'video', ogv: 'video', ts: 'video', webm: 'video', wmv: 'video',
    // Images
    avif: 'image', bmp: 'image', gif: 'image', heic: 'image', heif: 'image', jpeg: 'image',
    jpg: 'image', jxl: 'image', png: 'image', svg: 'image', tif: 'image', tiff: 'image', webp: 'image',
    // Text, subtitles, and common document-like ancillary files
    ass: 'text', csv: 'text', html: 'text', htm: 'text', json: 'text', log: 'text', lrc: 'text',
    md: 'text', nfo: 'text', pdf: 'text', srt: 'text', ssa: 'text', txt: 'text', vtt: 'text', xml: 'text',
});

export function fileExtension(filename: string): string {
    const basename = filename.replace(/^.*[\\/]/, '');
    const dot = basename.lastIndexOf('.');
    return dot > 0 && dot < basename.length - 1 ? basename.slice(dot + 1).toLowerCase() : '';
}

/** A recognised filename extension is authoritative; host type is only a fallback. */
export function classifyDownloadMedia(filename: string, declaredType?: string | null): DownloadMediaCategory {
    const extensionCategory = EXTENSION_CATEGORIES[fileExtension(filename)];
    if (extensionCategory) return extensionCategory;

    switch (declaredType?.trim().toLowerCase()) {
        case 'audio': return 'audio';
        case 'video': return 'video';
        case 'image': return 'image';
        case 'text': return 'text';
        default:
            return 'unknown';
    }
}
