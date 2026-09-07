import { z } from 'zod';
import type { Page } from 'playwright';
import { RE2 } from 're2-wasm';
import type { Check } from '../types.js';

export const MAX_REGEX_PATTERN_LENGTH = 512;
export const MAX_REGEX_INPUT_LENGTH = 8_192;

function compileRegex(pattern: string): RE2 {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(`Pattern must be at most ${MAX_REGEX_PATTERN_LENGTH} characters`);
  }
  return new RE2(pattern, 'u');
}

const RegexPatternSchema = z.string()
  .max(MAX_REGEX_PATTERN_LENGTH)
  .superRefine((pattern, ctx) => {
    try {
      compileRegex(pattern);
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof Error ? err.message : 'Invalid RE2 pattern',
      });
    }
  });

// Zod schema for validating Check objects from user input
export const CheckSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url_matches'), pattern: RegexPatternSchema }),
  z.object({ type: z.literal('element_exists'), selector: z.string() }),
  z.object({ type: z.literal('element_absent'), selector: z.string() }),
  z.object({ type: z.literal('text_contains'), selector: z.string(), text: z.string() }),
  z.object({ type: z.literal('page_title'), pattern: RegexPatternSchema }),
  z.object({ type: z.literal('custom_js'), script: z.string(), expected: z.any() }),
]);

export const CheckArraySchema = z.array(CheckSchema);

export interface CheckResult {
  check: Check;
  passed: boolean;
  actual?: string;
  error?: string;
}

export async function runChecks(page: Page, checks: Check[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const check of checks) {
    try {
      const result = await runSingleCheck(page, check);
      results.push(result);
    } catch (err) {
      results.push({
        check,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

async function runSingleCheck(page: Page, check: Check): Promise<CheckResult> {
  switch (check.type) {
    case 'url_matches': {
      const url = page.url();
      if (url.length > MAX_REGEX_INPUT_LENGTH) {
        throw new Error(`URL must be at most ${MAX_REGEX_INPUT_LENGTH} characters`);
      }
      const passed = compileRegex(check.pattern).test(url);
      return { check, passed, actual: url };
    }

    case 'element_exists': {
      const element = await page.$(check.selector);
      return { check, passed: element !== null };
    }

    case 'element_absent': {
      const element = await page.$(check.selector);
      return { check, passed: element === null };
    }

    case 'text_contains': {
      const element = await page.$(check.selector);
      if (!element) {
        return { check, passed: false, actual: '<element not found>' };
      }
      const text = await element.textContent() ?? '';
      const passed = text.includes(check.text);
      return { check, passed, actual: text.slice(0, 200) };
    }

    case 'page_title': {
      const title = await page.title();
      if (title.length > MAX_REGEX_INPUT_LENGTH) {
        throw new Error(`Page title must be at most ${MAX_REGEX_INPUT_LENGTH} characters`);
      }
      const passed = compileRegex(check.pattern).test(title);
      return { check, passed, actual: title };
    }

    case 'custom_js': {
      const result = await page.evaluate(check.script);
      const passed = JSON.stringify(result) === JSON.stringify(check.expected);
      return { check, passed, actual: JSON.stringify(result) };
    }

    default: {
      const _exhaustive: never = check;
      throw new Error(`Unknown check type: ${(_exhaustive as Check).type}`);
    }
  }
}

export function summarizeChecks(results: CheckResult[]): Record<string, boolean> {
  const summary: Record<string, boolean> = {};
  for (const r of results) {
    const key = r.check.type === 'custom_js'
      ? `custom_js`
      : `${r.check.type}:${'pattern' in r.check ? r.check.pattern : 'selector' in r.check ? r.check.selector : ''}`;
    summary[key] = r.passed;
  }
  return summary;
}
