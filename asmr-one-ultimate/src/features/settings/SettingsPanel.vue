<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import SettingsToggle from './SettingsToggle.vue';
import SettingsInput from './SettingsInput.vue';
import SettingsHotkeyInput from './SettingsHotkeyInput.vue';
import { useI18n } from '../../composables/useI18n';
import { useConfig } from '../../composables/useConfig';
import { useEventBus } from '../../composables/useEventBus';
import { AppStore } from '../../store/AppStore';
import { StorageManager } from '../../infrastructure/StorageManager';
import { TranslationService } from '../../services/TranslationService';
import { CacheKeys, SharedCache } from '../../core/Cache';
import { Logger } from '../../core/Utils';
import { Whisper } from '../Whisper';
import type { ConfigKey } from '../../types';
// @ts-ignore – Vite ?raw import
import PROXY_WORKER_CODE from '../../../dlsite-proxy-worker.js?raw';

const { t, format } = useI18n();
const { on } = useEventBus();

// ============================================================================
// Feature toggle visibility mapping
// ============================================================================

const featureSectionMap: Record<string, string> = {
    enableVectorSearch: 'magic',
    enableWhisper: 'whisper',
    enablePlayerTranslator: 'translation',
    enableJpdb: 'jpdb',
    autoProgress: 'autoprogress',
    enableStoreBackup: 'storage',
};

// Reactive config values for controlling section visibility
const enableVectorSearch = useConfig('enableVectorSearch');
const enableWhisper = useConfig('enableWhisper');
const enablePlayerTranslator = useConfig('enablePlayerTranslator');
const autoProgress = useConfig('autoProgress');
const playlistAutoProgress = useConfig('playlistAutoProgress');
const enableStoreBackup = useConfig('enableStoreBackup');
const preferLocalTranslation = useConfig('preferLocalTranslation');
const enableJpdb = useConfig('enableJpdb');

const sectionVisibility = computed(() => ({
    magic: enableVectorSearch.value,
    whisper: enableWhisper.value,
    translation: enablePlayerTranslator.value,
    jpdb: enableJpdb.value,
    autoprogress: autoProgress.value || playlistAutoProgress.value,
    storage: enableStoreBackup.value,
}));

// ============================================================================
// Whisper status
// ============================================================================

const WHISPER_MODEL = 'onnx-community/whisper-small_timestamped';

const whisperDownloadStatus = ref({
    isLoading: false,
    progress: 0,
    message: '',
});

const whisperModelStatusText = ref(t('whisperReady'));
const whisperModelStatusColor = ref('');

const whisperDownloadLabel = computed(() => {
    const status = whisperDownloadStatus.value;
    const whisperState = AppStore.state.whisper;
    const isLoading = whisperState.isLoadingModel || status.isLoading;
    const progress = status.isLoading ? status.progress : whisperState.progress;
    const message = status.message || whisperState.progressMessage || '';
    const hasError = !isLoading && !whisperState.isTranscribing && (status.message || whisperState.progressMessage) && whisperState.progress === 0;

    if (isLoading) {
        const capped = Math.min(99, Math.max(0, progress || 0));
        const baseMessage = t('downloadWhisperModelLoading');
        const modelLabel = WHISPER_MODEL;
        const progressSuffix = capped > 0 ? ` (${Math.round(capped)}%)` : '';
        return `${baseMessage} - ${modelLabel}${progressSuffix}`;
    } else if (progress === 100) {
        return t('downloadWhisperModelReady') || 'Ready';
    } else if (hasError) {
        return format('downloadWhisperModelFailed', { message: message || t('whisperUnknownError') });
    }
    return t('downloadWhisperModelSub');
});

const whisperDownloadIcon = computed(() => {
    const status = whisperDownloadStatus.value;
    const whisperState = AppStore.state.whisper;
    const isLoading = whisperState.isLoadingModel || status.isLoading;
    const progress = status.isLoading ? status.progress : whisperState.progress;
    const message = status.message || whisperState.progressMessage || '';
    const hasError = !isLoading && !whisperState.isTranscribing && (status.message || whisperState.progressMessage) && whisperState.progress === 0;

    if (isLoading) return 'hourglass_empty';
    if (progress === 100) return 'check';
    if (hasError) return 'warning';
    return 'download';
});

const whisperDownloadDisabled = computed(() => {
    const status = whisperDownloadStatus.value;
    return AppStore.state.whisper.isLoadingModel || status.isLoading;
});

const whisperDownloadLabelColor = computed(() => {
    const status = whisperDownloadStatus.value;
    const whisperState = AppStore.state.whisper;
    const isLoading = whisperState.isLoadingModel || status.isLoading;
    const hasError = !isLoading && !whisperState.isTranscribing && (status.message || whisperState.progressMessage) && whisperState.progress === 0;
    return hasError ? '#e57373' : '';
});

function updateWhisperModelStatus() {
    const state = AppStore.state.whisper;
    const cachedReady = SharedCache.get<boolean>(CacheKeys.whisperModelReady(WHISPER_MODEL)) === true;
    const isErrorState = !state.isLoadingModel && !state.isTranscribing && state.progress === 0 && !!state.progressMessage;

    if (state.isLoadingModel && !cachedReady) {
        whisperModelStatusText.value = t('whisperLoading');
        whisperModelStatusColor.value = '';
    } else if (state.isTranscribing) {
        whisperModelStatusText.value = t('whisperTranscribing');
        whisperModelStatusColor.value = '';
    } else if (state.progress === 100) {
        whisperModelStatusText.value = t('whisperReady') || 'Ready';
        whisperModelStatusColor.value = '';
    } else if (isErrorState) {
        whisperModelStatusText.value = state.progressMessage;
        whisperModelStatusColor.value = '#e57373';
    } else {
        whisperModelStatusText.value = t('whisperReady') || 'Ready';
        whisperModelStatusColor.value = '';
    }
}

function downloadWhisperModel() {
    whisperDownloadStatus.value = { isLoading: true, progress: 0, message: t('downloadWhisperModelSub') };
    updateWhisperModelStatus();
    try { Whisper.getInstance().warmupModel(true); }
    catch (e) { Logger.warn('[SettingsPanel] Failed to warmup Whisper model:', e); }
}

// ============================================================================
// Translation status
// ============================================================================

interface ModelProgress { isLoading: boolean; progress: number; message: string; }
const modelProgressMap = reactive(new Map<string, ModelProgress>());

/** Aggregate: is ANY model currently loading? */
const translationIsLoading = computed(() => {
    for (const v of modelProgressMap.values()) { if (v.isLoading) return true; }
    return false;
});
/** Aggregate: are ALL models done? */
const translationAllDone = computed(() => {
    if (modelProgressMap.size === 0) return TranslationService.hasLocalTranslator();
    for (const v of modelProgressMap.values()) { if (v.isLoading || v.progress < 100) return false; }
    return true;
});

