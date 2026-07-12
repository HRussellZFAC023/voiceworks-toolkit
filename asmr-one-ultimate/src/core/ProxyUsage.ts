/**
 * Shared process-local signal for features that route traffic through the
 * maintained region-bypass proxy. Late subscribers are notified immediately
 * so startup ordering cannot hide the funding notice.
 */

type ProxyUseListener = () => void;

const listeners = new Set<ProxyUseListener>();
let proxyWasUsed = false;

export function onProxyUse(listener: ProxyUseListener): () => void {
    listeners.add(listener);
    if (proxyWasUsed) listener();
    return () => listeners.delete(listener);
}

export function hasUsedProxy(): boolean {
    return proxyWasUsed;
}

export function recordProxyUse(): void {
    proxyWasUsed = true;
    for (const listener of listeners) {
        try { listener(); } catch { /* observers must not break the request path */ }
    }
}
