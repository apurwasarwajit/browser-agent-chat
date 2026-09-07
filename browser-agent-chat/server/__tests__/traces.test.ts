import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, mockFetchTraceDetail, mockGetAgent } = vi.hoisted(() => ({
  get: vi.fn(),
  mockFetchTraceDetail: vi.fn(),
  mockGetAgent: vi.fn(),
}));

vi.mock('express', () => ({
  Router: vi.fn(() => ({ get })),
}));

vi.mock('../src/auth.js', () => ({
  requireAuth: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getAgent: mockGetAgent,
}));

vi.mock('../src/langfuse.js', () => ({
  fetchAgentTraces: vi.fn(),
  fetchTraceDetail: mockFetchTraceDetail,
  isLangfuseEnabled: vi.fn(() => true),
}));

vi.mock('../src/supabase.js', () => ({
  supabase: null,
}));

await import('../src/routes/traces.js');

const detailHandler = get.mock.calls.find(([path]) => path === '/:traceId')![2];

function createResponse() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

describe('trace detail route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects access before fetching a trace when the user does not own the agent', async () => {
    mockGetAgent.mockResolvedValue({ id: 'agent-1', user_id: 'other-user' });
    const req = { params: { id: 'agent-1', traceId: 'trace-1' }, userId: 'user-1' };
    const res = createResponse();

    await detailHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockFetchTraceDetail).not.toHaveBeenCalled();
  });

  it('scopes the trace lookup to an agent owned by the user', async () => {
    mockGetAgent.mockResolvedValue({ id: 'agent-1', user_id: 'user-1' });
    mockFetchTraceDetail.mockResolvedValue({ id: 'trace-1' });
    const req = { params: { id: 'agent-1', traceId: 'trace-1' }, userId: 'user-1' };
    const res = createResponse();

    await detailHandler(req, res);

    expect(mockFetchTraceDetail).toHaveBeenCalledWith('trace-1', 'agent-1');
    expect(res.json).toHaveBeenCalledWith({ id: 'trace-1' });
  });
});
