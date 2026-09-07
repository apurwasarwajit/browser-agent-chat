import { z } from 'zod';
import type { Page } from 'playwright';
import { RE2 } from 're2-wasm';
import safeRegex from 'safe-regex2';
import type { Check } from '../types.js';

const MAX_PATTERN_LENGTH = 512;
const MAX_REGEX_INPUT_LENGTH = 16_384;

function compileSafePattern(pattern: string): RE2 {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`Regex pattern must be at most ${MAX_PATTERN_LENGTH} characters`);
  }
  if (!safeRegex(pattern)) {
    throw new Error('Regex pattern contains unsafe or invalid repetition');
  }

  try {
    return new RE2(pattern, 'u');
  } catch {
    throw new Error('Regex pattern uses invalid or unsupported syntax');
  }
}

const SafePatternSchema = z.string().superRefine((pattern, ctx) => {
  try {
    compileSafePattern(pattern);
  } catch (err) {
    ctx.addIssue({
      code: 'custom',
      message: err instanceof Error ? err.message : 'Invalid regex pattern',
    });
  }
});

function testSafePattern(pattern: string, input: string): boolean {
  if (input.length > MAX_REGEX_INPUT_LENGTH) {
    throw new Error(`Regex input must be at most ${MAX_REGEX_INPUT_LENGTH} characters`);
  }
  return compileSafePattern(pattern).test(input);
}

// Zod schema for validating Check objects from user input
export const CheckSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url_matches'), pattern: SafePatternSchema }),
  z.object({ type: z.literal('element_exists'), selector: z.string() }),
  z.object({ type: z.literal('element_absent'), selector: z.string() }),
  z.object({ type: z.literal('text_contains'), selector: z.string(), text: z.string() }),
  z.object({ type: z.literal('page_title'), pattern: SafePatternSchema }),
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
      const passed = testSafePattern(check.pattern, url);
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
      const passed = testSafePattern(check.pattern, title);
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
