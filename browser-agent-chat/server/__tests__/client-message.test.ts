import { describe, expect, it } from 'vitest';
import { isClientMessage } from '../src/types.js';

describe('isClientMessage', () => {
  it.each([
    { type: 'ping' },
    { type: 'start', agentId: 'agent-1' },
    { type: 'start', agentId: 'agent-1', resumeUrl: 'https://example.com' },
    { type: 'restart', agentId: 'agent-1' },
    { type: 'task', content: 'Check the page' },
    { type: 'explore', agentId: 'agent-1' },
    { type: 'taskFeedback', task_id: 'task-1', rating: 'positive' },
    { type: 'taskFeedback', task_id: 'task-1', rating: 'negative', correction: 'Try again' },
    { type: 'credential_provided', credentialId: 'credential-1' },
  ])('accepts valid message $type', message => {
    expect(isClientMessage(message)).toBe(true);
  });

  it.each([
    null,
    [],
    'message',
    {},
    { type: 'unknown' },
    { type: 'ping', unexpected: true },
    { type: 'start', agentId: 1 },
    { type: 'task', content: null },
    { type: 'taskFeedback', task_id: 'task-1', rating: 'neutral' },
    { type: 'credential_provided' },
  ])('rejects malformed message %#', message => {
    expect(isClientMessage(message)).toBe(false);
  });
});
