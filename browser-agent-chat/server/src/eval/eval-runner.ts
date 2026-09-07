import { createAgent, executeTask } from '../agent.js';
import { claimWarm, killBrowser, launchBrowser } from '../browserManager.js';
import {
  createEvalRun, updateEvalRun, createEvalResult,
  listEvalCases,
} from '../db.js';
import type { EvalRunTrigger, EvalRun, EvalCase, ServerMessage, ErrorType } from '../types.js';
import { runChecks, summarizeChecks } from './checks.js';
import type { CheckResult } from './checks.js';
import { judgeWithLLM } from './llm-judge.js';
import { classifyError } from './error-analyzer.js';

type EvalBroadcast = (msg: ServerMessage) => void;

function positiveIntFromEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const MAX_CONCURRENT_EVAL_RUNS = positiveIntFromEnv('MAX_CONCURRENT_EVAL_RUNS', 3);
const MAX_CONCURRENT_EVAL_RUNS_PER_USER = positiveIntFromEnv('MAX_CONCURRENT_EVAL_RUNS_PER_USER', 1);
const EVAL_RUN_RATE_LIMIT = positiveIntFromEnv('EVAL_RUN_RATE_LIMIT', 10);
const EVAL_RUN_GLOBAL_RATE_LIMIT = positiveIntFromEnv('EVAL_RUN_GLOBAL_RATE_LIMIT', 30);
const EVAL_RUN_RATE_WINDOW_MS = positiveIntFromEnv('EVAL_RUN_RATE_WINDOW_MS', 60_000);

interface EvalRunState {
  cancelled: boolean;
  userId: string;
}

// Active runs tracked for cancellation
const activeRuns = new Map<string, EvalRunState>();
const pendingRunsByUser = new Map<string, number>();
const recentRunStartsByUser = new Map<string, number[]>();
let recentGlobalRunStarts: number[] = [];

export class EvalRunLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalRunLimitError';
  }
}

function reserveEvalRunSlot(userId: string): () => void {
  const pendingTotal = [...pendingRunsByUser.values()].reduce((total, count) => total + count, 0);
  const pendingForUser = pendingRunsByUser.get(userId) ?? 0;
  const activeForUser = [...activeRuns.values()].filter(run => run.userId === userId).length;

  if (activeRuns.size + pendingTotal >= MAX_CONCURRENT_EVAL_RUNS) {
    throw new EvalRunLimitError('The server is already running the maximum number of evals');
  }
  if (activeForUser + pendingForUser >= MAX_CONCURRENT_EVAL_RUNS_PER_USER) {
    throw new EvalRunLimitError('You already have the maximum number of active eval runs');
  }

  const now = Date.now();
  recentGlobalRunStarts = recentGlobalRunStarts
    .filter(startedAt => startedAt > now - EVAL_RUN_RATE_WINDOW_MS);
  if (recentGlobalRunStarts.length >= EVAL_RUN_GLOBAL_RATE_LIMIT) {
    throw new EvalRunLimitError('The server eval run rate limit was exceeded; try again later');
  }

  const recentStarts = (recentRunStartsByUser.get(userId) ?? [])
    .filter(startedAt => startedAt > now - EVAL_RUN_RATE_WINDOW_MS);
  if (recentStarts.length >= EVAL_RUN_RATE_LIMIT) {
    recentRunStartsByUser.set(userId, recentStarts);
    throw new EvalRunLimitError('Eval run rate limit exceeded; try again later');
  }

  recentRunStartsByUser.set(userId, [...recentStarts, now]);
  recentGlobalRunStarts.push(now);
  pendingRunsByUser.set(userId, pendingForUser + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const pending = pendingRunsByUser.get(userId) ?? 0;
    if (pending <= 1) pendingRunsByUser.delete(userId);
    else pendingRunsByUser.set(userId, pending - 1);
  };
}

export function cancelRun(runId: string): boolean {
  const run = activeRuns.get(runId);
  if (run) {
    run.cancelled = true;
    return true;
  }
  return false;
}