const translationDownloadLabel = computed(() => {
    if (translationIsLoading.value) {
        const baseMessage = t('downloadTranslationModelLoading');
        const parts: string[] = [];
        for (const [model, status] of modelProgressMap) {
            if (!status.isLoading) continue;
            const short = model.replace('Xenova/', '').replace('opus-mt-', '');
            const capped = Math.min(99, Math.max(0, status.progress || 0));
            parts.push(capped > 0 ? `${short} (${Math.round(capped)}%)` : short);
        }
        return parts.length > 0 ? `${baseMessage} - ${parts.join(', ')}` : baseMessage;
    } else if (translationAllDone.value) {
        const loadedModels = TranslationService.getLoadedModels();
        if (loadedModels.length > 0) {
            const modelNames = loadedModels
                .filter(m => m.ready)
                .map(m => m.model.replace('Xenova/', '').replace('opus-mt-', ''))
                .join(', ');
            return modelNames ? format('modelsLoaded', { models: modelNames }) : (t('downloadModelReady') || 'Ready');
        }
        return t('downloadModelReady') || 'Ready';
    }
    // Fallback: show first message if available
    for (const v of modelProgressMap.values()) { if (v.message) return v.message; }
    return t('autoModelSelection');
});

const translationDownloadIcon = computed(() => {
    if (translationIsLoading.value) return 'hourglass_empty';
    if (translationAllDone.value) return 'check';
    return 'download';
});

const translationDownloadDisabled = computed(() => translationIsLoading.value);

function downloadTranslationModel() {
    modelProgressMap.set('auto', { isLoading: true, progress: 0, message: t('downloadModelSub') });
    TranslationService.warmupLocalModel().then(() => {
        modelProgressMap.delete('auto');
    }).catch((e) => {
        Logger.warn('[SettingsPanel] Failed to warmup translation model:', e);
        modelProgressMap.set('auto', { isLoading: false, progress: 0, message: e.message || 'Error' });
    });
}

function clearTranslationCache() {
    if (!window.confirm(t('clearTranslationCacheConfirm'))) return;
    const count = TranslationService.clearCache();
    alert(format('clearTranslationCacheSuccess', { count }));
}

// ============================================================================
// Storage actions
// ============================================================================

function backupSettings() {
    StorageManager.downloadBackup();
}

async function restoreSettings() {
    if (await StorageManager.restoreBackup() > 0) window.location.reload();
}

async function factoryReset() {
    if (!window.confirm(t('factoryResetConfirm'))) return;
    if (!window.confirm(t('factoryResetConfirm2'))) return;
    await StorageManager.nuke();
}

// ============================================================================
// Feature toggle change handlers
// ============================================================================

function onToggleChange(key: ConfigKey, newVal: boolean) {
    if (key === 'preferLocalTranslation' && newVal) {
        if (!TranslationService.hasLocalTranslator()) {
            modelProgressMap.set('auto', { isLoading: true, progress: 0, message: t('downloadModelSub') });
            TranslationService.ensureLocalModelReady().catch((e) => {
                Logger.warn('[SettingsPanel] Failed to ensure translation model ready:', e);
            });
        }
    } else if (key === 'preferLocalTranslation' && !newVal) {
        TranslationService.disableLocalTranslation('user-disabled');
        modelProgressMap.clear();
    }
}

// ============================================================================
// Event bus listeners
// ============================================================================

on('whisper:progress', (payload) => {
    if (payload?.stage === 'ready') {
        whisperDownloadStatus.value = { isLoading: false, progress: 100, message: '' };
        AppStore.setWhisperState({
            isTranscribing: AppStore.state.whisper.isTranscribing,
            isLoadingModel: false,
            progress: 100,
            progressMessage: '',
            currentTrackSrc: AppStore.state.whisper.currentTrackSrc,
        });
        updateWhisperModelStatus();
        return;
    }
    if (payload?.stage !== 'model') return;
    if (!AppStore.state.whisper.isLoadingModel) return;
    whisperDownloadStatus.value = {
        isLoading: true,
        progress: payload?.percent ?? 0,
        message: payload?.message || '',
    };
    updateWhisperModelStatus();
});

on('whisper:error', (payload) => {
    whisperDownloadStatus.value = {
        isLoading: false,
        progress: 0,
        message: payload?.message || '',
    };
    updateWhisperModelStatus();
});

on('whisper:fallback', (payload) => {
    const fallbackModel = payload?.fallbackModel || '';
    const reason = payload?.reason || '';
    const modelShort = fallbackModel.split('/').pop() || fallbackModel;
    const reasonShort = reason.length > 60 ? reason.slice(0, 57) + '...' : reason;
    whisperDownloadStatus.value = {
        isLoading: true,
        progress: 10,
        message: format('whisperFallbackApplied', { model: modelShort, reason: reasonShort }),
    };
    updateWhisperModelStatus();
});

on('translation:progress', (payload) => {
    const model = payload?.model || 'unknown';
    if (payload?.stage === 'ready') {
        modelProgressMap.set(model, { isLoading: false, progress: 100, message: '' });
        modelProgressMap.delete('auto'); // clear the placeholder
        return;
    }
    const existing = modelProgressMap.get(model);
    if (existing && !existing.isLoading && existing.progress === 100 && payload?.stage === 'model') return; // already done
    modelProgressMap.set(model, {
        isLoading: payload?.stage === 'model',
        progress: payload?.percent ?? 0,
        message: payload?.message || '',
    });
});

// ============================================================================
// Initialization
// ============================================================================

onMounted(() => {
    // Check if whisper model is cached
    if (SharedCache.get<boolean>(CacheKeys.whisperModelReady(WHISPER_MODEL))) {
        whisperDownloadStatus.value = { isLoading: false, progress: 100, message: '' };
    }
    updateWhisperModelStatus();

    // Auto-load translation models if local translation is enabled
    if (preferLocalTranslation.value !== false) {
        if (!TranslationService.hasLocalTranslator()) {
            modelProgressMap.set('auto', { isLoading: true, progress: 0, message: t('downloadModelSub') });
            TranslationService.ensureLocalModelReady().then(() => {
                modelProgressMap.delete('auto');
            }).catch((e) => {
                Logger.warn('[SettingsPanel] Failed to auto-load translation models:', e);
                modelProgressMap.set('auto', { isLoading: false, progress: 0, message: e.message || 'Failed' });
            });
        }
    }
});

// ============================================================================
// Proxy setup guide
// ============================================================================

const proxyWorkerCode = PROXY_WORKER_CODE.trim();
const proxyCopied = ref(false);
let proxyCopyTimer: ReturnType<typeof setTimeout> | null = null;

function copyProxyCode() {
    navigator.clipboard.writeText(proxyWorkerCode).then(() => {
        proxyCopied.value = true;
        if (proxyCopyTimer) clearTimeout(proxyCopyTimer);
        proxyCopyTimer = setTimeout(() => { proxyCopied.value = false; }, 2000);
    });
}

const DISCORD_USERNAME = 'henry281199';

function copyDiscord() {
    navigator.clipboard.writeText(DISCORD_USERNAME);
}

// ============================================================================
// Credits data
// ============================================================================

const GITHUB_URL = 'https://github.com/HRussellZFAC023/voiceworks-toolkit';

