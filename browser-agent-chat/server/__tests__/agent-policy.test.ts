import { describe, expect, it, vi } from 'vitest';
import { authorizeBrowserAction, isAllowedOrigin } from '../src/agent.js';

function mockPage(
  url = 'https://app.example.com/dashboard',
  target = {
    summary: 'BUTTON Delete project',
    isSubmit: false,
    isCredential: false,
    isUnknown: false,
    requiresConfirmation: true,
    href: '',
    opensNewContext: false,
  },
) {
  const page: any = {
    url: () => url,
    evaluate: vi.fn(async (fn: Function) => fn.length === 0 ? url : target),
    context: () => ({ pages: () => [page] }),
  };
  return page;
}

describe('browser action policy', () => {
  it('allows only an exact HTTP(S) origin match', () => {
    expect(isAllowedOrigin('https://app.example.com/path', 'https://app.example.com')).toBe(true);
    expect(isAllowedOrigin('https://evil.example/path', 'https://app.example.com')).toBe(false);
    expect(isAllowedOrigin('javascript:alert(1)', 'https://app.example.com')).toBe(false);
  });

  it('blocks cross-origin navigation before requesting confirmation', async () => {
    const confirm = vi.fn();
    await expect(authorizeBrowserAction(
      mockPage(),
      { variant: 'browser:nav', url: 'https://evil.example/collect' },
      'https://app.example.com',
      confirm,
    )).rejects.toThrow('cross-origin navigation');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('requires one-time confirmation for consequential clicks', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    await authorizeBrowserAction(
      mockPage(),
      { variant: 'mouse:click', x: 10, y: 20 },
      'https://app.example.com',
      confirm,
    );
    expect(confirm).toHaveBeenCalledWith(
      'mouse:click',
      expect.stringContaining('Delete project'),
      expect.stringContaining('consequential'),
    );
  });

  it('blocks cross-origin links before clicking', async () => {
    const confirm = vi.fn();
    const page = mockPage('https://app.example.com/dashboard', {
      summary: 'A external instructions https://evil.example/collect',
      isSubmit: false,
      isCredential: false,
      isUnknown: false,
      requiresConfirmation: false,
      href: 'https://evil.example/collect',
      opensNewContext: false,
    });
    await expect(authorizeBrowserAction(
      page,
      { variant: 'mouse:click', x: 10, y: 20 },
      'https://app.example.com',
      confirm,
    )).rejects.toThrow('cross-origin navigation');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('blocks typing when confirmation is denied', async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    await expect(authorizeBrowserAction(
      mockPage(),
      { variant: 'keyboard:type', content: 'untrusted data' },
      'https://app.example.com',
      confirm,
    )).rejects.toThrow('confirmation was denied');
  });

  it('allows passive actions without confirmation', async () => {
    const confirm = vi.fn();
    await authorizeBrowserAction(
      mockPage(),
      { variant: 'mouse:scroll', x: 10, y: 20 },
      'https://app.example.com',
      confirm,
    );
    expect(confirm).not.toHaveBeenCalled();
  });
});
