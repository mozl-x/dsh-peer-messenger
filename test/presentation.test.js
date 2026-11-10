// Presentation helpers: titles, receipt summary, sender/target labelling and
// the receiver header line. These are the only carriers of delivery metadata:
// the relay source is a closed durable record and cannot carry extra keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODE_LABELS,
  formatSentAt,
  readSessionTitles,
  relayHeader,
  sessionLabel,
  summarizeMessage,
} from '../lib/presentation.js';

function mockCtx(titles) {
  return {
    sessionQuery: {
      async readTitleSnapshots(ids) {
        return ids.map((id) => ({
          sessionId: id,
          status: 'fulfilled',
          value: { title: titles[id] === undefined ? undefined : { title: titles[id] } },
        }));
      },
    },
  };
}

test('readSessionTitles resolves titles and tolerates missing ones', async () => {
  const ctx = mockCtx({ A: '发送方会话', B: '接收方会话' });
  const titles = await readSessionTitles(ctx, ['A', 'B', 'C']);
  assert.equal(titles.get('A'), '发送方会话');
  assert.equal(titles.get('B'), '接收方会话');
  assert.equal(titles.get('C'), null, 'a session without a title resolves to null');
});

test('readSessionTitles reports a failed observation as no title', async () => {
  const ctx = {
    sessionQuery: {
      async readTitleSnapshots(ids) {
        return ids.map((id) => ({ sessionId: id, status: 'rejected', reason: new Error('x') }));
      },
    },
  };
  const titles = await readSessionTitles(ctx, ['A']);
  assert.equal(titles.get('A'), null);
});

test('readSessionTitles dedupes ids and skips an empty request', async () => {
  let called = 0;
  const ctx = {
    sessionQuery: {
      async readTitleSnapshots(ids) {
        called++;
        return ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: {} }));
      },
    },
  };
  assert.equal((await readSessionTitles(ctx, [])).size, 0);
  assert.equal(called, 0, 'an empty request never reads');
  await readSessionTitles(ctx, ['A', 'A']);
  assert.equal(called, 1);
});

test('summarizeMessage quotes the first line and counts the rest', () => {
  assert.equal(summarizeMessage('hello'), 'hello');
  assert.match(summarizeMessage('a\nb\nc'), /a…（另有 2 行，共 5 字符）/);
  const truncated = summarizeMessage('x'.repeat(200));
  assert.equal(truncated.length, 121, 'the quoted first line is capped at 120 chars plus the ellipsis');
  assert.ok(truncated.endsWith('…'));
});

test('sessionLabel names a titled session with its id and an untitled one without', () => {
  assert.equal(sessionLabel('B', '标题'), '《标题》（B）');
  assert.equal(sessionLabel('B', null), '会话 B');
});

test('relayHeader states sender, target, mode and send time', () => {
  const header = relayHeader({
    senderSessionId: 'A',
    senderTitle: '发送方',
    targetSessionId: 'B',
    targetTitle: '接收方',
    mode: 'steer',
    sentAt: '2026-11-10 12:00:00',
  });
  assert.match(header, /来自《发送方》（A）/);
  assert.match(header, /投递至《接收方》（B）/);
  assert.match(header, new RegExp(`投递方式 ${MODE_LABELS.steer}`));
  assert.match(header, /发送时间 2026-11-10 12:00:00/);
});

test('relayHeader falls back to raw ids when titles are missing', () => {
  const header = relayHeader({
    senderSessionId: 'A',
    senderTitle: null,
    targetSessionId: 'B',
    targetTitle: null,
    mode: 'followup',
    sentAt: '2026-11-10 12:00:00',
  });
  assert.match(header, /来自会话 A/);
  assert.match(header, /投递至会话 B/);
});

test('formatSentAt renders a zero-padded local timestamp', () => {
  const stamp = formatSentAt(new Date(2026, 0, 2, 3, 4, 5));
  assert.equal(stamp, '2026-01-02 03:04:05');
});
