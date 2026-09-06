import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock redisStore
vi.mock('../src/redisStore.js', () => ({
  getSession: vi.fn().mockResolvedValue(null),
  setSession: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  refreshTTL: vi.fn().mockResolvedValue(undefined),
  updateLastActivity: vi.fn().mockResolvedValue(undefined),
  freePort: vi.fn().mockResolvedValue(undefined),
  setScreenshot: vi.fn().mockResolvedValue(undefined),
  getScreenshot: vi.fn().mockResolvedValue(null),
  pushMessage: vi.fn().mockResolvedValue(undefined),
  getMessages: vi.fn().mockResolvedValue([]),
  listSessions: vi.fn().mockResolvedValue([]),
  getRedis: vi.fn().mockReturnValue({
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  }),
}));

// Mock browserManager
vi.mock('../src/browserManager.js', () => ({
  claimWarm: vi.fn().mockResolvedValue(null),
  launchBrowser: vi.fn().mockResolvedValue({ pid: 12345, port: 19300, cdpEndpoint: 'http://localhost:19300' }),
  killBrowser: vi.fn().mockResolvedValue(undefined),
  isAlive: vi.fn().mockResolvedValue(true),
}));

// Mock agent — factory must not reference top-level variables (hoisting rules)
vi.mock('../src/agent.js', () => ({
  createAgent: vi.fn().mockResolvedValue({
    agent: {},
    connector: {},
    sessionId: 'db-1',
    projectId: 'proj-1',
    memoryContext: 'test context',
    stepsHistory: [],
    loginDone: Promise.resolve(),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Mock db
vi.mock('../src/db.js', () => ({
  endSession: vi.fn().mockResolvedValue(undefined),
  getMessagesBySession: vi.fn().mockResolvedValue([]),
}));

import * as redisStore from '../src/redisStore.js';
import * as browserManager from '../src/browserManager.js';
import { createAgent } from '../src/agent.js';
import { WebSocket } from 'ws';
import {
  createSession,
  destroySession,
  getAgent,
  addClient,
  removeClient,
  makeBroadcast,
  recoverSession,
  recoverAllSessions,
  sendSnapshot,
  evictLRUSession,
  ensureCapacity,
  setBeforeEvictHook,
  callBeforeEvictHook,
  _resetLocalState,
} from '../src/sessionManager.js';

describe('sessionManager — create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('createSession claims warm browser first, falls back to launch', async () => {
    (browserManager.claimWarm as any).mockResolvedValueOnce(null);
    (browserManager.launchBrowser as any).mockResolvedValueOnce({
      pid: 12345, port: 19300, cdpEndpoint: 'http://localhost:19300',
    });

    await createSession('proj-1', 'https://example.com', 'db-1');

    expect(browserManager.claimWarm).toHaveBeenCalledWith('proj-1');
    expect(browserManager.launchBrowser).toHaveBeenCalledWith('proj-1');
    expect(createAgent).toHaveBeenCalledWith(
      expect.any(Function), 'http://localhost:19300', 'db-1', 'proj-1', 'https://example.com'
    );
    expect(redisStore.setSession).toHaveBeenCalledWith('proj-1', expect.objectContaining({
      dbSessionId: 'db-1',
      status: 'idle',
      cdpPort: 19300,
      browserPid: 12345,
    }));
  });

  it('createSession uses warm browser when available', async () => {
    (browserManager.claimWarm as any).mockResolvedValueOnce({
      pid: 99999, port: 19305, cdpEndpoint: 'http://localhost:19305',
    });

    await createSession('proj-1', 'https://example.com', 'db-1');

    expect(browserManager.launchBrowser).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledWith(
      expect.any(Function), 'http://localhost:19305', 'db-1', 'proj-1', 'https://example.com'
    );
  });

  it('createSession stores agent in local map', async () => {
    await createSession('proj-1', 'https://example.com', 'db-1');
    const agent = getAgent('proj-1');
    expect(agent).toBeDefined();
    expect(agent).toHaveProperty('memoryContext', 'test context');
    expect(agent).toHaveProperty('sessionId', 'db-1');
  });
});

describe('sessionManager — destroy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('destroySession kills browser, ends DB session, deletes Redis', async () => {
    // First create a session so there's an agent to clean up
    await createSession('proj-1', 'https://example.com', 'db-1');
    vi.clearAllMocks();
    (redisStore.getSession as any).mockResolvedValueOnce({
      dbSessionId: 'db-1',
      browserPid: 12345,
      cdpPort: 19300,
    });

    await destroySession('proj-1');

    expect(browserManager.killBrowser).toHaveBeenCalledWith(12345, 19300);
    expect(redisStore.deleteSession).toHaveBeenCalledWith('proj-1');
    expect(getAgent('proj-1')).toBeUndefined();
  });
});

