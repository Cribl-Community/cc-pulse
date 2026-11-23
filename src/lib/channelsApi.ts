import { api, items } from './api';
import { targetBody, validChannel, TEST_CRON, testStopAt, disabledSaved, compareMetrics, type ChannelForm, type Preset, type TestMetrics } from './channels';

const SEARCH = '/m/default_search';
const TEST_ID = 'pulse_notify_test';
const POLL_MS = 10_000;
// Edits apply to saved searches and notifications only (granted under /m/default_search), never to a notification target.
const SAVED_EDIT = 'PATCH';

async function upsert(path: string, id: string, body: object): Promise<void> {
  const exists = items<{ id: string }>(await api(`${SEARCH}${path}`)).some((x) => x.id === id);
  await api(`${SEARCH}${path}${exists ? `/${id}` : ''}`, { method: exists ? SAVED_EDIT : 'POST', json: body });
}

const metricsOf = async (id: string): Promise<TestMetrics> => {
  const r = items<{ status?: { metrics?: TestMetrics } }>(await api(`/notification-targets/${id}`))[0];
  return r?.status?.metrics ?? {};
};

/** D5: one-shot scheduled search + notification to the target, then watch the target's metrics for up to 3 minutes. */
export async function sendTest(targetId: string): Promise<{ state: 'sent' } | { state: 'failed'; errors: number } | { state: 'no-answer' }> {
  const start = await metricsOf(targetId);
  await upsert('/search/saved', TEST_ID, { id: TEST_ID, name: TEST_ID, description: 'Pulse test notification (one-shot)', isPrivate: false,
    query: 'print kind="test", text="Pulse test notification"', earliest: '-5m', latest: 'now', sampleRate: 1,
    schedule: { enabled: true, cronSchedule: TEST_CRON, tz: 'UTC', keepLastN: 5, emptyNotifications: {}, emptyAdvanced: {} } });
  await upsert('/notifications', `${TEST_ID}_notification`, { id: `${TEST_ID}_notification`, disabled: false, condition: 'search', group: 'default_search',
    targets: [targetId], metadata: [], targetConfigs: [{ id: targetId, conf: {} }],
    conf: { triggerType: 'resultsCount', triggerComparator: '>', triggerCount: 0, savedQueryId: TEST_ID, message: 'Pulse test notification' } });
  const t0 = Date.now();
  const stopAt = testStopAt(t0);
  let stopped = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!stopped && Date.now() >= stopAt) { await stopTest().catch(() => undefined); stopped = true; } // one run only
    const elapsed = Date.now() - t0;
    const res = compareMetrics(start, await metricsOf(targetId).catch(() => start), elapsed);
    if (res.state !== 'waiting') return res;
  }
}

/** Disables the test schedule (on the saved search, never on a target). */
export async function stopTest(): Promise<void> {
  const cur = items<{ schedule?: object; status?: unknown }>(await api(`${SEARCH}/search/saved/${TEST_ID}`))[0];
  if (!cur) return;
  await api(`${SEARCH}/search/saved/${TEST_ID}`, { method: SAVED_EDIT, json: disabledSaved(cur) });
}

export const listTargets = async () => items<{ id: string; type: string }>(await api('/notification-targets'));

/** Creates one notification target: a single POST, never an edit or removal of an existing one (D2: create only).
 *  Throws the validation message, without any request, when the form is not valid. The secret is never stored or logged. */
export async function createTarget(preset: Preset, form: ChannelForm, existingIds: string[] = []): Promise<void> {
  const bad = validChannel(preset, form, existingIds);
  if (bad) throw new Error(bad);
  await api('/notification-targets', { method: 'POST', json: targetBody(preset, form) });
}
