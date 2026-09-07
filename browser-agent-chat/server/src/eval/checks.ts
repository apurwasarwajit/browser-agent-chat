import { z } from 'zod';
import type { Page } from 'playwright';
import type { Check } from '../types.js';

// Zod schema for validating Check objects from user input
export const CheckSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url_matches'), pattern: z.string() }),
  z.object({ type: z.literal('element_exists'), selector: z.string() }),
  z.object({ type: z.literal('element_absent'), selector: z.string() }),
  z.object({ type: z.literal('text_contains'), selector: z.string(), text: z.string() }),
  z.object({ type: z.literal('page_title'), pattern: z.string() }),
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
      const passed = new RegExp(check.pattern).test(url);
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
      const passed = new RegExp(check.pattern).test(title);
      return { check, passed, actual: title };
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
    const key = `${r.check.type}:${'pattern' in r.check ? r.check.pattern : 'selector' in r.check ? r.check.selector : ''}`;
    summary[key] = r.passed;
  }
  return summary;
}
