/** Config values that must stay in userscript storage and out of logs/backups. */
export const SENSITIVE_CONFIG_KEYS = [
    'translationApiKey',
    'jpdbApiToken',
    'vectorSearchApiKey',
    'transcriptSyncApiKey',
] as const;

const sensitiveConfigKeys = new Set<string>(SENSITIVE_CONFIG_KEYS);

export function redactSensitiveConfig(config: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(config).map(([key, value]) => [
        key,
        sensitiveConfigKeys.has(key) && value ? '[REDACTED]' : value,
    ]));
}

export function omitSensitiveConfig(config: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(config).filter(([key]) => !sensitiveConfigKeys.has(key)),
    );
}