describe('sessionManager — broadcast', () => {
  it('makeBroadcast writes screenshot to Redis', () => {
    const broadcast = makeBroadcast('proj-1');
    broadcast({ type: 'screenshot', data: 'base64img' });

    expect(redisStore.setScreenshot).toHaveBeenCalledWith('proj-1', 'base64img');
  });

  it('makeBroadcast writes nav URL to Redis', () => {
    const broadcast = makeBroadcast('proj-1');
    broadcast({ type: 'nav', url: 'https://test.com/page' });

    expect(redisStore.setSession).toHaveBeenCalledWith('proj-1', { currentUrl: 'https://test.com/page' });
  });

  it('makeBroadcast stores chat messages in Redis', () => {
    const broadcast = makeBroadcast('proj-1');
    broadcast({ type: 'thought', content: 'Analyzing the page...' });

    expect(redisStore.pushMessage).toHaveBeenCalledWith('proj-1', expect.objectContaining({
      type: 'agent',
      content: 'Analyzing the page...',
    }));
  });
});

const mockRedisSession = {
  dbSessionId: 'db-1',
  status: 'idle' as const,
  cdpPort: 19300,
  cdpEndpoint: 'http://localhost:19300',
  currentUrl: 'https://example.com/dashboard',
  memoryContext: '',
  browserPid: 12345,
  lastTask: '',
  createdAt: 1710000000000,
  lastActivityAt: 1710000000000,
  detachedAt: 0,
};

describe('sessionManager — recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recoverSession reconnects agent when browser is alive', async () => {
    const redis = redisStore.getRedis();
    (redis.set as any).mockResolvedValueOnce('OK'); // lock acquired
    (redisStore.getSession as any).mockResolvedValueOnce(mockRedisSession);
    (browserManager.isAlive as any).mockResolvedValueOnce(true);

    const result = await recoverSession('proj-1');

    expect(result).toBe(true);
    expect(createAgent).toHaveBeenCalledWith(
      expect.any(Function), 'http://localhost:19300', 'db-1', 'proj-1', 'https://example.com/dashboard'
    );
    expect(redisStore.setSession).toHaveBeenCalledWith('proj-1', { status: 'idle' });
    expect(redis.del).toHaveBeenCalledWith('session:lock:proj-1');
  });

  it('recoverSession marks crashed when browser is dead', async () => {
    const redis = redisStore.getRedis();
    (redis.set as any).mockResolvedValueOnce('OK');
    (redisStore.getSession as any).mockResolvedValueOnce(mockRedisSession);
    (browserManager.isAlive as any).mockResolvedValueOnce(false);

    const result = await recoverSession('proj-1');

    expect(result).toBe(false);
    expect(redisStore.setSession).toHaveBeenCalledWith('proj-1', { status: 'crashed' });
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('recoverSession skips when lock is held by another server', async () => {
    const redis = redisStore.getRedis();
    (redis.set as any).mockResolvedValueOnce(null); // lock NOT acquired

    const result = await recoverSession('proj-1');
    expect(result).toBe(false);
    expect(redisStore.getSession).not.toHaveBeenCalled();
  });

  it('recoverSession sets status to interrupted when previous status was working', async () => {
    const redis = redisStore.getRedis();
    (redis.set as any).mockResolvedValueOnce('OK');
    (redisStore.getSession as any).mockResolvedValueOnce({
      ...mockRedisSession,
      status: 'working',
      lastTask: 'Click the submit button',
    });
    (browserManager.isAlive as any).mockResolvedValueOnce(true);

    await recoverSession('proj-1');

    expect(redisStore.setSession).toHaveBeenCalledWith('proj-1', { status: 'interrupted' });
  });
});