export async function startEvalRun(
  agentId: string,
  userId: string,
  trigger: EvalRunTrigger,
  broadcast: EvalBroadcast,
  tags?: string[],
): Promise<EvalRun | null> {
  const releaseReservation = reserveEvalRunSlot(userId);
  let run: EvalRun | null;
  try {
    // Create the run record while the slot is reserved to prevent concurrent requests racing the limits.
    run = await createEvalRun(agentId, trigger);
  } finally {
    releaseReservation();
  }
  if (!run) return null;

  const runState: EvalRunState = { cancelled: false, userId };
  activeRuns.set(run.id, runState);

  // Load eval cases
  const cases = await listEvalCases(agentId, { status: 'active', tags });
  if (cases.length === 0) {
    await updateEvalRun(run.id, {
      status: 'completed',
      summary: { total: 0, passed: 0, failed: 0, errored: 0, error_breakdown: {} },
      completed_at: new Date().toISOString(),
    });
    activeRuns.delete(run.id);
    return run;
  }

  // Kick off run asynchronously — returns immediately with the run record
  runCasesSequentially(run.id, agentId, cases, broadcast, runState).catch(err => {
    console.error(`[EvalRunner] Run ${run.id} failed with unexpected error:`, err);
    updateEvalRun(run.id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
    }).catch(() => {});
    activeRuns.delete(run.id);
  });

  return run;
}

async function runCasesSequentially(
  runId: string,
  agentId: string,
  cases: EvalCase[],
  broadcast: EvalBroadcast,
  runState: EvalRunState,
): Promise<void> {
  let passed = 0;
  let failed = 0;
  let errored = 0;
  const errorBreakdown: Record<string, number> = {};

  for (let i = 0; i < cases.length; i++) {
    if (runState.cancelled) {
      await updateEvalRun(runId, {
        status: 'cancelled',
        summary: { total: cases.length, passed, failed, errored, error_breakdown: errorBreakdown },
        completed_at: new Date().toISOString(),
      });
      activeRuns.delete(runId);
      return;
    }

    const evalCase = cases[i];
    const startTime = Date.now();

    try {
      const result = await runSingleCase(runId, agentId, evalCase);
      const duration = Date.now() - startTime;

      await createEvalResult({
        run_id: runId,
        case_id: evalCase.id,
        session_id: null,
        verdict: result.verdict,
        code_checks: result.codeChecks,
        llm_judge: result.llmJudge,
        error_type: result.errorType,
        steps_taken: result.steps,
        duration_ms: duration,
        screenshots: result.screenshots,
      });

      if (result.verdict === 'pass') {
        passed++;
      } else if (result.verdict === 'fail') {
        failed++;
        if (result.errorType) {
          errorBreakdown[result.errorType] = (errorBreakdown[result.errorType] ?? 0) + 1;
        }
      } else {
        errored++;
      }

      broadcast({
        type: 'evalProgress',
        runId,
        completed: i + 1,
        total: cases.length,
        latest: { case: evalCase.name, verdict: result.verdict },
      });
    } catch (err) {
      errored++;
      console.error(`[EvalRunner] Case ${evalCase.id} (${evalCase.name}) threw unexpectedly:`, err);
      await createEvalResult({
        run_id: runId,
        case_id: evalCase.id,
        session_id: null,
        verdict: 'error',
        code_checks: {},
        llm_judge: null,
        error_type: 'unexpected_state',
        steps_taken: [],
        duration_ms: Date.now() - startTime,
        screenshots: [],
      });
    }
  }

  const summary = {
    total: cases.length,
    passed,
    failed,
    errored,
    error_breakdown: errorBreakdown,
  };

  await updateEvalRun(runId, {
    status: 'completed',
    summary,
    completed_at: new Date().toISOString(),
  });
  activeRuns.delete(runId);

  broadcast({
    type: 'evalComplete',
    runId,
    summary: { total: cases.length, passed, failed, errorBreakdown },
  });
}

