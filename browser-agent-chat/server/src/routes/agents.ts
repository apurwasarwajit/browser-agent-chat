import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../auth.js';
import { encryptCredentials } from '../crypto.js';
import {
  createAgent, getAgent, listAgents, updateAgent, deleteAgent, getAgentListStats,
  getTasksBySession, getStepsByTask,
} from '../db.js';
import { supabase } from '../supabase.js';
import type { CreateAgentRequest, AgentResponse, AgentListItem } from '../types.js';

const router = Router();

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

// List user's agents
router.get('/', requireAuth, async (req, res) => {
  const { userId } = req as AuthenticatedRequest;
  const agents = await listAgents(userId);

  const agentIds = agents.map(p => p.id);
  const stats = await getAgentListStats(agentIds);

  const items: AgentListItem[] = agents.map(p => {
    const s = stats.get(p.id);
    return {
      id: p.id,
      name: p.name,
      url: p.url,
      hasCredentials: p.credentials !== null,
      context: p.context,
      created_at: p.created_at,
      updated_at: p.updated_at,
      findings_count: s?.findingsCount ?? 0,
      last_session_at: s?.lastSessionAt ?? null,
    };
  });
  res.json({ agents: items });
});

// Create agent
router.post('/', requireAuth, async (req, res) => {
  const { userId } = req as AuthenticatedRequest;
  const body = req.body as CreateAgentRequest;

  if (!body.name || !body.url) {
    res.status(400).json({ error: 'name and url are required' });
    return;
  }

  const encrypted = body.credentials ? encryptCredentials(body.credentials) : null;
  const agent = await createAgent(userId, body.name, normalizeUrl(body.url), encrypted, body.context ?? null);

  if (!agent) {
    res.status(500).json({ error: 'Failed to create agent' });
    return;
  }

  const response: AgentResponse = {
    id: agent.id,
    name: agent.name,
    url: agent.url,
    hasCredentials: agent.credentials !== null,
    context: agent.context,
    created_at: agent.created_at,
    updated_at: agent.updated_at,
  };
  res.status(201).json(response);
});

// Get agent details
router.get('/:id', requireAuth, async (req, res) => {
  const agentId = req.params.id as string;
  const agent = await getAgent(agentId);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

  const response: AgentResponse = {
    id: agent.id,
    name: agent.name,
    url: agent.url,
    hasCredentials: agent.credentials !== null,
    context: agent.context,
    created_at: agent.created_at,
    updated_at: agent.updated_at,
  };
  res.json(response);
});

// Update agent
router.put('/:id', requireAuth, async (req, res) => {
  const agentId = req.params.id as string;
  const updates: Record<string, unknown> = {};
  if (req.body.name) updates.name = req.body.name;
  if (req.body.url) updates.url = normalizeUrl(req.body.url);
  if (req.body.context !== undefined) updates.context = req.body.context;
  if (req.body.credentials) updates.credentials = encryptCredentials(req.body.credentials);

  const agent = await updateAgent(agentId, updates);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

  res.json({
    id: agent.id, name: agent.name, url: agent.url,
    hasCredentials: agent.credentials !== null,
    context: agent.context, created_at: agent.created_at, updated_at: agent.updated_at,
  });
});

// Delete agent
router.delete('/:id', requireAuth, async (req, res) => {
  const agentId = req.params.id as string;
  const success = await deleteAgent(agentId);
  if (!success) { res.status(404).json({ error: 'Agent not found' }); return; }
  res.status(204).send();
});

// GET sessions for agent
router.get('/:id/sessions', requireAuth, async (req, res) => {
  const agentId = req.params.id;
  const { data, error } = await supabase!
    .from('sessions')
    .select('*')
    .eq('agent_id', agentId)
    .order('started_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

// GET tasks for session
router.get('/:id/sessions/:sid/tasks', requireAuth, async (req, res) => {
  try {
    const tasks = await getTasksBySession(req.params.sid as string);
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// GET steps for task
router.get('/:id/tasks/:tid/steps', requireAuth, async (req, res) => {
  try {
    const steps = await getStepsByTask(req.params.tid as string);
    res.json(steps);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch steps' });
  }
});

export default router;