const credits = [
    // Platforms & Community
    { name: 'asmr.one', url: 'https://asmr.one', descKey: 'creditsAsmrOnline' },
    { name: 'Kikoeru', url: 'https://github.com/umonaca/kikoeru', descKey: 'creditsKikoeru' },
    { name: 'ASMR Collections', url: 'https://github.com/slashnephy/asmr-collections', descKey: 'creditsCollections' },
    { name: 'Subtitle Translator', url: 'https://greasyfork.org/ja/scripts/554143-asmr-one-subtitle-translator-to-english', descKey: 'creditsSubtitleTranslator' },
    { name: 'DLsite', url: 'https://www.dlsite.com', descKey: 'creditsDLsite' },
    { name: 'Yuro', url: 'https://github.com/Jeongcc/yuro', descKey: 'creditsYuro' },
    { name: 'Tampermonkey', url: 'https://www.tampermonkey.net', descKey: 'creditsTampermonkey' },
    // AI & ML Models
    { name: 'OpenAI Whisper', url: 'https://github.com/openai/whisper', descKey: 'creditsWhisper' },
    { name: 'Helsinki-NLP / Opus-MT', url: 'https://github.com/Helsinki-NLP/Opus-MT', descKey: 'creditsOpusMT' },
    { name: 'Xenova / onnx-community', url: 'https://huggingface.co/onnx-community', descKey: 'creditsXenova' },
    { name: 'Jina AI', url: 'https://jina.ai', descKey: 'creditsJina' },
    { name: 'Google Translate', url: 'https://translate.google.com', descKey: 'creditsGoogleTranslate' },
    { name: 'jpdb.io', url: 'https://jpdb.io', descKey: 'jpdbCredits' },
    { name: 'anki-jpdb.reader', url: 'https://github.com/Kagu-chan/anki-jpdb.reader', descKey: 'jpdbCreditsReader' },
    // Libraries & Frameworks
    { name: 'Transformers.js', url: 'https://huggingface.co/docs/transformers.js', descKey: 'creditsTransformers' },
    { name: 'ONNX Runtime', url: 'https://onnxruntime.ai', descKey: 'creditsONNXRuntime' },
    { name: 'Hugging Face', url: 'https://huggingface.co', descKey: 'creditsHuggingFace' },
    { name: 'Vue.js', url: 'https://vuejs.org', descKey: 'creditsVue' },
    { name: 'Quasar Framework', url: 'https://quasar.dev', descKey: 'creditsQuasar' },
    { name: 'PDF.js', url: 'https://mozilla.github.io/pdf.js/', descKey: 'creditsPdfJs' },
    { name: 'idb', url: 'https://github.com/jakearchibald/idb', descKey: 'creditsIdb' },
    { name: 'Fuse.js', url: 'https://www.fusejs.io', descKey: 'creditsFuseJs' },
    { name: 'vite-plugin-monkey', url: 'https://github.com/nicennnnnnnlee/tampermonkey-vite', descKey: 'creditsVitePluginMonkey' },
    { name: 'Google Material Icons', url: 'https://fonts.google.com/icons', descKey: 'creditsMaterialIcons' },
    // External Data Sources
    { name: 'HVDB', url: 'https://hvdb.me', descKey: 'creditsHVDB' },
    { name: 'Chobit', url: 'https://chobit.cc', descKey: 'creditsChobit' },
    { name: 'h2k Frequency Corpus', url: 'https://github.com/lexikon-tools', descKey: 'creditsH2k' },
];
</script>

