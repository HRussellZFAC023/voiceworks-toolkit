import type { KikoeruApp } from '../../types';

export interface MediaFile {
    hash: string;
    title: string;
    type?: string;
    mediaStreamUrl?: string;
    media_stream_url?: string;
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

export interface WorkTreeComponent extends KikoeruApp {
    onClickItem: (item: MediaFile) => void;
    fatherFolder?: MediaFile[];
    path?: MediaFile[];
    $nextTick?: (callback: () => void) => void;
}
