import { getAxios } from './Client';
import type { AuthLoginParams, AuthLoginResponse, AuthUserResponse } from '../types/api';

export const AuthApi = {
    /**
     * Login with username and password.
     * Returns a JWT token on success.
     */
    async login(params: AuthLoginParams): Promise<AuthLoginResponse> {
        const res = await getAxios().post<AuthLoginResponse>('/api/auth/me', params);
        return res.data;
    },

    /**
     * Get current authenticated user info.
     * Returns user name, group, and whether auth is enabled.
     */
    async getCurrentUser(): Promise<AuthUserResponse> {
        const res = await getAxios().get<AuthUserResponse>('/api/auth/me');
        return res.data;
    },
};
