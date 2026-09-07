import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import {
  CheckArraySchema,
  MAX_REGEX_INPUT_LENGTH,
  MAX_REGEX_PATTERN_LENGTH,
  runChecks,
} from '../src/eval/checks.js';

describe('eval regex checks', () => {
  it('accepts and evaluates RE2-compatible patterns', async () => {
    const checks = [{ type: 'url_matches' as const, pattern: '^https://example\\.com/path$' }];
    expect(CheckArraySchema.safeParse(checks).success).toBe(true);

    const page = { url: vi.fn().mockReturnValue('https://example.com/path') } as unknown as Page;
    const [result] = await runChecks(page, checks);

    expect(result).toMatchObject({ passed: true, actual: 'https://example.com/path' });
  });

  it('rejects regex features unsupported by RE2 during validation', () => {
    const result = CheckArraySchema.safeParse([
      { type: 'url_matches', pattern: '^(a+)\\1$' },
    ]);

    expect(result.success).toBe(false);
  });

  it('rejects patterns over the configured limit', () => {
    const result = CheckArraySchema.safeParse([
      { type: 'page_title', pattern: 'a'.repeat(MAX_REGEX_PATTERN_LENGTH + 1) },
    ]);

    expect(result.success).toBe(false);
  });

  it('evaluates nested quantifiers safely with RE2', async () => {
    const url = `${'a'.repeat(MAX_REGEX_INPUT_LENGTH - 1)}!`;
    const page = { url: vi.fn().mockReturnValue(url) } as unknown as Page;
    const [result] = await runChecks(page, [
      { type: 'url_matches', pattern: '^(a+)+$' },
    ]);

    expect(result.passed).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('refuses oversized URLs before matching', async () => {
    const page = { url: vi.fn().mockReturnValue('a'.repeat(MAX_REGEX_INPUT_LENGTH + 1)) } as unknown as Page;
    const [result] = await runChecks(page, [
      { type: 'url_matches', pattern: '(a+)+$' },
    ]);

    expect(result.passed).toBe(false);
    expect(result.error).toBe(`URL must be at most ${MAX_REGEX_INPUT_LENGTH} characters`);
  });
});