describe('sessionManager — recoverAll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recoverAllSessions processes sessions in batches of 5', async () => {
    (redisStore.listSessions as any).mockResolvedValueOnce([
      'proj-1', 'proj-2', 'proj-3', 'proj-4', 'proj-5', 'proj-6',
    ]);

    const redis = redisStore.getRedis();
    (redis.set as any).mockResolvedValue('OK');
    (redisStore.getSession as any).mockResolvedValue(mockRedisSession);
    (browserManager.isAlive as any).mockResolvedValue(true);

    await recoverAllSessions();

    // All 6 sessions attempted
    expect(createAgent).toHaveBeenCalledTimes(6);
  });
});

describe('sessionManager — sendSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sendSnapshot sends status, nav, screenshot, and messages', async () => {
    (redisStore.getSession as any).mockResolvedValueOnce(mockRedisSession);
    (redisStore.getScreenshot as any).mockResolvedValueOnce('screenshot-data');
    (redisStore.getMessages as any).mockResolvedValueOnce([
      { id: '1', type: 'user', content: 'hello', timestamp: 1000 },
    ]);

    const mockWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as any;

    await sendSnapshot('proj-1', mockWs);

    const calls = mockWs.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'status', status: 'idle' }),
      expect.objectContaining({ type: 'nav', url: 'https://example.com/dashboard' }),
      expect.objectContaining({ type: 'screenshot', data: 'screenshot-data' }),
      expect.objectContaining({ type: 'sessionRestore' }),
    ]));
  });

  it('sendSnapshot sends taskInterrupted for interrupted sessions', async () => {
    (redisStore.getSession as any).mockResolvedValueOnce({
      ...mockRedisSession,
      status: 'interrupted',
      lastTask: 'Fill out the form',
    });
    (redisStore.getScreenshot as any).mockResolvedValueOnce(null);
    (redisStore.getMessages as any).mockResolvedValueOnce([]);

    const mockWs = { readyState: WebSocket.OPEN, send: vi.fn() } as any;
    await sendSnapshot('proj-1', mockWs);

    const calls = mockWs.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    expect(calls).toContainEqual(
      expect.objectContaining({ type: 'taskInterrupted', task: 'Fill out the form' })
    );
  });

  it('sendSnapshot sends sessionCrashed for crashed sessions', async () => {
    (redisStore.getSession as any).mockResolvedValueOnce({
      ...mockRedisSession,
      status: 'crashed',
    });
    (redisStore.getScreenshot as any).mockResolvedValueOnce(null);
    (redisStore.getMessages as any).mockResolvedValueOnce([]);

    const mockWs = { readyState: WebSocket.OPEN, send: vi.fn() } as any;
    await sendSnapshot('proj-1', mockWs);

    const calls = mockWs.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    expect(calls).toContainEqual(
      expect.objectContaining({ type: 'sessionCrashed' })
    );
  });
});

