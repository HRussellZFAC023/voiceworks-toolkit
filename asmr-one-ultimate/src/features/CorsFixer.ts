import { KikoeruBridge } from '../infrastructure/KikoeruBridge';
import { gmRequest } from '../infrastructure/HttpClient';
import { Logger } from '../core/Utils';

export class CorsFixer {
    static enable(): void {
        const bridge = KikoeruBridge.getInstance();
        // Wait for bridge to be ready if called too early, though main.ts usually waits
        if (!bridge.axios) {
            Logger.warn('[CorsFixer] Axios not available yet');
            return;
        }

        const axios = bridge.axios;

        // Check if already installed to avoid duplicates
        if ((axios as any).__asmr_cors_fixed) return;
        (axios as any).__asmr_cors_fixed = true;

        (axios as unknown as { interceptors: { response: { use: (onFulfilled: (response: unknown) => unknown, onRejected: (error: any) => unknown) => void } } }).interceptors.response.use(
            (response) => response,
            async (error) => {
                const config = error.config;
                
                // Only retry if:
                // 1. It's a Network Error (CORS failures often appear as this in Axios)
                // 2. We haven't already retried this request (custom flag)
                // 3. The URL matches the known problematic domain
                if (error.message === 'Network Error' && 
                    config && 
                    !config.__isRetry && 
                    (config.url?.includes('api.asmr-200.com') || config.url?.includes('google-analytics.com'))) {
                    
                    Logger.debug('[CorsFixer] Intercepted CORS failure, retrying via GM_xmlhttpRequest:', config.url);
                    
                    config.__isRetry = true;

                    try {
                        const res = await gmRequest({
                            method: config.method?.toUpperCase() || 'GET',
                            url: config.url,
                            headers: {
                                ...config.headers,
                                // Remove dangerous headers that might trigger CORS preflight failure if browser adds them but server rejects
                                // GM_xmlhttpRequest handles User-Agent/Origin differently/safely
                            },
                            data: config.data,
                            // Map axios responseType to GM responseType
                            responseType: config.responseType === 'blob' ? 'blob' : 'json' 
                        });

                        // Return a fake Axios response object
                        return {
                            data: res.response,
                            status: res.status,
                            statusText: res.statusText,
                            headers: {}, // GM doesn't give easily parseable headers object here without parsing, usually fine to omit for API calls
                            config: config,
                            request: {} 
                        };
                    } catch (gmError) {
                        Logger.warn('[CorsFixer] GM retry failed:', gmError);
                        // If retry fails, propagate the ORIGINAL error to avoid confusing the app
                        return Promise.reject(error);
                    }
                }
                
                return Promise.reject(error);
            }
        );

        Logger.debug('[CorsFixer] Axios interceptor installed');
    }
}