<template>
    <div class="asmr-settings-panel">

        <!-- ============================================================ -->
        <!-- General Settings                                             -->
        <!-- ============================================================ -->
        <span class="text-weight-medium text-center flex q-my-md asmr-settings-header" id="asmr-general-settings-section-header">{{ t('generalSettings') }}</span>
        <div id="asmr-general-settings" class="asmr-settings-section rounded-borders q-list q-list--bordered q-list--dark bg-black" role="group" aria-labelledby="asmr-general-settings-section-header">
            <SettingsToggle config-key="enableLogging" :label="t('enableLogging')" :sublabel="t('enableLoggingSub')" icon="terminal" />
        </div>

        <!-- ============================================================ -->
        <!-- Subtitle Settings                                            -->
        <!-- ============================================================ -->
        <div id="asmr-subtitle-settings" class="asmr-settings-section rounded-borders q-list q-list--bordered q-list--dark bg-black">
            <SettingsInput config-key="primarySubtitleLang" :label="t('primaryLang')" :sublabel="t('primaryLangSub')" placeholder="e.g. ja, zh" icon="translate" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsInput config-key="subtitleLang" :label="t('targetLang')" :sublabel="t('targetLangSub')" placeholder="e.g. en, es, fr" icon="language" />
        </div>

        <!-- ============================================================ -->
        <!-- Feature Toggles                                              -->
        <!-- ============================================================ -->
        <span class="text-weight-medium text-center flex q-my-md asmr-settings-header" id="asmr-feature-settings-section-header">{{ t('featureToggles') }}</span>
        <div id="asmr-feature-settings-section" class="asmr-settings-section rounded-borders q-list q-list--bordered q-list--dark bg-black" role="group" aria-labelledby="asmr-feature-settings-section-header">
            <SettingsToggle config-key="enablePlaylistDiscovery" :label="t('enablePlaylistDiscovery')" :sublabel="t('enablePlaylistDiscoverySub')" icon="manage_search" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableContinueListening" :label="t('enableContinueListening')" :sublabel="t('enableContinueListeningSub')" icon="headset" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableVisitCounter" :label="t('enableVisitCounter')" :sublabel="t('enableVisitCounterSub')" icon="visibility" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableLearnerMode" :label="t('enableLearnerMode')" :sublabel="t('enableLearnerModeSub')" icon="school" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableJpdb" :label="t('enableJpdb')" :sublabel="t('enableJpdbSub')" icon="menu_book" @change="onToggleChange" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="learnerBlur" :label="t('learnerBlurLabel')" :sublabel="t('learnerBlurSub')" icon="blur_on" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="karaokeMode" :label="t('karaokeMode')" :sublabel="t('karaokeModeSub')" icon="music_note" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="segmentMode" :label="t('segmentMode')" :sublabel="t('segmentModeSub')" icon="segment" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableAdvancedSearch" :label="t('enableAdvancedSearch')" :sublabel="t('enableAdvancedSearchSub')" icon="search" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableWorkMetadata" :label="t('enableWorkMetadata')" :sublabel="t('enableWorkMetadataSub')" icon="info" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enablePlayerTranslator" :label="t('enablePlayerTranslator')" :sublabel="t('enablePlayerTranslatorSub')" icon="translate" @change="onToggleChange" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableSupportButton" :label="t('enableSupportButton')" :sublabel="t('enableSupportButtonSub')" icon="favorite" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableWorkTreeManager" :label="t('enableWorkTreeManager')" :sublabel="t('enableWorkTreeManagerSub')" icon="folder" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableTagFilters" :label="t('enableTagFilters')" :sublabel="t('enableTagFiltersSub')" icon="label_off" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableVectorSearch" :label="t('enableVectorSearch')" :sublabel="t('enableVectorSearchSub')" icon="saved_search" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableWhisper" :label="t('enableWhisper')" :sublabel="t('enableWhisperSub')" icon="record_voice_over" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableFavicon" :label="t('enableFavicon')" :sublabel="t('enableFaviconSub')" icon="image" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableMediaSession" :label="t('enableMediaSession')" :sublabel="t('enableMediaSessionSub')" icon="play_circle" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableMenuIconFixer" :label="t('enableMenuIconFixer')" :sublabel="t('enableMenuIconFixerSub')" icon="build" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableStoreBackup" :label="t('enableStoreBackup')" :sublabel="t('enableStoreBackupSub')" icon="save" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableHVDBLink" :label="t('enableHVDBLink')" :sublabel="t('enableHVDBLinkSub')" icon="link" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableInterfaceTranslator" :label="t('enableInterfaceTranslator')" :sublabel="t('enableInterfaceTranslatorSub')" icon="language" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enablePageTitleManager" :label="t('enablePageTitleManager')" :sublabel="t('enablePageTitleManagerSub')" icon="title" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableKeyboardManager" :label="t('enableKeyboardManager')" :sublabel="t('enableKeyboardManagerSub')" icon="keyboard" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableRouteStateSync" :label="t('enableRouteStateSync')" :sublabel="t('enableRouteStateSyncSub')" icon="sync" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableMediaViewer" :label="t('enableMediaViewer')" :sublabel="t('enableMediaViewerSub')" icon="photo_library" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableWorkTreeCopy" :label="t('enableWorkTreeCopy')" :sublabel="t('enableWorkTreeCopySub')" icon="content_copy" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableCommentSection" :label="t('enableCommentSection')" :sublabel="t('enableCommentSectionSub')" icon="comment" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableInfiniteScroll" :label="t('enableInfiniteScroll')" :sublabel="t('enableInfiniteScrollSub')" icon="autorenew" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableJoiTool" :label="t('enableJoiTool')" :sublabel="t('enableJoiToolSub')" icon="casino" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="alwaysShowJoi" :label="t('alwaysShowJoi')" :sublabel="t('alwaysShowJoiSub')" icon="casino" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="enableVisualizer" :label="t('enableVisualizer')" :sublabel="t('enableVisualizerSub')" icon="graphic_eq" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="alwaysShowVisualizer" :label="t('alwaysShowVisualizer')" :sublabel="t('alwaysShowVisualizerSub')" icon="graphic_eq" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="galleryAutoSlideshow" :label="t('galleryAutoSlideshow')" :sublabel="t('galleryAutoSlideshowSub')" icon="slideshow" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsInput config-key="galleryAutoSlideshowInterval" :label="t('galleryAutoSlideshowInterval')" :sublabel="t('galleryAutoSlideshowIntervalSub')" placeholder="6" icon="timer" />
        </div>

        <!-- ============================================================ -->
        <!-- Keyboard Shortcuts                                           -->
        <!-- ============================================================ -->
        <span class="text-weight-medium text-center flex q-my-md asmr-settings-header" id="asmr-hotkey-settings-section-header">{{ t('keyboardShortcuts') }}</span>
        <div id="asmr-hotkey-settings-section" class="asmr-settings-section rounded-borders q-list q-list--bordered q-list--dark bg-black" role="group" aria-labelledby="asmr-hotkey-settings-section-header">
            <SettingsHotkeyInput config-key="hotkeyPlayPause" :label="t('hotkeyPlayPause')" placeholder="Space" icon="play_arrow" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeyMute" :label="t('hotkeyMute')" placeholder="m" icon="volume_off" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeyFullscreen" :label="t('hotkeyFullscreen')" placeholder="f" icon="fullscreen" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeySeekBack" :label="t('hotkeySeekBack')" placeholder="←" icon="fast_rewind" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeySeekForward" :label="t('hotkeySeekForward')" placeholder="→" icon="fast_forward" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeySeekBackLong" :label="t('hotkeySeekBackLong')" placeholder="j" icon="fast_rewind" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeySeekForwardLong" :label="t('hotkeySeekForwardLong')" placeholder="l" icon="fast_forward" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeyVolumeUp" :label="t('hotkeyVolumeUp')" placeholder="↑" icon="volume_up" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeyVolumeDown" :label="t('hotkeyVolumeDown')" placeholder="↓" icon="volume_down" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeyPrevLine" :label="t('hotkeyPrevLine')" placeholder="[" icon="skip_previous" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeyNextLine" :label="t('hotkeyNextLine')" placeholder="]" icon="skip_next" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeyPrevTrack" :label="t('hotkeyPrevTrack')" placeholder="p" icon="skip_previous" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeyNextTrack" :label="t('hotkeyNextTrack')" placeholder="n" icon="skip_next" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeySpeedUp" :label="t('hotkeySpeedUp')" placeholder=">" icon="speed" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeySpeedDown" :label="t('hotkeySpeedDown')" placeholder="<" icon="speed" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeySpeedReset" :label="t('hotkeySpeedReset')" placeholder="=" icon="speed" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeyToggleBlur" :label="t('hotkeyToggleBlur')" placeholder="b" icon="blur_on" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeyToggleJP" :label="t('hotkeyToggleJP')" placeholder="J" icon="translate" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeyGalleryPrev" :label="t('hotkeyGalleryPrev')" placeholder="←" icon="navigate_before" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeyGalleryNext" :label="t('hotkeyGalleryNext')" placeholder="→" icon="navigate_next" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeyGalleryExclude" :label="t('hotkeyGalleryExclude')" placeholder="Del" icon="visibility_off" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsHotkeyInput config-key="hotkeyJpdbPopover" :label="t('hotkeyJpdbPopover')" placeholder="Shift+D" icon="menu_book" />
        </div>

        <!-- ============================================================ -->
        <!-- Radio Settings                                               -->
        <!-- ============================================================ -->
        <span class="text-weight-medium text-center flex q-my-md asmr-settings-header" id="asmr-radio-settings-section-header">{{ t('radioSettings') }}</span>
        <div id="asmr-radio-settings-section" class="asmr-settings-section rounded-borders q-list q-list--bordered q-list--dark bg-black" role="group" aria-labelledby="asmr-radio-settings-section-header">
            <SettingsToggle config-key="playAllInFolder" :label="t('playAll')" :sublabel="t('playAllSub')" icon="playlist_play" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="autoFilterFolders" :label="t('autoFilterFolders')" :sublabel="t('autoFilterFoldersSub')" icon="folder_open" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="shuffle" :label="t('shuffle')" :sublabel="t('shuffleSub')" icon="shuffle" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="loopPlaylist" :label="t('loopPlaylist')" :sublabel="t('loopPlaylistSub')" icon="repeat" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="radioUseFlatTracks" :label="t('radioFlatTracks')" :sublabel="t('radioFlatTracksSub')" icon="view_list" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="autoProgress" :label="t('autoProgress')" :sublabel="t('autoProgressSub')" icon="fast_forward" />
        </div>

        <!-- ============================================================ -->
        <!-- Playlist Settings                                            -->
        <!-- ============================================================ -->
        <span class="text-weight-medium text-center flex q-my-md asmr-settings-header" id="asmr-playlist-settings-section-header">{{ t('playlistSettings') }}</span>
        <div id="asmr-playlist-settings-section" class="asmr-settings-section rounded-borders q-list q-list--bordered q-list--dark bg-black" role="group" aria-labelledby="asmr-playlist-settings-section-header">
            <SettingsToggle config-key="playlistPlayAllInFolder" :label="t('playAll')" :sublabel="t('playAllSub')" icon="playlist_play" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="playlistAutoFilterFolders" :label="t('autoFilterFolders')" :sublabel="t('autoFilterFoldersSub')" icon="folder_open" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="playlistShuffle" :label="t('shuffle')" :sublabel="t('shuffleSub')" icon="shuffle" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="playlistLoopPlaylist" :label="t('loopPlaylist')" :sublabel="t('loopPlaylistSub')" icon="repeat" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="playlistUseFlatTracks" :label="t('radioFlatTracks')" :sublabel="t('radioFlatTracksSub')" icon="view_list" />
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <SettingsToggle config-key="playlistAutoProgress" :label="t('autoProgress')" :sublabel="t('autoProgressSub')" icon="fast_forward" />
        </div>

        <!-- ============================================================ -->
        <!-- Magic Search (Vector Search)                                 -->
        <!-- ============================================================ -->
        <!-- Semantic Search uses local embeddings (multilingual-e5-small) — no API key needed -->

        <!-- ============================================================ -->
        <!-- Whisper Settings                                             -->
        <!-- ============================================================ -->
        <template v-if="sectionVisibility.whisper">
            <span class="text-weight-medium text-center flex q-my-md asmr-settings-header" id="asmr-whisper-settings-section-header">{{ t('whisperSettings') }}</span>
            <div id="asmr-whisper-settings-section" class="asmr-settings-section rounded-borders q-list q-list--bordered q-list--dark bg-black" role="group" aria-labelledby="asmr-whisper-settings-section-header">
                <!-- Download Whisper Model -->
                <div role="listitem" class="q-py-sm q-item q-item-type row no-wrap q-item--dark">
                    <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
                        <i class="q-icon notranslate material-icons asmr-settings-icon" aria-hidden="true" role="presentation">cloud_download</i>
                    </div>
                    <div class="q-item__section column q-item__section--main justify-center">
                        <div class="q-item__label"><span class="text-weight-medium">{{ t('downloadWhisperModel') }}</span></div>
                        <div class="q-item__label q-item__label--caption text-caption">
                            <span class="text-weight-medium" :style="{ color: whisperDownloadLabelColor }">{{ whisperDownloadLabel }}</span>
                        </div>
                    </div>
                    <div class="q-item__section column q-item__section--side justify-center">
                        <button
                            tabindex="0"
                            type="button"
                            class="q-btn q-btn-item non-selectable no-outline q-btn--standard q-btn--rectangle q-btn--actionable q-focusable q-hoverable"
                            :class="{ disabled: whisperDownloadDisabled }"
                            :disabled="whisperDownloadDisabled"
                            :aria-label="t('downloadWhisperModel') || 'Download Whisper model'"
                            :title="t('downloadWhisperModel') || 'Download Whisper model'"
                            @click="downloadWhisperModel"
                        >
                            <span class="q-focus-helper"></span>
                            <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                                <i class="q-icon notranslate material-icons" aria-hidden="true" role="presentation">{{ whisperDownloadIcon }}</i>
                            </span>
                        </button>
                    </div>
                </div>
                <div class="q-px-md q-pb-md asmr-settings-hint">
                    <div class="text-caption text-grey-7 asmr-settings-hint-text" :style="{ color: whisperModelStatusColor }">{{ whisperModelStatusText }}</div>
                </div>
                <div class="q-px-md q-pb-md asmr-settings-hint">
                    <div class="text-caption text-grey-7 asmr-settings-hint-text">{{ t('whisperGpuHint') }}</div>
                </div>
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsToggle config-key="alwaysTranscribe" :label="t('alwaysTranscribe')" :sublabel="t('alwaysTranscribeSub')" icon="auto_fix_high" />
            </div>
        </template>

        <!-- ============================================================ -->
        <!-- Translation Settings                                         -->
        <!-- ============================================================ -->
        <template v-if="sectionVisibility.translation">
            <span class="text-weight-medium text-center flex q-my-md asmr-settings-header" id="asmr-translation-settings-section-header">{{ t('translationSettings') }}</span>
            <div id="asmr-translation-settings-section" class="asmr-settings-section rounded-borders q-list q-list--bordered q-list--dark bg-black" role="group" aria-labelledby="asmr-translation-settings-section-header">
                <SettingsToggle config-key="preferLocalTranslation" :label="t('preferLocalTranslation')" :sublabel="t('preferLocalTranslationSub')" icon="offline_bolt" @change="onToggleChange" />
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsToggle config-key="translateCnToJp" :label="t('translateCnToJp')" :sublabel="t('translateCnToJpSub')" icon="swap_horiz" />
                <hr class="q-separator q-separator--horizontal q-separator--dark">

                <!-- Download Translation Model -->
                <div role="listitem" class="q-py-sm q-item q-item-type row no-wrap q-item--dark">
                    <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
                        <i class="q-icon notranslate material-icons asmr-settings-icon" aria-hidden="true" role="presentation">cloud_download</i>
                    </div>
                    <div class="q-item__section column q-item__section--main justify-center">
                        <div class="q-item__label"><span class="text-weight-medium">{{ t('downloadModel') }}</span></div>
                        <div class="q-item__label q-item__label--caption text-caption">
                            <span class="text-weight-medium">{{ translationDownloadLabel }}</span>
                        </div>
                    </div>
                    <div class="q-item__section column q-item__section--side justify-center">
                        <button
                            tabindex="0"
                            type="button"
                            class="q-btn q-btn-item non-selectable no-outline q-btn--standard q-btn--rectangle q-btn--actionable q-focusable q-hoverable"
                            :class="{ disabled: translationDownloadDisabled }"
                            :disabled="translationDownloadDisabled"
                            :aria-label="t('downloadModel') || 'Download translation model'"
                            :title="t('downloadModel') || 'Download translation model'"
                            @click="downloadTranslationModel"
                        >
                            <span class="q-focus-helper"></span>
                            <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                                <i class="q-icon notranslate material-icons" aria-hidden="true" role="presentation">{{ translationDownloadIcon }}</i>
                            </span>
                        </button>
                    </div>
                </div>
                <hr class="q-separator q-separator--horizontal q-separator--dark">

                <!-- Clear Translation Cache -->
                <div role="listitem" class="q-py-sm q-item q-item-type row no-wrap q-item--dark">
                    <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
                        <i class="q-icon notranslate material-icons asmr-settings-icon" aria-hidden="true" role="presentation">delete_sweep</i>
                    </div>
                    <div class="q-item__section column q-item__section--main justify-center">
                        <div class="q-item__label"><span class="text-weight-medium">{{ t('clearTranslationCache') }}</span></div>
                        <div class="q-item__label q-item__label--caption text-caption">{{ t('clearTranslationCacheSub') }}</div>
                    </div>
                    <div class="q-item__section column q-item__section--side justify-center">
                        <button
                            tabindex="0"
                            type="button"
                            class="q-btn q-btn-item non-selectable no-outline q-btn--standard q-btn--rectangle q-btn--actionable q-focusable q-hoverable"
                            :aria-label="t('clearTranslationCache') || 'Clear translation cache'"
                            :title="t('clearTranslationCache') || 'Clear translation cache'"
                            @click="clearTranslationCache"
                        >
                            <span class="q-focus-helper"></span>
                            <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                                <i class="q-icon notranslate material-icons" aria-hidden="true" role="presentation">delete_sweep</i>
                            </span>
                        </button>
                    </div>
                </div>
            </div>
        </template>

        <!-- ============================================================ -->
        <!-- JPDB Integration Settings                                    -->
        <!-- ============================================================ -->
        <template v-if="sectionVisibility.jpdb">
            <span class="text-weight-medium text-center flex q-my-md asmr-settings-header" id="asmr-jpdb-settings-section-header">{{ t('jpdbSection') }}</span>
            <div id="asmr-jpdb-settings-section" class="asmr-settings-section rounded-borders q-list q-list--bordered q-list--dark bg-black" role="group" aria-labelledby="asmr-jpdb-settings-section-header">
                <SettingsInput config-key="jpdbApiToken" :label="t('jpdbApiToken')" :sublabel="t('jpdbApiTokenSub')" :placeholder="t('jpdbApiTokenPlaceholder')" icon="key" input-type="password" />
                <div class="q-item q-item--dark" style="min-height: 36px; padding: 4px 16px;">
                    <a href="https://jpdb.io/settings#:~:text=in%20the%20future.-,Account%20information,-Username" target="_blank" rel="noopener noreferrer" class="q-btn q-btn-item non-selectable no-outline q-btn--standard q-btn--rectangle q-btn--actionable q-focusable q-hoverable" style="text-decoration: none; font-size: 0.85em;">
                        <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                            <i class="q-icon notranslate material-icons" aria-hidden="true" role="presentation" style="font-size: 18px;">open_in_new</i>
                            <span class="q-ml-xs">{{ t('jpdbGetApiKey') }}</span>
                        </span>
                    </a>
                </div>
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsToggle config-key="jpdbShowFurigana" :label="t('jpdbShowFurigana')" :sublabel="t('jpdbShowFuriganaSub')" icon="translate" />
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsToggle config-key="jpdbSiteFurigana" :label="t('jpdbSiteFurigana')" :sublabel="t('jpdbSiteFuriganaSub')" icon="language" />
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsToggle config-key="jpdbSubtitleFurigana" :label="t('jpdbSubtitleFurigana')" :sublabel="t('jpdbSubtitleFuriganaSub')" icon="subtitles" />
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsToggle config-key="jpdbShowPitchAccent" :label="t('jpdbShowPitchAccent')" :sublabel="t('jpdbShowPitchAccentSub')" icon="graphic_eq" />
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsInput config-key="jpdbMiningDeck" :label="t('jpdbMiningDeck')" :sublabel="t('jpdbMiningDeckSub')" placeholder="Mining" icon="style" />
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsToggle config-key="jpdbAddToForq" :label="t('jpdbAddToForq')" :sublabel="t('jpdbAddToForqSub')" icon="priority_high" />
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsToggle config-key="jpdbDisableReviews" :label="t('jpdbDisableReviews')" :sublabel="t('jpdbDisableReviewsSub')" icon="grading" />
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsToggle config-key="jpdbUseTwoGrades" :label="t('jpdbUseTwoGrades')" :sublabel="t('jpdbUseTwoGradesSub')" icon="thumbs_up_down" />
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsInput config-key="jpdbNeverForgetDeck" :label="t('jpdbNeverForgetDeck')" :sublabel="t('jpdbNeverForgetDeckSub')" placeholder="never-forget" icon="favorite" />
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsInput config-key="jpdbBlacklistDeck" :label="t('jpdbBlacklistDeck')" :sublabel="t('jpdbBlacklistDeckSub')" placeholder="blacklist" icon="block" />
            </div>
        </template>

        <!-- ============================================================ -->
        <!-- Auto Progress Settings                                       -->
        <!-- ============================================================ -->
        <template v-if="sectionVisibility.autoprogress">
            <span class="text-weight-medium text-center flex q-my-md asmr-settings-header" id="asmr-autoprogress-settings-section-header">{{ t('autoProgressSection') }}</span>
            <div id="asmr-autoprogress-settings-section" class="asmr-settings-section rounded-borders q-list q-list--bordered q-list--dark bg-black" role="group" aria-labelledby="asmr-autoprogress-settings-section-header">
                <SettingsToggle config-key="autoProgressMarked" :label="t('autoProgressMarked')" :sublabel="t('autoProgressMarkedDesc')" icon="bookmark" />
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsToggle config-key="autoProgressListening" :label="t('autoProgressListening')" :sublabel="t('autoProgressListeningDesc')" icon="headset" />
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsToggle config-key="autoProgressListened" :label="t('autoProgressListened')" :sublabel="t('autoProgressListenedDesc')" icon="check" />
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsToggle config-key="autoProgressReplay" :label="t('autoProgressReplay')" :sublabel="t('autoProgressReplayDesc')" icon="replay" />
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsToggle config-key="autoProgressPostponed" :label="t('autoProgressPostponed')" :sublabel="t('autoProgressPostponedDesc')" icon="schedule" />
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsInput config-key="autoProgressReplayThreshold" :label="t('autoProgressReplayThreshold')" :sublabel="t('autoProgressReplayThresholdDesc')" placeholder="2" icon="repeat_one" />
                <hr class="q-separator q-separator--horizontal q-separator--dark">
                <SettingsInput config-key="autoProgressRadioSkipThreshold" :label="t('autoProgressRadioSkipThreshold')" :sublabel="t('autoProgressRadioSkipThresholdDesc')" placeholder="3" icon="visibility_off" />
            </div>
        </template>

        <!-- ============================================================ -->
        <!-- Storage & Data                                               -->
        <!-- ============================================================ -->
        <template v-if="sectionVisibility.storage">
            <span class="text-weight-medium text-center flex q-my-md asmr-settings-header" id="asmr-storage-settings-section-header">{{ t('storageData') }}</span>
            <div id="asmr-storage-settings-section" class="asmr-settings-section rounded-borders q-list q-list--bordered q-list--dark bg-black" role="group" aria-labelledby="asmr-storage-settings-section-header">
                <!-- Backup -->
                <div role="listitem" class="q-py-sm q-item q-item-type row no-wrap q-item--dark">
                    <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
                        <i class="q-icon notranslate material-icons asmr-settings-icon" aria-hidden="true">save_alt</i>
                    </div>
                    <div class="q-item__section column q-item__section--main justify-center">
                        <div class="q-item__label"><span class="text-weight-medium">{{ t('backupSettings') }}</span></div>
                        <div class="q-item__label q-item__label--caption text-caption">{{ t('backupSettingsSub') }}</div>
                    </div>
                    <div class="q-item__section column q-item__section--side justify-center">
                        <button type="button" class="q-btn q-btn-item non-selectable no-outline q-btn--standard q-btn--rectangle q-btn--actionable q-focusable q-hoverable" :aria-label="t('backupSettings') || 'Backup settings'" :title="t('backupSettings') || 'Backup settings'" @click="backupSettings">
                            <span class="q-btn__content text-center col items-center row"><i class="q-icon notranslate material-icons" aria-hidden="true" role="presentation">download</i></span>
                        </button>
                    </div>
                </div>
                <hr class="q-separator q-separator--horizontal q-separator--dark">

                <!-- Restore -->
                <div role="listitem" class="q-py-sm q-item q-item-type row no-wrap q-item--dark">
                    <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
                        <i class="q-icon notranslate material-icons asmr-settings-icon" aria-hidden="true">upload</i>
                    </div>
                    <div class="q-item__section column q-item__section--main justify-center">
                        <div class="q-item__label"><span class="text-weight-medium">{{ t('restoreSettings') }}</span></div>
                        <div class="q-item__label q-item__label--caption text-caption">{{ t('restoreSettingsSub') }}</div>
                    </div>
                    <div class="q-item__section column q-item__section--side justify-center">
                        <button type="button" class="q-btn q-btn-item non-selectable no-outline q-btn--standard q-btn--rectangle q-btn--actionable q-focusable q-hoverable" :aria-label="t('restoreSettings') || 'Restore settings'" :title="t('restoreSettings') || 'Restore settings'" @click="restoreSettings">
                            <span class="q-btn__content text-center col items-center row"><i class="q-icon notranslate material-icons" aria-hidden="true" role="presentation">upload</i></span>
                        </button>
                    </div>
                </div>
                <hr class="q-separator q-separator--horizontal q-separator--dark">

                <!-- Factory Reset -->
                <div role="listitem" class="q-py-sm q-item q-item-type row no-wrap q-item--dark">
                    <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
                        <i class="q-icon notranslate material-icons asmr-settings-icon" aria-hidden="true">delete_forever</i>
                    </div>
                    <div class="q-item__section column q-item__section--main justify-center">
                        <div class="q-item__label"><span class="text-weight-medium">{{ t('factoryReset') }}</span></div>
                        <div class="q-item__label q-item__label--caption text-caption">{{ t('factoryResetSub') }}</div>
                    </div>
                    <div class="q-item__section column q-item__section--side justify-center">
                        <button type="button" class="q-btn q-btn-item non-selectable no-outline q-btn--standard q-btn--rectangle q-btn--actionable q-focusable q-hoverable asmr-nuke-btn" :aria-label="t('factoryReset') || 'Factory reset'" :title="t('factoryReset') || 'Factory reset'" @click="factoryReset">
                            <span class="q-btn__content text-center col items-center row"><i class="q-icon notranslate material-icons" aria-hidden="true" role="presentation">warning</i></span>
                        </button>
                    </div>
                </div>
            </div>
        </template>

        <!-- ============================================================ -->
        <!-- Proxy Settings                                               -->
        <!-- ============================================================ -->
        <span class="text-weight-medium text-center flex q-my-md asmr-settings-header" id="asmr-proxy-settings-section-header">{{ t('dlsiteProxy') }}</span>
        <div id="asmr-proxy-settings-section" class="asmr-settings-section rounded-borders q-list q-list--bordered q-list--dark bg-black" role="group" aria-labelledby="asmr-proxy-settings-section-header">
            <SettingsInput config-key="dlsiteProxyUrl" :label="t('dlsiteProxyUrl')" :sublabel="t('dlsiteProxyUrlSub')" placeholder="https://your-worker.workers.dev" icon="vpn_lock" />
            <div class="q-px-md q-pb-md">
                <details class="asmr-setup-guide">
                    <summary class="text-primary text-weight-medium">{{ t('dlsiteProxyUrlSetup') }}</summary>
                    <div class="asmr-guide-content">
                        <!-- eslint-disable-next-line vue/no-v-html -->
                        <div v-html="t('dlsiteProxyFullGuide')"></div>
                        <div class="text-weight-medium q-mt-md q-mb-sm">{{ t('dlsiteProxyWorkerCode') }}</div>
                        <pre class="asmr-code-block">{{ proxyWorkerCode }}</pre>
                        <div class="row justify-end q-mt-sm">
                            <button type="button" class="q-btn q-btn-item non-selectable no-outline q-btn--standard q-btn--rectangle q-btn--actionable q-focusable q-hoverable q-btn--dense asmr-copy-code-btn" @click="copyProxyCode">
                                <span class="q-focus-helper"></span>
                                <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                                    <i class="q-icon notranslate material-icons q-mr-xs" aria-hidden="true" role="presentation" style="font-size: 16px">{{ proxyCopied ? 'check' : 'content_copy' }}</i>
                                    {{ proxyCopied ? t('copied') : t('copyCode') }}
                                </span>
                            </button>
                        </div>
                    </div>
                </details>
            </div>
        </div>

        <!-- ============================================================ -->
        <!-- About & Links                                                -->
        <!-- ============================================================ -->
        <span class="text-weight-medium text-center flex q-my-md asmr-settings-header" id="asmr-about-section-header">{{ t('aboutHeader') }}</span>
        <div id="asmr-about-section" class="asmr-settings-section rounded-borders q-list q-list--bordered q-list--dark bg-black" role="group" aria-labelledby="asmr-about-section-header">
            <div role="listitem" class="q-py-sm q-item q-item-type row no-wrap q-item--dark">
                <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
                    <i class="q-icon notranslate material-icons asmr-settings-icon" aria-hidden="true" role="presentation">menu_book</i>
                </div>
                <div class="q-item__section column q-item__section--main justify-center">
                    <div class="q-item__label"><span class="text-weight-medium">{{ t('readmeDocs') }}</span></div>
                    <div class="q-item__label q-item__label--caption text-caption">{{ t('readmeDocsSub') }}</div>
                </div>
                <div class="q-item__section column q-item__section--side justify-center">
                    <a :href="GITHUB_URL" target="_blank" rel="noopener noreferrer" class="q-btn q-btn-item non-selectable no-outline q-btn--standard q-btn--rectangle q-btn--actionable q-focusable q-hoverable" style="text-decoration: none" :aria-label="t('readmeDocs') || 'Documentation & Source'" :title="t('readmeDocs') || 'Documentation & Source'">
                        <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                            <i class="q-icon notranslate material-icons" aria-hidden="true" role="presentation">open_in_new</i>
                        </span>
                    </a>
                </div>
            </div>
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <div role="listitem" class="q-py-sm q-item q-item-type row no-wrap q-item--dark">
                <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
                    <i class="q-icon notranslate material-icons asmr-settings-icon" aria-hidden="true" role="presentation">bug_report</i>
                </div>
                <div class="q-item__section column q-item__section--main justify-center">
                    <div class="q-item__label"><span class="text-weight-medium">{{ t('reportIssue') }}</span></div>
                    <div class="q-item__label q-item__label--caption text-caption">{{ t('reportIssueSub') }}</div>
                </div>
                <div class="q-item__section column q-item__section--side justify-center">
                    <a :href="GITHUB_URL + '/issues'" target="_blank" rel="noopener noreferrer" class="q-btn q-btn-item non-selectable no-outline q-btn--standard q-btn--rectangle q-btn--actionable q-focusable q-hoverable" style="text-decoration: none" :aria-label="t('reportIssue') || 'Report an issue'" :title="t('reportIssue') || 'Report an issue'">
                        <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                            <i class="q-icon notranslate material-icons" aria-hidden="true" role="presentation">open_in_new</i>
                        </span>
                    </a>
                </div>
            </div>
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <div role="listitem" class="q-py-sm q-item q-item-type row no-wrap q-item--dark">
                <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
                    <i class="q-icon notranslate material-icons asmr-settings-icon" aria-hidden="true" role="presentation" style="color: #7289da">forum</i>
                </div>
                <div class="q-item__section column q-item__section--main justify-center">
                    <div class="q-item__label"><span class="text-weight-medium">{{ t('discordLabel') }}</span></div>
                    <div class="q-item__label q-item__label--caption text-caption">{{ t('discordSub') }}</div>
                </div>
                <div class="q-item__section column q-item__section--side justify-center">
                    <button class="q-btn q-btn-item non-selectable no-outline q-btn--standard q-btn--rectangle q-btn--actionable q-focusable q-hoverable" @click="copyDiscord" :aria-label="t('discordCopy') || 'Copy username'" :title="t('discordCopy') || 'Copy username'">
                        <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                            <i class="q-icon notranslate material-icons" aria-hidden="true" role="presentation">content_copy</i>
                        </span>
                    </button>
                </div>
            </div>
            <hr class="q-separator q-separator--horizontal q-separator--dark">
            <div role="listitem" class="q-py-sm q-item q-item-type row no-wrap asmr-donate-item">
                <div class="q-item__section column q-item__section--avatar q-item__section--side justify-center">
                    <i class="q-icon notranslate material-icons asmr-settings-icon" aria-hidden="true" role="presentation" style="color: #e57373">volunteer_activism</i>
                </div>
                <div class="q-item__section column q-item__section--main justify-center">
                    <div class="q-item__label"><span class="text-weight-medium">{{ t('donateLabel') }}</span></div>
                    <div class="q-item__label q-item__label--caption text-caption" style="line-height: 1.4">{{ t('donateSub') }}</div>
                </div>
                <div class="q-item__section column q-item__section--side justify-center">
                    <a href="https://paypal.me/HenryRussell163" target="_blank" rel="noopener noreferrer" class="q-btn q-btn-item non-selectable no-outline q-btn--standard q-btn--rectangle q-btn--actionable q-focusable q-hoverable asmr-donate-btn" style="text-decoration: none" :aria-label="t('donateLabel') || 'Support Development'" :title="t('donateLabel') || 'Support Development'">
                        <span class="q-btn__content text-center col items-center q-anchor--skip justify-center row">
                            <i class="q-icon notranslate material-icons" aria-hidden="true" role="presentation">favorite</i>
                        </span>
                    </a>
                </div>
            </div>
        </div>

        <!-- ============================================================ -->
        <!-- Credits                                                      -->
        <!-- ============================================================ -->
        <span class="text-weight-medium text-center flex q-my-md asmr-settings-header" id="asmr-credits-section-header">{{ t('creditsHeader') }}</span>
        <div id="asmr-credits-section" class="asmr-settings-section rounded-borders q-list q-list--bordered q-list--dark bg-black" role="group" aria-labelledby="asmr-credits-section-header">
            <div class="q-pa-md text-caption text-grey-7">
                <div class="q-mb-sm">{{ t('creditsSub') }}</div>
                <ul class="asmr-credits-list q-pl-md q-my-sm" style="list-style: disc; margin: 0;">
                    <li v-for="credit in credits" :key="credit.name">
                        <a :href="credit.url" target="_blank" rel="noopener" class="text-primary">{{ credit.name }}</a> - {{ t(credit.descKey) }}
                    </li>
                </ul>
            </div>
        </div>

    </div>
</template>

<style scoped>
/* Settings Panel Components
   Theme-reactive styling using CSS variables
   Matches kikoeru-quasar Quasar styling patterns */

/* Settings Section Containers */
.asmr-settings-section {
    border-radius: 4px;
    overflow: visible !important;
    background: var(--asmr-bg-secondary) !important;
    color: var(--asmr-text-primary) !important;
}

/* Settings headers */
.asmr-settings-header {
    color: var(--asmr-text-primary) !important;
}

/* Settings Items (q-item style) */
.asmr-settings-section :deep(.q-item) {
    background: transparent;
    color: var(--asmr-text-primary);
}

.asmr-settings-section :deep(.q-item__label) {
    color: var(--asmr-text-primary);
}

.asmr-settings-section :deep(.q-item__label--caption),
.asmr-settings-section :deep(.text-caption) {
    color: var(--asmr-text-secondary) !important;
}

.asmr-settings-section :deep(.q-icon) {
    color: var(--asmr-text-primary);
}

/* Toggle Switch */
.asmr-settings-section :deep(.q-toggle__inner--truthy) {
    color: var(--asmr-accent);
}

.asmr-settings-section :deep(.q-toggle__inner--truthy .q-toggle__track) {
    opacity: 0.5;
}

.asmr-settings-section :deep(.q-toggle__inner--truthy .q-toggle__thumb:after) {
    background-color: currentColor;
}

.asmr-settings-section :deep(.q-field) {
    background: transparent;
}

.asmr-settings-section :deep(.q-field__control) {
    background: var(--asmr-input-bg, rgba(255, 255, 255, 0.07));
    border-radius: 4px;
    min-height: 40px;
}

.asmr-settings-section :deep(.q-field__native) {
    color: inherit;
    padding: 8px 12px;
}

/* Focus state */
.asmr-settings-section :deep(.q-field--focused .q-field__control) {
    border: 1px solid var(--q-primary, var(--asmr-accent));
}

/* Icons */
.asmr-settings-section :deep(.asmr-settings-icon) {
    font-size: 28px;
}

/* Hint Text */
.asmr-settings-hint {
    margin-top: -8px;
}

.asmr-settings-hint-text {
    font-size: 0.85em;
}

.asmr-settings-link {
    text-decoration: underline;
}

/* Danger / Factory Reset */
.asmr-nuke-btn {
    background: var(--q-negative, #c62828);
    color: white;
}

.asmr-nuke-btn:hover:not(.disabled) {
    filter: brightness(1.15);
}

/* Donate button */
.asmr-donate-btn {
    background: linear-gradient(135deg, #e57373, #ef5350);
    color: white;
    transition: filter 0.2s, transform 0.2s;
}

.asmr-donate-btn:hover {
    filter: brightness(1.15);
    transform: scale(1.05);
}
</style>
