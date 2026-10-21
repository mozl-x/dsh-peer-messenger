import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBudget } from '../lib/admission.js';
import { createDelivery } from '../lib/delivery.js';

const id = (s) => ({ id: s });

// Minimal live-agent stand-in mirroring ReactLoopAgent's surface we touch.
function mockAgent(id_, status, sink) {
  return {
    id: id_,
    status,
    followup: (m) => sink.push(['followup', m]),
    steer: (m) => sink.push(['steer', m]),
    inject: (m) => sink.push(['inject', m]),
  };
}

function mockCtx({ target = 'B', origin, archived = [], agent, resumeAgent }) {
  const liveAgents = agent ? [agent] : [];
  return {
    agents: {
      list: () => liveAgents,
      get: (id_) => (id_ === String(agent?.id ?? target) ? agent : undefined),
      resume: async () => ({
        agent: resumeAgent,
        dispose: async () => {},
      }),
    },
    sessionQuery: {
      // Echo the requested target id so eligibility sees the real destination.
      async readSession(requested) {
        return { session: { id: requested ?? target, origin, createdAt: 1 } };
      },
    },
    // ArchivedSessionIds is a readonly SessionId[] (branded strings at runtime).
    workspaceRegistry: { archivedSessionIds: archived.slice() },
    sessionProjections: { stateOf: () => null },
    // Real cordis Context always provides effect; tests only need it to accept
    // the handle-cache disposer without running teardown.
    effect: () => {},
  };
}

function wire(over = {}) {
  const sink = [];
  const ctx = mockCtx({ agent: mockAgent('B', over.status ?? 'idle', sink), ...over });
  const ledger = new Map();
  const budget = createBudget();
  const deliver = createDelivery({ ctx, budget, ledger });
  return { ctx, sink, ledger, budget, deliver };
}

test('followup to idle live target delivers + writes ledger', async () => {
  const { sink, ledger, deliver } = wire();
  const r = await deliver('A', 'B', 'hi', 'followup');
  assert.equal(r.accepted, true);
  assert.equal(r.targetStatus, 'idle');
  assert.equal(sink[0][0], 'followup');
  assert.equal(sink[0][1].source.kind, 'agent-message');
  assert.equal(sink[0][1].source.form, 'relay');
  assert.equal(sink[0][1].source.senderSessionId, 'A');
  assert.equal(ledger.get(String(r.messageId)).senderId, 'A');
  assert.equal(ledger.get(String(r.messageId)).targetId, 'B');
});

test('self-send rejected before budget/inbox', async () => {
  const { budget, deliver } = wire();
  await assert.rejects(() => deliver('A', 'A', 'x', 'followup'), /self_message/);
});

test('archived target rejected', async () => {
  const { deliver } = wire({ archived: ['B'] });
  await assert.rejects(() => deliver('A', 'B', 'x', 'followup'), /target_archived/);
});

test('subagent-origin target rejected', async () => {
  const { deliver } = wire({ origin: 'subagent' });
  await assert.rejects(() => deliver('A', 'B', 'x', 'followup'), /subagent_not_peer/);
});

test('steer requires running target', async () => {
  const { deliver } = wire({ status: 'idle' });
  await assert.rejects(() => deliver('A', 'B', 'x', 'steer'), /steer_requires_running_target/);
});

test('inject requires running target', async () => {
  const { deliver } = wire({ status: 'idle' });
  await assert.rejects(() => deliver('A', 'B', 'x', 'inject'), /inject_requires_running_target/);
});

test('running target accepts steer', async () => {
  const { sink, deliver } = wire({ status: 'running' });
  await deliver('A', 'B', 'x', 'steer');
  assert.equal(sink[0][0], 'steer');
});

test('budget slot is released when delivery fails after reserve', async () => {
  const { budget, deliver } = wire({ origin: 'subagent' });
  await assert.rejects(() => deliver('A', 'B', 'x', 'followup'));
  // All 10 pair slots must still be available (nothing consumed).
  let ok = 0;
  for (let i = 0; i < 10; i++) if (budget.reserve('A', 'B').ok) ok++;
  assert.equal(ok, 10);
});

test('offline target is resumed and delivered', async () => {
  const sink = [];
  const ctx = mockCtx({
    agent: undefined,
    resumeAgent: mockAgent('B', 'idle', sink),
  });
  const ledger = new Map();
  const deliver = createDelivery({ ctx, budget: createBudget(), ledger });
  const r = await deliver('A', 'B', 'x', 'followup');
  assert.equal(r.accepted, true);
  assert.equal(sink[0][0], 'followup');
});

test('message over size limit fails and releases the slot', async () => {
  const { budget, deliver } = wire();
  const big = 'x'.repeat(70 * 1024);
  await assert.rejects(() => deliver('A', 'B', big, 'followup'), /exceeds/);
  let ok = 0;
  for (let i = 0; i < 10; i++) if (budget.reserve('A', 'B').ok) ok++;
  assert.equal(ok, 10);
});
