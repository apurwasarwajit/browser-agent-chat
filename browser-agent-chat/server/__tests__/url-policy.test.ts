import { describe, expect, it, vi } from 'vitest';
import { assertPublicUrl, installBrowserUrlPolicy } from '../src/url-policy.js';

const resolvesTo = (...addresses: string[]) => vi.fn(async () =>
  addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
);

describe('assertPublicUrl', () => {
  it('allows HTTP(S) destinations when every resolved address is public', async () => {
    const resolver = resolvesTo('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946');
    await expect(assertPublicUrl('https://example.com/path', resolver)).resolves.toBeInstanceOf(URL);
  });

  it.each([
    'file:///etc/passwd',
    'ftp://example.com/file',
    'https://user:password@example.com/',
    'https://example.com:8443/',
    'http://example.com:443/',
  ])('rejects disallowed protocols, credentials, and ports: %s', async (url) => {
    await expect(assertPublicUrl(url, resolvesTo('93.184.216.34'))).rejects.toThrow();
  });

  it.each([
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
  ])('rejects non-public IP literals: %s', async (url) => {
    await expect(assertPublicUrl(url)).rejects.toThrow('non-public address');
  });

  it.each([
    'http://localhost/',
    'http://app.localhost/',
    'http://printer.local/',
    'http://metadata.google.internal/',
    'http://router/',
  ])('rejects local hostnames before DNS resolution: %s', async (url) => {
    await expect(assertPublicUrl(url, resolvesTo('93.184.216.34'))).rejects.toThrow('local hostname');
  });

  it('rejects a hostname if any DNS answer is non-public', async () => {
    const resolver = resolvesTo('93.184.216.34', '10.0.0.1');
    await expect(assertPublicUrl('https://example.com', resolver)).rejects.toThrow('non-public address');
  });

  it('rejects hostnames with no DNS answers', async () => {
    await expect(assertPublicUrl('https://example.com', resolvesTo())).rejects.toThrow('non-public address');
  });

  it('aborts a private request intercepted by the browser context', async () => {
    let requestHandler: ((route: any) => Promise<void>) | undefined;
    const context = {
      addInitScript: vi.fn(),
      route: vi.fn(async (_pattern, handler) => { requestHandler = handler; }),
      routeWebSocket: vi.fn(),
    };
    await installBrowserUrlPolicy(context as any);

    const route = {
      request: () => ({ url: () => 'http://169.254.169.254/latest/meta-data/' }),
      continue: vi.fn(),
      abort: vi.fn(),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await requestHandler!(route);

    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(route.continue).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
