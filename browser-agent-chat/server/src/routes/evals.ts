import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../auth.js';
import {
  listEvalCases,
  createEvalCase,
  updateEvalCase,
  deleteEvalCase,
  listEvalRuns,
  getEvalRun,
  listEvalResults,
  updateEvalRun,
  updateAgentEvalSchedule,
} from '../db.js';
import { CheckArraySchema } from '../eval/checks.js';
import { startEvalRun, cancelRun, EvalRunLimitError } from '../eval/eval-runner.js';
import { seedEvalCases } from '../eval/seed.js';
import type { ServerMessage, Check } from '../types.js';

const router = Router({ mergeParams: true });

// Placeholder broadcast — wired to real WS broadcast when mounted in index.ts
const broadcast: (msg: ServerMessage) => void = (msg) => {
  if (msg.type === 'evalProgress' || msg.type === 'evalComplete') {
    console.log(`Eval ${msg.type}:`, JSON.stringify(msg).slice(0, 200));
  }
};

// GET /api/projects/:id/evals/cases — list eval cases
router.get('/cases', requireAuth, async (req, res) => {
  const agentId = req.params.id as string;
  const filters: { status?: 'active' | 'disabled'; tags?: string[] } = {};
  if (req.query.status) filters.status = req.query.status as 'active' | 'disabled';
  if (req.query.tags) {
    const raw = req.query.tags as string;
    filters.tags = raw.split(',').map(t => t.trim()).filter(Boolean);
  }
  const cases = await listEvalCases(agentId, filters);
  res.json({ cases });
});

// POST /api/projects/:id/evals/cases — create eval case
router.post('/cases', requireAuth, async (req, res) => {
  const agentId = req.params.id as string;
  const { name, task_prompt, source_type, source_id, checks, llm_judge_criteria, tags, status } = req.body;

  if (!name || !task_prompt || !source_type) {
    res.status(400).json({ error: 'name, task_prompt, and source_type are required' });
    return;
  }

  // Validate checks array with Zod
  const checksResult = CheckArraySchema.safeParse(checks ?? []);
  if (!checksResult.success) {
    res.status(400).json({ error: 'Invalid checks', details: checksResult.error.issues });
    return;
  }

  const evalCase = await createEvalCase({
    agent_id: agentId,
    name,
    task_prompt,
    source_type: source_type ?? 'manual',
    source_id: source_id ?? null,
    checks: checksResult.data as Check[],
    llm_judge_criteria: llm_judge_criteria ?? null,
    tags: tags ?? [],
    status: status ?? 'active',
  });

  if (!evalCase) { res.status(500).json({ error: 'Failed to create eval case' }); return; }
  res.status(201).json({ case: evalCase });
});

// PUT /api/projects/:id/evals/cases/:caseId — update eval case
router.put('/cases/:caseId', requireAuth, async (req, res) => {
  const caseId = req.params.caseId as string;
  const { name, task_prompt, checks, llm_judge_criteria, tags, status } = req.body;

  const updates: Parameters<typeof updateEvalCase>[1] = {};
  if (name !== undefined) updates.name = name;
  if (task_prompt !== undefined) updates.task_prompt = task_prompt;
  if (llm_judge_criteria !== undefined) updates.llm_judge_criteria = llm_judge_criteria;
  if (tags !== undefined) updates.tags = tags;
  if (status !== undefined) updates.status = status;

  if (checks !== undefined) {
    const checksResult = CheckArraySchema.safeParse(checks);
    if (!checksResult.success) {
      res.status(400).json({ error: 'Invalid checks', details: checksResult.error.issues });
      return;
    }
    updates.checks = checksResult.data as Check[];
  }

  const updated = await updateEvalCase(caseId, updates);
  if (!updated) { res.status(404).json({ error: 'Eval case not found' }); return; }
  res.json({ case: updated });
});

// DELETE /api/projects/:id/evals/cases/:caseId — delete eval case
router.delete('/cases/:caseId', requireAuth, async (req, res) => {
  const caseId = req.params.caseId as string;
  const success = await deleteEvalCase(caseId);
  if (!success) { res.status(404).json({ error: 'Eval case not found' }); return; }
  res.status(204).send();
});

