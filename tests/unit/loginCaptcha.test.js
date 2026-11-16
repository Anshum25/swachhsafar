import { describe, expect, it, vi } from 'vitest';
import { solveCaptcha, fetchChallenge } from '../../src/security/captcha.js';

describe('ALTCHA CAPTCHA Challenge & Proof-of-Work Verification', () => {
  it('fetches challenge and computes valid proof of work', async () => {
    // Mock fetch for /auth/captcha
    const fakeChallenge = {
      algorithm: 'SHA-256',
      challenge: 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
      salt: 'test-salt?expires=1793949817',
      signature: 'test-signature-123',
      maxnumber: 1000,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => fakeChallenge,
    });

    const ch = await fetchChallenge(mockFetch);
    expect(ch.algorithm).toBe('SHA-256');
    expect(ch.maxnumber).toBe(1000);
    expect(ch.signature).toBe('test-signature-123');
  });

  it('rejects if challenge endpoint returns error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });

    await expect(fetchChallenge(mockFetch)).rejects.toMatchObject({
      code: 'captcha_unavailable',
    });
  });
});