interface CaseResult {
  verdict: 'pass' | 'fail' | 'error';
  codeChecks: Record<string, boolean>;
  llmJudge: { verdict: string; reasoning: string } | null;
  errorType: ErrorType | null;
  steps: Array<{ order: number; action: string; target?: string }>;
  screenshots: string[];
}

async function runSingleCase(
  runId: string,
  agentId: string,
  evalCase: EvalCase,
): Promise<CaseResult> {
  // Attempt to claim a warm browser; fall back to launching a fresh one
  let browserInfo = await claimWarm(agentId);
  if (!browserInfo) {
    try {
      browserInfo = await launchBrowser(agentId);
    } catch (err) {
      console.error(`[EvalRunner] Failed to launch browser for case ${evalCase.id}:`, err);
      return {
        verdict: 'error',
        codeChecks: {},
        llmJudge: null,
        errorType: 'unexpected_state',
        steps: [],
        screenshots: [],
      };
    }
  }

  const steps: Array<{ order: number; action: string; target?: string }> = [];
  let lastScreenshot = '';

  // Eval-specific broadcast: captures steps and screenshots only — no Redis writes, no side effects
  const evalBroadcast: EvalBroadcast = (msg: ServerMessage) => {
    if (msg.type === 'action') {
      steps.push({ order: steps.length + 1, action: msg.action, target: msg.target });
    } else if (msg.type === 'screenshot') {
      lastScreenshot = msg.data;
    }
  };

  try {
    // Create agent — pass null for both sessionId and agentId to prevent:
    //   - nav graph writes (recordNavigation fires only when agentId is set)
    //   - finding/suggestion detection (both guarded by `if (agentId && sessionId)`)
    const agentSession = await createAgent(
      evalBroadcast,
      browserInfo.cdpEndpoint,
      null,  // sessionId
      null,  // agentId
    );

    try {
      // Execute the eval task
      await executeTask(agentSession, evalCase.task_prompt, evalBroadcast);

      if (lastScreenshot) {
        // screenshots array carries the final page state for the LLM judge
      }

      // Run code-based checks against the live page
      const page = agentSession.connector.getHarness().page;
      const checkResults: CheckResult[] = await runChecks(page, evalCase.checks);
      const codeChecks = summarizeChecks(checkResults);
      const allChecksPassed = checkResults.every(r => r.passed);

      let verdict: 'pass' | 'fail' = allChecksPassed ? 'pass' : 'fail';
      let llmJudge: { verdict: string; reasoning: string } | null = null;

      // Run LLM judge only when code checks pass and criteria + screenshot are available
      if (allChecksPassed && evalCase.llm_judge_criteria && lastScreenshot) {
        const stepsDesc = steps
          .map(s => `${s.order}. ${s.action}${s.target ? ` (${s.target})` : ''}`)
          .join('\n');
        llmJudge = await judgeWithLLM(
          lastScreenshot,
          evalCase.llm_judge_criteria,
          evalCase.task_prompt,
          stepsDesc,
        );
        verdict = llmJudge.verdict === 'pass' ? 'pass' : 'fail';
      }

      let errorType: ErrorType | null = null;
      if (verdict === 'fail') {
        const failedChecks = checkResults.filter(r => !r.passed);
        errorType = classifyError({
          steps,
          finalUrl: page.url(),
          failedChecks,
          taskPrompt: evalCase.task_prompt,
        });
      }

      await agentSession.close();

      const screenshots = lastScreenshot ? [lastScreenshot] : [];
      return { verdict, codeChecks, llmJudge, errorType, steps, screenshots };
    } catch (taskErr) {
      // Task execution failed — close agent gracefully before re-throwing
      await agentSession.close().catch(() => {});
      throw taskErr;
    }
  } finally {
    // Always release the browser, regardless of success or failure
    await killBrowser(browserInfo.pid, browserInfo.port);
  }
}
