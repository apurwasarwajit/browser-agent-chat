import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { CheckSchema, runChecks } from '../src/eval/checks.js';

describe('eval checks', () => {
  it('rejects unsafe and oversized regex patterns', () => {
    expect(CheckSchema.safeParse({ type: 'page_title', pattern: '^(a+)+$' }).success).toBe(false);
    expect(CheckSchema.safeParse({ type: 'url_matches', pattern: 'a'.repeat(513) }).success).toBe(false);
  });

  it('matches URL and title patterns with RE2', async () => {
    const page = {
      url: () => 'https://example.com/dashboard',
      title: async () => 'Example Dashboard',
    } as unknown as Page;

    const results = await runChecks(page, [
      { type: 'url_matches', pattern: '^https://example\\.com/' },
      { type: 'page_title', pattern: 'Dashboard$' },
    ]);

    expect(results.map(result => result.passed)).toEqual([true, true]);
  });

  it('rejects oversized runtime input from previously stored checks', async () => {
    const page = {
      title: async () => 'a'.repeat(16_385),
    } as unknown as Page;

    const [result] = await runChecks(page, [{ type: 'page_title', pattern: '^a+$' }]);

    expect(result.passed).toBe(false);
    expect(result.error).toContain('must be at most 16384 characters');
  });

  it('rejects an unsafe pattern from a previously stored check', async () => {
    const page = {
      title: async () => `${'a'.repeat(10_000)}!`,
    } as unknown as Page;

    const [result] = await runChecks(page, [{ type: 'page_title', pattern: '^(a+)+$' }]);

    expect(result.passed).toBe(false);
    expect(result.error).toContain('unsafe or invalid repetition');
  });
});