describe('sessionManager — LRU eviction', () => {
  beforeEach(() => {
    _resetLocalState();
    vi.clearAllMocks();
  });

  it('evictLRUSession evicts oldest detached session first', async () => {
    // Create 2 sessions
    await createSession('agent-a', 'http://a.com', 'db-a');
    await createSession('agent-b', 'http://b.com', 'db-b');
    vi.clearAllMocks(); // Clear create mocks

    // agent-b has a WS client (not detached), agent-a is detached
    const mockWsB = { readyState: 1, send: vi.fn() } as any;
    addClient('agent-b', mockWsB);

    // Mock getSession to return different lastActivityAt
    (redisStore.getSession as any)
      .mockResolvedValueOnce({ ...mockRedisSession, lastActivityAt: 1000 }) // agent-a (older)
      .mockResolvedValueOnce({ ...mockRedisSession, lastActivityAt: 2000 }) // agent-b (newer)
      .mockResolvedValueOnce({ ...mockRedisSession, browserPid: 12345, cdpPort: 19300, dbSessionId: 'db-a' }); // destroy reads session

    const evicted = await evictLRUSession();
    expect(evicted).toBe('agent-a');
    expect(redisStore.deleteSession).toHaveBeenCalledWith('agent-a');
  });

  it('evictLRUSession notifies active client on eviction when no detached', async () => {
    await createSession('agent-a', 'http://a.com', 'db-a');
    vi.clearAllMocks();

    const mockWsA = { readyState: 1, send: vi.fn() } as any;
    addClient('agent-a', mockWsA);

    (redisStore.getSession as any)
      .mockResolvedValueOnce({ ...mockRedisSession, lastActivityAt: 1000 }) // for eviction query
      .mockResolvedValueOnce({ ...mockRedisSession, browserPid: 12345, cdpPort: 19300, dbSessionId: 'db-a' }); // for destroySession

    await evictLRUSession();

    expect(mockWsA.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"session_evicted"')
    );
  });

  it('ensureCapacity is no-op when under capacity', async () => {
    // With default MAX_CONCURRENT_BROWSERS=3, having 1 session is fine
    await createSession('agent-a', 'http://a.com', 'db-a');
    vi.clearAllMocks();

    await ensureCapacity();

    expect(redisStore.deleteSession).not.toHaveBeenCalled();
  });

  it('ensureCapacity evicts until under MAX_CONCURRENT_BROWSERS', async () => {
    // Default MAX_CONCURRENT_BROWSERS=3, create 3 sessions to hit limit
    await createSession('agent-a', 'http://a.com', 'db-a');
    await createSession('agent-b', 'http://b.com', 'db-b');
    await createSession('agent-c', 'http://c.com', 'db-c');
    vi.clearAllMocks();

    // Mock getSession calls: eviction query for 3 agents, then destroySession reads
    (redisStore.getSession as any)
      .mockResolvedValueOnce({ ...mockRedisSession, lastActivityAt: 1000 }) // agent-a (oldest)
      .mockResolvedValueOnce({ ...mockRedisSession, lastActivityAt: 2000 }) // agent-b
      .mockResolvedValueOnce({ ...mockRedisSession, lastActivityAt: 3000 }) // agent-c
      .mockResolvedValueOnce({ ...mockRedisSession, browserPid: 12345, cdpPort: 19300, dbSessionId: 'db-a' }); // destroySession for agent-a

    await ensureCapacity();

    // Should have evicted 1 session (3 >= 3, evict until < 3)
    expect(redisStore.deleteSession).toHaveBeenCalledWith('agent-a');
    expect(redisStore.deleteSession).toHaveBeenCalledTimes(1);
  });

  it('beforeEvict hook is called before destroy', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    setBeforeEvictHook(hook);

    await createSession('agent-a', 'http://a.com', 'db-a');
    vi.clearAllMocks();

    (redisStore.getSession as any)
      .mockResolvedValueOnce({ ...mockRedisSession, lastActivityAt: 1000 }) // eviction query
      .mockResolvedValueOnce({ ...mockRedisSession, browserPid: 12345, cdpPort: 19300, dbSessionId: 'db-a' }); // destroySession

    await evictLRUSession();

    expect(hook).toHaveBeenCalledWith('agent-a');
    // Hook should be called BEFORE deleteSession
    const hookOrder = hook.mock.invocationCallOrder[0];
    const deleteOrder = (redisStore.deleteSession as any).mock.invocationCallOrder[0];
    expect(hookOrder).toBeLessThan(deleteOrder);
  });

  it('callBeforeEvictHook calls the registered hook', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    setBeforeEvictHook(hook);

    await callBeforeEvictHook('test-agent');
    expect(hook).toHaveBeenCalledWith('test-agent');
  });
});

