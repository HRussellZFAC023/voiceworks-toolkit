import { describe, expect, it } from 'vitest';
import { omitSensitiveConfig, redactSensitiveConfig } from '../../src/core/configSecrets';

describe('config secret handling', () => {
    const config = {
        debug: true,
        translationApiKey: 'translation-secret',
        jpdbApiToken: 'jpdb-secret',
        vectorSearchApiKey: 'vector-secret',
        transcriptSyncApiKey: 'sync-secret',
    };

    it('redacts credentials before diagnostic logging', () => {
        const redacted = redactSensitiveConfig(config);
        expect(redacted.debug).toBe(true);
        expect(Object.values(redacted)).not.toContain('translation-secret');
        expect(redacted.translationApiKey).toBe('[REDACTED]');
    });

    it('omits credentials from downloadable backups', () => {
        expect(omitSensitiveConfig(config)).toEqual({ debug: true });
    });
});
