import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import type { Check } from '../src/types.js';
import { CheckArraySchema, runChecks } from '../src/eval/checks.js';

describe('eval checks', () => {
  it('rejects custom JavaScript checks from user input', () => {
    const result = CheckArraySchema.safeParse([
      { type: 'custom_js', script: 'while (true) {}', expected: true },
    ]);

    expect(result.success).toBe(false);
  });

  it('does not execute custom JavaScript from legacy stored cases', async () => {
    const evaluate = vi.fn();
    const page = { evaluate } as unknown as Page;
    const legacyCheck = {
      type: 'custom_js',
      script: 'while (true) {}',
      expected: true,
    } as unknown as Check;

    const [result] = await runChecks(page, [legacyCheck]);

    expect(evaluate).not.toHaveBeenCalled();
    expect(result.passed).toBe(false);
    expect(result.error).toContain('Unknown check type: custom_js');
  });
});
