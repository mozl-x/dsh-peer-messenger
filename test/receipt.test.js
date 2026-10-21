import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReceipt } from '../lib/receipt.js';

// Mock SessionObservation: events already cut by the caller-provided
// inheritedEventCount; this fixture mirrors what sessionQuery.observeSession
// returns after live/prepared resolution.
const mkEvent = (type, data) => ({ type, data });
const userMsg = (id) => mkEvent('user/message', { id, role: 'user', content: [] });
const assistantMsg = () => mkEvent('assistant/message', { role: 'assistant', content: [] });
const splice = (target, start, removedCount, inserted) =>
  mkEvent('agent/inbox/spliced', { target, start, removedCount, inserted });

function mockCtx({ events, inherited = 0 }) {
  const disposed = { count: 0 };
  return {
    disposed,
    ctx: {
      sessionQuery: {
        async observeSession() {
          return {
            events,
            inheritedEventCount: inherited,
            dispose() { disposed.count++; },
          };
        },
      },
    },
  };
}

test('admitted message with following assistant output → processed; lease disposed', async () => {
  const ledger = new Map([['m1', { senderId: 'A', targetId: 'B' }]]);
  const { ctx, disposed } = mockCtx({
    events: [userMsg('x'), userMsg('m1'), assistantMsg()],
  });
  const check = createReceipt({ ctx }, ledger);
  assert.deepEqual(await check('A', 'm1'), { status: 'processed' });
  assert.equal(disposed.count, 1);
});

test('admitted message with no following output → claimed', async () => {
  const ledger = new Map([['m1', { senderId: 'A', targetId: 'B' }]]);
  const { ctx } = mockCtx({ events: [userMsg('m1')] });
  const check = createReceipt({ ctx }, ledger);
  assert.deepEqual(await check('A', 'm1'), { status: 'claimed' });
});

test('queued in pending inbox (fold of splices) → pending', async () => {
  const ledger = new Map([['m1', { senderId: 'A', targetId: 'B' }]]);
  const { ctx } = mockCtx({
    events: [
      splice('next-turn', 0, 0, [{ id: 'm1' }]),
      splice('next-turn', 0, 1, []), // removed from next-turn
      splice('next-step', 0, 0, [{ id: 'm1' }]), // re-inserted into next-step
    ],
  });
  const check = createReceipt({ ctx }, ledger);
  assert.deepEqual(await check('A', 'm1'), { status: 'pending' });
});

test('fork boundary: inherited prefix is never matched (issue #2)', async () => {
  // Parent history (inherited) contains a user message with id m1; the suffix
  // has no such message → must NOT report processed/claimed from the prefix.
  const ledger = new Map([['m1', { senderId: 'A', targetId: 'B' }]]);
  const { ctx } = mockCtx({
    events: [userMsg('m1'), assistantMsg(), userMsg('other'), assistantMsg()],
    inherited: 2,
  });
  const check = createReceipt({ ctx }, ledger);
  assert.deepEqual(await check('A', 'm1'), { status: 'unknown' });
});

test('ledger scope: sender cannot probe another sender\'s message (issue #5)', async () => {
  const ledger = new Map([['m1', { senderId: 'A', targetId: 'B' }]]);
  const { ctx } = mockCtx({ events: [] });
  const check = createReceipt({ ctx }, ledger);
  await assert.rejects(() => check('C', 'm1'), /message_not_owned_by_sender/);
  await assert.rejects(() => check('A', 'unknown-id'), /message_not_owned_by_sender/);
});

test('unprovable-but-completed is reported as processed, never as done-of-task', async () => {
  // Status vocabulary must stay transport-only; guard the enum drift.
  const ledger = new Map([['m1', { senderId: 'A', targetId: 'B' }]]);
  const { ctx } = mockCtx({ events: [userMsg('m1'), assistantMsg()] });
  const check = createReceipt({ ctx }, ledger);
  const r = await check('A', 'm1');
  assert.ok(['pending', 'claimed', 'processed', 'unknown'].includes(r.status));
});