// POST /api/projects/:id/evals/run — trigger a new eval run
router.post('/run', requireAuth, async (req, res) => {
  const agentId = req.params.id as string;
  const { userId } = req as AuthenticatedRequest;
  const { trigger = 'manual', tags } = req.body;

  const validTriggers = ['manual', 'scheduled', 'ci'];
  if (!validTriggers.includes(trigger)) {
    res.status(400).json({ error: 'trigger must be one of: manual, scheduled, ci' });
    return;
  }

  const parsedTags = Array.isArray(tags) ? tags as string[] : undefined;

  let run;
  try {
    run = await startEvalRun(agentId, userId, trigger, broadcast, parsedTags);
  } catch (err) {
    if (err instanceof EvalRunLimitError) {
      res.status(429).json({ error: err.message });
      return;
    }
    throw err;
  }
  if (!run) { res.status(500).json({ error: 'Failed to start eval run' }); return; }
  res.status(201).json({ run });
});

// GET /api/projects/:id/evals/runs — list eval runs
router.get('/runs', requireAuth, async (req, res) => {
  const agentId = req.params.id as string;
  const limit = parseInt(req.query.limit as string) || 20;
  const runs = await listEvalRuns(agentId, limit);
  res.json({ runs });
});

// GET /api/projects/:id/evals/runs/:runId — get run detail + enriched results
router.get('/runs/:runId', requireAuth, async (req, res) => {
  const runId = req.params.runId as string;
  const run = await getEvalRun(runId);
  if (!run) { res.status(404).json({ error: 'Eval run not found' }); return; }

  const results = await listEvalResults(runId);

  // Enrich results with case names and source types
  const cases = await listEvalCases(run.agent_id);
  const caseMap = new Map(cases.map(c => [c.id, c]));
  const enrichedResults = results.map(r => ({
    ...r,
    case_name: caseMap.get(r.case_id)?.name ?? r.case_id,
    case_source_type: caseMap.get(r.case_id)?.source_type ?? 'unknown',
  }));

  res.json({ run, results: enrichedResults });
});

// POST /api/projects/:id/evals/runs/:runId/cancel — cancel a running eval
router.post('/runs/:runId/cancel', requireAuth, async (req, res) => {
  const runId = req.params.runId as string;
  const run = await getEvalRun(runId);
  if (!run) { res.status(404).json({ error: 'Eval run not found' }); return; }

  if (run.status !== 'running') {
    res.status(400).json({ error: `Run is not in running state (current: ${run.status})` });
    return;
  }

  const cancelled = cancelRun(runId);
  if (!cancelled) {
    // Run completed before we could cancel it — mark as is
    res.json({ success: false, message: 'Run may have already completed' });
    return;
  }

  // Update status optimistically — runCasesSequentially will finalize it
  await updateEvalRun(runId, { status: 'cancelled', completed_at: new Date().toISOString() });
  res.json({ success: true });
});

// POST /api/projects/:id/evals/seed — seed eval cases from features/flows/findings
router.post('/seed', requireAuth, async (req, res) => {
  const agentId = req.params.id as string;
  const result = await seedEvalCases(agentId);
  res.json(result);
});

// POST /api/projects/:id/evals/schedule — set cron schedule
router.post('/schedule', requireAuth, async (req, res) => {
  const agentId = req.params.id as string;
  const { cron_schedule } = req.body;

  // Allow null to clear the schedule
  if (cron_schedule !== null && cron_schedule !== undefined && typeof cron_schedule !== 'string') {
    res.status(400).json({ error: 'cron_schedule must be a string or null' });
    return;
  }

  const success = await updateAgentEvalSchedule(agentId, cron_schedule ?? null);
  if (!success) { res.status(500).json({ error: 'Failed to update eval schedule' }); return; }
  res.json({ success: true, cron_schedule: cron_schedule ?? null });
});

export default router;
