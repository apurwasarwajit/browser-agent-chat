import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../auth.js';
import { getAgent } from '../db.js';
import { fetchAgentTraces, fetchTraceDetail, isLangfuseEnabled } from '../langfuse.js';
import { supabase } from '../supabase.js';

const router = Router({ mergeParams: true });

// List traces grouped by session
router.get('/', requireAuth, async (req, res) => {
  if (!isLangfuseEnabled()) {
    res.status(503).json({ error: 'Langfuse is not configured' });
    return;
  }

  const agentId = req.params.id as string;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;

  try {
    const { traces, meta } = await fetchAgentTraces(agentId, page, limit);

    // Group traces by sessionId
    const sessionMap = new Map<string, typeof traces>();
    for (const trace of traces) {
      const sid = trace.sessionId ?? '__no_session__';
      if (!sessionMap.has(sid)) sessionMap.set(sid, []);
      sessionMap.get(sid)!.push(trace);
    }

    // Fetch session metadata from Supabase for startedAt timestamps
    const sessionIds = [...sessionMap.keys()].filter(s => s !== '__no_session__');
    let sessionMeta: Record<string, string> = {};
    if (sessionIds.length > 0 && supabase) {
      const { data } = await supabase
        .from('sessions')
        .select('id, created_at')
        .in('id', sessionIds);
      if (data) {
        sessionMeta = Object.fromEntries(data.map(s => [s.id, s.created_at]));
      }
    }

    // Build response
    const sessions = [...sessionMap.entries()].map(([sessionId, sessionTraces]) => ({
      sessionId: sessionId === '__no_session__' ? null : sessionId,
      startedAt: sessionMeta[sessionId] ?? sessionTraces[0]?.timestamp ?? null,
      traces: sessionTraces,
    }));

    // Sort sessions by startedAt descending
    sessions.sort((a, b) => {
      const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return tb - ta;
    });

    res.json({ sessions, meta });
  } catch (err) {
    console.error('[TRACES] Error fetching traces:', err);
    const message = err instanceof Error ? err.message : 'Failed to fetch traces';
    res.status(500).json({ error: message });
  }
});

// Get trace detail with observations
router.get('/:traceId', requireAuth, async (req, res) => {
  if (!isLangfuseEnabled()) {
    res.status(503).json({ error: 'Langfuse is not configured' });
    return;
  }

  const { userId } = req as AuthenticatedRequest;
  const agentId = req.params.id as string;
  const traceId = req.params.traceId as string;

  try {
    const agent = await getAgent(agentId);
    if (!agent || agent.user_id !== userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const detail = await fetchTraceDetail(traceId, agentId);
    if (!detail) {
      res.status(404).json({ error: 'Trace not found' });
      return;
    }
    res.json(detail);
  } catch (err) {
    console.error('[TRACES] Error fetching trace detail:', err);
    const message = err instanceof Error ? err.message : 'Failed to fetch trace';
    res.status(500).json({ error: message });
  }
});

export default router;
