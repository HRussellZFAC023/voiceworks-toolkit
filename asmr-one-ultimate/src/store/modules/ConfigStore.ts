import { GM_getValue, GM_setValue } from '$';
import type { ConfigKey, PluginConfig } from '../../types';

/**
 * @deprecated Use AppStore.getConfig / AppStore.setConfig directly.
 */
export class ConfigStore {
    private static instance: ConfigStore;

    public readonly defaults: Partial<PluginConfig> = {
        playAllInFolder: false,
        shuffle: false,
        autoFilterFolders: true,
        preferredFormat: 'wav > mp3 > flac > opus > m4a > aac',
        sePreference: true,
        showJP: true,
        subtitleLang: 'en',
        primarySubtitleLang: 'ja',
        cacheLimitGB: 5,
        transcriptSyncEnabled: false,
        transcriptSyncProjectId: '',
        transcriptSyncApiKey: '',
        transcriptSyncCollection: 'transcripts',
        vectorSearchApiKey: '',
        vectorSearchApiKeyHash: '',
        vectorSearchModel: 'jina-embeddings-v3',
        vectorIndexVersion: 2,
        vectorIndexCursor: 1,
        vectorIndexLatestWorkId: '',
        autoProgress: false,
        alwaysTranscribe: false,
        preferLocalTranslation: true,
        distributedTranslation: true,
        flatView: false,
        playbackRate: 1.0,
        dlsiteProxyUrl: '',
        debug: false,
    } as Partial<PluginConfig>;

    private constructor() { }

    public static getInstance(): ConfigStore {
        if (!ConfigStore.instance) {
            ConfigStore.instance = new ConfigStore();
        }
        return ConfigStore.instance;
    }

    public get<K extends ConfigKey>(key: K): PluginConfig[K] {
        return GM_getValue(key, (this.defaults as Record<string, unknown>)[key]) as PluginConfig[K];
    }

    public set<K extends ConfigKey>(key: K, val: PluginConfig[K]): void {
        GM_setValue(key, val);
    }

    public getAll(): Partial<PluginConfig> {
        const res: Partial<PluginConfig> = {};
        for (const key of Object.keys(this.defaults) as ConfigKey[]) {
            (res as Record<string, unknown>)[key] = this.get(key);
        }
        return res;
    }
}