describe('sessionManager — detached timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetLocalState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts detached timer when last client disconnects', async () => {
    await createSession('agent-a', 'http://a.com', 'db-a');
    const mockWs = { readyState: 1, send: vi.fn() } as any;
    addClient('agent-a', mockWs);
    vi.clearAllMocks();

    removeClient('agent-a', mockWs);

    // Should have set detachedAt in Redis
    expect(redisStore.setSession).toHaveBeenCalledWith(
      'agent-a',
      expect.objectContaining({ detachedAt: expect.any(Number) })
    );
  });

  it('cancels detached timer when client reconnects', async () => {
    await createSession('agent-a', 'http://a.com', 'db-a');
    const mockWs1 = { readyState: 1, send: vi.fn() } as any;
    addClient('agent-a', mockWs1);
    removeClient('agent-a', mockWs1);
    vi.clearAllMocks();

    // Reconnect
    const mockWs2 = { readyState: 1, send: vi.fn() } as any;
    addClient('agent-a', mockWs2);

    // Should reset detachedAt to 0
    expect(redisStore.setSession).toHaveBeenCalledWith(
      'agent-a',
      expect.objectContaining({ detachedAt: 0 })
    );

    // Advance past detached timeout — session should NOT be destroyed
    await vi.advanceTimersByTimeAsync(130_000);
    expect(redisStore.deleteSession).not.toHaveBeenCalled();
  });

  it('destroys session when detached timer fires', async () => {
    await createSession('agent-a', 'http://a.com', 'db-a');
    const mockWs = { readyState: 1, send: vi.fn() } as any;
    addClient('agent-a', mockWs);
    removeClient('agent-a', mockWs);
    vi.clearAllMocks();

    // Mock getSession for destroySession
    (redisStore.getSession as any).mockResolvedValueOnce({
      ...mockRedisSession,
      browserPid: 12345,
      cdpPort: 19300,
      dbSessionId: 'db-a',
    });

    // Advance past detached timeout (120s)
    await vi.advanceTimersByTimeAsync(121_000);

    expect(redisStore.deleteSession).toHaveBeenCalledWith('agent-a');
  });
});

describe('sessionManager — absolute timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetLocalState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends session_expiring warning 5 minutes before expiry', async () => {
    await createSession('agent-a', 'http://a.com', 'db-a');
    const mockWs = { readyState: 1, send: vi.fn() } as any;
    addClient('agent-a', mockWs);
    vi.clearAllMocks();

    // Advance to 25 minutes (warning point for 30min timeout)
    await vi.advanceTimersByTimeAsync(1500_000); // 25 * 60 * 1000

    expect(mockWs.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"session_expiring"')
    );
  });

  it('destroys session when absolute timeout fires', async () => {
    await createSession('agent-a', 'http://a.com', 'db-a');
    vi.clearAllMocks();

    // Mock getSession for destroySession
    (redisStore.getSession as any).mockResolvedValueOnce({
      ...mockRedisSession,
      browserPid: 12345,
      cdpPort: 19300,
      dbSessionId: 'db-a',
    });

    // Advance past absolute timeout (30 min = 1800s)
    await vi.advanceTimersByTimeAsync(1801_000);

    expect(redisStore.deleteSession).toHaveBeenCalledWith('agent-a');
  });
});
