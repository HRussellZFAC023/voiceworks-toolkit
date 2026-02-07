import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthApi } from '../../src/api/Auth';

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('../../src/api/Client', () => ({
    getAxios: () => ({
        get: mockGet,
        post: mockPost,
    }),
}));

describe('AuthApi', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('login', () => {
        it('should POST to /api/auth/me with credentials', async () => {
            const tokenResponse = { token: 'jwt-token-123' };
            mockPost.mockResolvedValue({ data: tokenResponse });
            const result = await AuthApi.login({ name: 'admin', password: 'pass123' });
            expect(mockPost).toHaveBeenCalledWith('/api/auth/me', {
                name: 'admin',
                password: 'pass123',
            });
            expect(result).toEqual(tokenResponse);
        });
    });

    describe('getCurrentUser', () => {
        it('should GET /api/auth/me', async () => {
            const userResponse = {
                user: { name: 'admin', group: 'administrator' },
                auth: true,
            };
            mockGet.mockResolvedValue({ data: userResponse });
            const result = await AuthApi.getCurrentUser();
            expect(mockGet).toHaveBeenCalledWith('/api/auth/me');
            expect(result).toEqual(userResponse);
        });
    });
});
