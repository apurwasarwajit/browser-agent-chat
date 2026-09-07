import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createEvalRun } = vi.hoisted(() => ({ createEvalRun: vi.fn() }));

vi.mock('../src/agent.js', () => ({ createAgent: vi.fn(), executeTask: vi.fn() }));
vi.mock('../src/browserManager.js', () => ({
  claimWarm: vi.fn(),
  killBrowser: vi.fn(),
  launchBrowser: vi.fn(),
}));
vi.mock('../src/db.js', () => ({
  createEvalRun,
  updateEvalRun: vi.fn().mockResolvedValue(true),
  createEvalResult: vi.fn(),
  listEvalCases: vi.fn().mockResolvedValue([]),
}));
vi.mock('../src/eval/checks.js', () => ({ runChecks: vi.fn(), summarizeChecks: vi.fn() }));
vi.mock('../src/eval/llm-judge.js', () => ({ judgeWithLLM: vi.fn() }));
vi.mock('../src/eval/error-analyzer.js', () => ({ classifyError: vi.fn() }));

import { EvalRunLimitError, startEvalRun } from '../src/eval/eval-runner.js';

describe('eval run limits', () => {
  beforeEach(() => {
    createEvalRun.mockReset();
  });

  it('reserves a per-user slot while a run is being created', async () => {
    let finishCreation!: (value: null) => void;
    createEvalRun.mockReturnValueOnce(new Promise<null>(resolve => { finishCreation = resolve; }));

    const firstStart = startEvalRun('agent-1', 'user-concurrent', 'manual', vi.fn());

    await expect(startEvalRun('agent-2', 'user-concurrent', 'manual', vi.fn()))
      .rejects.toBeInstanceOf(EvalRunLimitError);

    finishCreation(null);
    await expect(firstStart).resolves.toBeNull();
  });

  it('limits the number of starts per user in the rate window', async () => {
    createEvalRun.mockResolvedValue(null);

    for (let i = 0; i < 10; i++) {
      await startEvalRun(`agent-${i}`, 'user-rate-limited', 'manual', vi.fn());
    }

    await expect(startEvalRun('agent-blocked', 'user-rate-limited', 'manual', vi.fn()))
      .rejects.toThrow('rate limit exceeded');
  });
});
