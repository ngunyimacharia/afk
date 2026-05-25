import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NotificationPayload } from '../src/notification-policy.js';
import { OpenTUINotificationAdapter } from '../src/opentui-notification-adapter.js';

function fakeRenderer(
  capabilities: { notifications?: boolean },
  notifyImpl?: (title: string, message: string) => void | Promise<void>,
): {
  capabilities: { notifications?: boolean };
  notify?: (title: string, message: string) => void | Promise<void>;
  calls: Array<{ title: string; message: string }>;
} {
  const calls: Array<{ title: string; message: string }> = [];
  return {
    capabilities,
    notify: notifyImpl
      ? (title: string, message: string) => {
          calls.push({ title, message });
          return notifyImpl(title, message);
        }
      : undefined,
    calls,
  };
}

function samplePayload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    title: 'Permission required: feat/001',
    message: 'bash tool requested',
    category: 'permission-required',
    ...overrides,
  };
}

test('supported renderer triggers notification and returns sent', async () => {
  const renderer = fakeRenderer({ notifications: true }, () => undefined);
  const adapter = new OpenTUINotificationAdapter(renderer);

  const state = await adapter.maybeNotify(samplePayload());

  assert.equal(state, 'sent');
  assert.equal(renderer.calls.length, 1);
  assert.equal(renderer.calls[0]?.title, 'Permission required: feat/001');
  assert.equal(renderer.calls[0]?.message, 'bash tool requested');
});

test('unsupported renderer returns unsupported without calling notify', async () => {
  const renderer = fakeRenderer({ notifications: false });
  const adapter = new OpenTUINotificationAdapter(renderer);

  const state = await adapter.maybeNotify(samplePayload());

  assert.equal(state, 'unsupported');
  assert.equal(renderer.calls.length, 0);
});

test('missing notifications capability returns unsupported', async () => {
  const renderer = fakeRenderer({});
  const adapter = new OpenTUINotificationAdapter(renderer);

  const state = await adapter.maybeNotify(samplePayload());

  assert.equal(state, 'unsupported');
});

test('renderer with capabilities but no notify method returns unsupported', async () => {
  const renderer = { capabilities: { notifications: true } };
  const adapter = new OpenTUINotificationAdapter(renderer);

  const state = await adapter.maybeNotify(samplePayload());

  assert.equal(state, 'unsupported');
});

test('throwing renderer returns failed and does not propagate error', async () => {
  const renderer = fakeRenderer({ notifications: true }, () => {
    throw new Error('terminal notification failed');
  });
  const adapter = new OpenTUINotificationAdapter(renderer);

  const state = await adapter.maybeNotify(samplePayload());

  assert.equal(state, 'failed');
  assert.equal(renderer.calls.length, 1);
});

test('async throwing renderer returns failed and does not propagate error', async () => {
  const renderer = fakeRenderer({ notifications: true }, async () => {
    throw new Error('async terminal notification failed');
  });
  const adapter = new OpenTUINotificationAdapter(renderer);

  const state = await adapter.maybeNotify(samplePayload());

  assert.equal(state, 'failed');
  assert.equal(renderer.calls.length, 1);
});

test('null payload returns skipped without calling renderer', async () => {
  const renderer = fakeRenderer({ notifications: true }, () => undefined);
  const adapter = new OpenTUINotificationAdapter(renderer);

  const state = await adapter.maybeNotify(null);

  assert.equal(state, 'skipped');
  assert.equal(renderer.calls.length, 0);
});

test('async supported renderer awaits notification and returns sent', async () => {
  const renderer = fakeRenderer({ notifications: true }, async () => {
    await Promise.resolve();
  });
  const adapter = new OpenTUINotificationAdapter(renderer);

  const state = await adapter.maybeNotify(samplePayload());

  assert.equal(state, 'sent');
  assert.equal(renderer.calls.length, 1);
});
