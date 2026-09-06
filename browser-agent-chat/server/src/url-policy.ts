import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { BrowserContext } from 'playwright';

type ResolvedAddress = { address: string; family: number };
type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const blockedIpv4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  blockedIpv4.addSubnet(address, prefix, 'ipv4');
}

const publicIpv6 = new BlockList();
publicIpv6.addSubnet('2000::', 3, 'ipv6');

const blockedIpv6 = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23],       // IETF protocol assignments, including Teredo/ORCHID
  ['2001:db8::', 32],  // documentation
  ['2002::', 16],      // 6to4 can encapsulate a private IPv4 destination
  ['3fff::', 20],      // documentation
] as const) {
  blockedIpv6.addSubnet(address, prefix, 'ipv6');
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIpv4.check(address, 'ipv4');
  if (family === 6) {
    return publicIpv6.check(address, 'ipv6') && !blockedIpv6.check(address, 'ipv6');
  }
  return false;
}

const resolveHostname: Resolver = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

/**
 * Enforce the browser's outbound target policy. Only standard-port HTTP(S) and
 * WebSocket destinations whose complete DNS result is publicly routable pass.
 */
export async function assertPublicUrl(
  rawUrl: string,
  resolver: Resolver = resolveHostname,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  const defaultPort = new Map([
    ['http:', '80'], ['https:', '443'], ['ws:', '80'], ['wss:', '443'],
  ]).get(url.protocol);
  if (!defaultPort || url.username || url.password || (url.port && url.port !== defaultPort)) {
    throw new Error('URL is outside the allowed target policy');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname) throw new Error('URL has no hostname');

  const literalFamily = isIP(hostname);
  if (!literalFamily && (
    !hostname.includes('.') ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  )) {
    throw new Error('URL uses a local hostname');
  }

  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await resolver(hostname);

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('URL resolves to a non-public address');
  }

  return url;
}

/** Install before the first navigation so initial requests, redirects, and subresources are checked. */
export async function installBrowserUrlPolicy(context: BrowserContext): Promise<void> {
  // Request routing cannot see traffic handled inside a service worker. New
  // documents therefore receive no service-worker API before any page script.
  await context.addInitScript(new Function(`
    const prototype = Object.getPrototypeOf(navigator);
    if ('serviceWorker' in prototype) {
      Object.defineProperty(prototype, 'serviceWorker', {
        value: undefined,
        configurable: false,
        writable: false,
      });
    }
  `) as () => void);

  await context.route('**/*', async (route) => {
    try {
      await assertPublicUrl(route.request().url());
      await route.continue();
    } catch (error) {
      console.warn(`[URL POLICY] Blocked request to ${route.request().url()}:`, error);
      await route.abort('blockedbyclient');
    }
  });

  await context.routeWebSocket('**/*', async (webSocket) => {
    try {
      await assertPublicUrl(webSocket.url());
      webSocket.connectToServer();
    } catch (error) {
      console.warn(`[URL POLICY] Blocked WebSocket to ${webSocket.url()}:`, error);
      await webSocket.close({ code: 1008, reason: 'Destination blocked' });
    }
  });
}
