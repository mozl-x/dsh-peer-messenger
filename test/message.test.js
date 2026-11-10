// Message construction: the relay source stays the closed native record, and
// the delivery metadata travels in the message's first line — the only place
// the receiving transcript renders besides the source itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRelayMessage, MAX_MESSAGE_BYTES } from '../lib/message.js';

const meta = {
  senderSessionId: 'A',
  senderTitle: '发送方',
  targetSessionId: 'B',
  targetTitle: '接收方',
  mode: 'followup',
  text: '请处理这件事',
  sentAt: '2026-11-10 12:00:00',
};

test('relay source keeps exactly the three native keys', () => {
  const { message } = buildRelayMessage(meta);
  assert.deepEqual(Object.keys(message.source).sort(), ['form', 'kind', 'senderSessionId']);
  assert.equal(message.source.kind, 'agent-message');
  assert.equal(message.source.form, 'relay');
  assert.equal(message.source.senderSessionId, 'A');
});

test('the first line names sender, target, mode and send time', () => {
  const { message } = buildRelayMessage(meta);
  const [first, second, body] = message.content[0].text.split('\n');
  assert.match(first, /来自《发送方》（A）/);
  assert.match(first, /投递至《接收方》（B）/);
  assert.match(second, /投递方式 下一轮/);
  assert.match(second, /发送时间 2026-11-10 12:00:00/);
  assert.equal(body, '请处理这件事');
});

test('the body itself is preserved verbatim', () => {
  const { message } = buildRelayMessage(meta);
  assert.ok(message.content[0].text.endsWith('\n请处理这件事'));
});

test('a body over the size limit is rejected', () => {
  const big = 'x'.repeat(MAX_MESSAGE_BYTES + 1);
  assert.throws(() => buildRelayMessage({ ...meta, text: big }), /exceeds/);
});
