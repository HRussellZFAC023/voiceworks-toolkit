import type { WorkTreeComponent as HostWorkTreeComponent } from '../../types';

export interface MediaFile {
    hash: string;
    title: string;
    type?: string;
    mediaStreamUrl?: string;
    media_stream_url?: string;
    mediaDownloadUrl?: string;
    media_download_url?: string;
    /** Expected upstream file size in bytes, when supplied by /api/tracks. */
    size?: number;
    [key: string]: unknown;
}

export interface TouchState {
    startX: number;
    startY: number;
    startTime: number;
}

export interface DragState {
    isDragging: boolean;
    didDrag: boolean; // Track if actual dragging occurred (to prevent click)
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
}

export interface WorkTreeComponent extends HostWorkTreeComponent {
    onClickItem: (item: MediaFile) => void;
    fatherFolder?: MediaFile[];
    path: string[];
    $nextTick?: (callback: () => void) => void;
}
