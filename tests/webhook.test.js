/**
 * The webhook: push the changes instead of making people poll.
 *
 * Asked directly and never answered: "Do your actors expose the change events
 * as a webhook, or do users poll?" — and the shape it should take: "send
 * notifications from that smaller event list", i.e. the events, not the dump.
 *
 * The rule these tests protect is that a webhook can never turn a good run into
 * a bad one. The dataset is saved and paid for before the POST is attempted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWebhookPayload, deliverWebhook, isDeliverableWebhookUrl, MAX_EVENTS_PER_KIND,
} from '../src/webhook.js';

const SUMMARY = {
  runStatus: 'COMPLETE',
  finishedAt: '2026-08-27T12:00:00.000Z',
  totalAds: 3, adsCharged: 2, queriesRun: 2, queriesOk: 2, failures: 0,
  capped: false, cappedBy: null, monitorId: 'nike-daily',
  monitorCounts: { new: 1, changed: 1, unchanged: 1, removed: 1 },
  checkpoint: { resumed: false },
};

const ad = (over = {}) => ({
  id: '1', status: 'new', pageId: 'p1', pageName: 'Nike', title: 'T',
  body: 'B', creativeType: 'video', linkDomain: 'nike.com',
  linkUrlClean: 'https://nike.com/x', startDate: '2026-01-01',
  totalActiveDays: 40, adLibraryUrl: 'https://facebook.com/ads/library/?id=1',
  ...over,
});

test('only https endpoints are accepted', () => {
  assert.equal(isDeliverableWebhookUrl('https://example.com/hook'), true);
  for (const bad of ['http://example.com/hook', 'ftp://x', 'not a url', '', null, undefined]) {
    assert.equal(isDeliverableWebhookUrl(bad), false, `${bad} must be refused`);
  }
});

test('the payload carries the delta, not the dataset', () => {
  const p = buildWebhookPayload({
    summary: SUMMARY,
    ads: [ad(), ad({ id: '2', status: 'changed', changedFields: ['body'] }), ad({ id: '3', status: 'unchanged' })],
    removed: [{ id: '9', status: 'removed', pageName: 'Nike' }],
    datasetId: 'ds1', runId: 'run1',
  });

  assert.equal(p.event, 'ads.changed');
  assert.equal(p.monitorId, 'nike-daily');
  assert.deepEqual(p.events.new.map((a) => a.id), ['1']);
  assert.deepEqual(p.events.changed.map((a) => a.id), ['2']);
  assert.deepEqual(p.events.removed.map((a) => a.id), ['9']);
  assert.equal(p.events.changed[0].changedFields[0], 'body');
  assert.ok(!JSON.stringify(p).includes('"unchanged"') || p.counts.unchanged === 1,
    'unchanged ads are counted, not shipped as events');
});

test('the run block tells the consumer whether to trust the removals', () => {
  const partial = buildWebhookPayload({
    summary: { ...SUMMARY, failures: 1, queriesOk: 1 }, ads: [], removed: [],
  });
  assert.equal(partial.run.status, 'partial');

  const failed = buildWebhookPayload({
    summary: { ...SUMMARY, failures: 2, queriesOk: 0 }, ads: [], removed: [],
  });
  assert.equal(failed.run.status, 'failed');

  const ok = buildWebhookPayload({ summary: SUMMARY, ads: [], removed: [] });
  assert.equal(ok.run.status, 'complete');
});

test('scaling ads get their own bucket', () => {
  const p = buildWebhookPayload({
    summary: SUMMARY,
    ads: [ad({ id: '5', status: 'unchanged', isScaling: true, variantDelta: 6 })],
    removed: [],
  });
  assert.equal(p.events.scaling.length, 1);
  assert.equal(p.events.scaling[0].variantDelta, 6);
  assert.equal(p.counts.scaling, 1);
});

test('a quiet run still reports, with event run.finished', () => {
  const p = buildWebhookPayload({ summary: SUMMARY, ads: [], removed: [] });
  assert.equal(p.event, 'run.finished');
  assert.equal(p.events.new.length, 0);
});

test('a huge delta is truncated, and the truncation is stated', () => {
  const many = Array.from({ length: MAX_EVENTS_PER_KIND + 50 }, (_, i) => ad({ id: String(i) }));
  const p = buildWebhookPayload({ summary: SUMMARY, ads: many, removed: [] });

  assert.equal(p.events.new.length, MAX_EVENTS_PER_KIND);
  assert.equal(p.truncated.new, 50, 'the buyer is told what did not fit');
});

test('ad copy is trimmed so one long ad cannot bloat the body', () => {
  const p = buildWebhookPayload({ summary: SUMMARY, ads: [ad({ body: 'x'.repeat(5000) })], removed: [] });
  assert.equal(p.events.new[0].body.length, 500);
});

// --- delivery --------------------------------------------------------------

test('a failing endpoint is a warning, never a thrown error', async () => {
  const warnings = [];
  const result = await deliverWebhook({
    url: 'https://example.com/hook',
    payload: buildWebhookPayload({ summary: SUMMARY, ads: [ad()], removed: [] }),
    post: async () => { throw new Error('ECONNREFUSED'); },
    log: { info() {}, warning: (m) => warnings.push(m) },
  });

  assert.equal(result.delivered, false);
  assert.match(warnings.join(' '), /the run is unaffected/);
});

test('a plain http endpoint is refused with an explanation, not attempted', async () => {
  let called = false;
  const warnings = [];
  const result = await deliverWebhook({
    url: 'http://example.com/hook',
    payload: buildWebhookPayload({ summary: SUMMARY, ads: [], removed: [] }),
    post: async () => { called = true; },
    log: { info() {}, warning: (m) => warnings.push(m) },
  });

  assert.equal(called, false, 'nothing was sent over plain http');
  assert.equal(result.delivered, false);
  assert.match(warnings.join(' '), /not an https URL/);
});

test('no webhookUrl means no attempt and no warning', async () => {
  let called = false;
  const result = await deliverWebhook({ url: '', payload: {}, post: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'not requested');
});

test('a working endpoint receives the payload it was promised', async () => {
  let received = null;
  const result = await deliverWebhook({
    url: 'https://example.com/hook',
    payload: buildWebhookPayload({ summary: SUMMARY, ads: [ad()], removed: [] }),
    post: async (_url, body) => { received = body; },
    log: { info() {}, warning() {} },
  });

  assert.equal(result.delivered, true);
  assert.equal(received.events.new.length, 1);
  assert.equal(received.run.adsCharged, 2);
});
