import { test } from 'node:test';
import assert from 'node:assert/strict';

// Real modules load through the host's resolved packages (node_modules junction).
const { apply, inject, name } = await import('../lib/index.js');

// Minimal ctx whose tools.register captures registrations; validateArgs is
// exercised by the harness, so we only assert the descriptor shape here.
function harnessCtx() {
  const registered = [];
  const sink = [];
  const agent = {
    id: 'A',
    status: 'idle',
    followup: (m) => sink.push(m),
    steer: (m) => sink.push(m),
    inject: (m) => sink.push(m),
  };
  const peer = {
    id: 'B',
    status: 'idle',
    followup: (m) => sink.push(m),
    steer: (m) => sink.push(m),
    inject: (m) => sink.push(m),
  };
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    agents: {
      list: () => [agent, peer],
      get: (id_) => (String(id_) === 'B' ? peer : String(id_) === 'A' ? agent : undefined),
      resume: async () => ({ agent: peer, dispose: async () => {} }),
    },
    sessionQuery: {
      async listSessions() {
        return [
          { header: { id: 'A', createdAt: 1 }, live: true, persisted: true },
          { header: { id: 'B', createdAt: 2 }, live: true, persisted: true },
          { header: { id: 'C', createdAt: 3, origin: 'subagent' }, live: false, persisted: true },
          { header: { id: 'D', createdAt: 4 }, live: false, persisted: true },
        ];
      },
      async readSession(id_) {
        return { session: { id: id_, createdAt: 1 } };
      },
      async readTitleSnapshots(ids) {
        return ids.map((id) => ({
          sessionId: id,
          status: 'fulfilled',
          value: id === 'B' ? { title: { title: '接收方会话' } } : {},
        }));
      },      async observeSession() {
        return { events: [], inheritedEventCount: 0, dispose() {} };
      },
    },
    workspaceRegistry: { archivedSessionIds: ['D'] },
    sessionProjections: { stateOf: () => null },
    effect: () => {},
  };
  return { ctx, registered, sink };
}

test('module contract: name + inject + apply exported', () => {
  assert.equal(name, 'dsh-peer-messenger');
  assert.ok(Array.isArray(inject));
  for (const need of ['tools', 'agents', 'sessionQuery', 'workspaceRegistry']) {
    assert.ok(inject.includes(need), `inject must include ${need}`);
  }
  assert.equal(typeof apply, 'function');
});

test('apply registers exactly the three tools with schemas', () => {
  const { ctx, registered } = harnessCtx();
  apply(ctx);
  const names = registered.map((t) => t.name).sort();
  assert.deepEqual(names, ['check_delivery', 'list_peer_agents', 'send_agent_message']);
  for (const tool of registered) {
    assert.equal(typeof tool.execute, 'function');
    assert.ok(tool.description.length > 20);
    assert.ok(tool.output?.schema && tool.output.schema.type === 'object');
  }
});

test('list_peer_agents excludes self, subagents, archived', async () => {
  const { ctx, registered } = harnessCtx();
  apply(ctx);
  const list = registered.find((t) => t.name === 'list_peer_agents');
  const out = await list.execute({}, { agent: { id: 'A' }, signal: undefined });
  const ids = out.peers.map((p) => p.sessionId);
  assert.ok(ids.includes('B'), 'B should be listed');
  assert.ok(!ids.includes('A'), 'self excluded');
  assert.ok(!ids.includes('C'), 'subagent excluded');
  assert.ok(!ids.includes('D'), 'archived excluded');
  assert.equal(out.peers.find((p) => p.sessionId === 'B').status, 'idle');
});

test('send_agent_message delivers followup and returns a messageId', async () => {
  const { ctx, registered, sink } = harnessCtx();
  apply(ctx);
  const send = registered.find((t) => t.name === 'send_agent_message');
  const out = await send.execute(
    { target_session_id: 'B', message: 'hello' },
    { agent: { id: 'A' }, signal: undefined },
  );
  assert.equal(out.accepted, true);
  assert.equal(typeof out.messageId, 'string');
  assert.equal(sink.length, 1);
  assert.equal(sink[0].source.senderSessionId, 'A');
  assert.ok(sink[0].content[0].text.includes('hello'));
});

test('the send receipt states what was sent and where it went', async () => {
  const { ctx, registered } = harnessCtx();
  apply(ctx);
  const send = registered.find((t) => t.name === 'send_agent_message');
  const args = { target_session_id: 'B', message: '第一行\n第二行' };
  const out = await send.execute(args, { agent: { id: 'A' }, signal: undefined });
  const text = send.output.render(args, out)[0].text;
  assert.match(text, /已投递（followup）至 《接收方会话》（B）/);
  assert.match(text, /消息内容：第一行…（另有 1 行，共 7 字符）/);
  assert.ok(text.includes(out.messageId));
});

test('the delivered message names the receiver session and the mode', async () => {
  const { ctx, registered, sink } = harnessCtx();
  apply(ctx);
  const send = registered.find((t) => t.name === 'send_agent_message');
  await send.execute(
    { target_session_id: 'B', message: 'hello' },
    { agent: { id: 'A' }, signal: undefined },
  );
  const [first, second] = sink[0].content[0].text.split('\n');
  assert.match(first, /投递至《接收方会话》（B）/);
  assert.match(second, /投递方式 下一轮/);
});

test('send_agent_message to self rejects', async () => {
  const { ctx, registered } = harnessCtx();
  apply(ctx);
  const send = registered.find((t) => t.name === 'send_agent_message');
  await assert.rejects(
    () => send.execute({ target_session_id: 'A', message: 'x' }, { agent: { id: 'A' } }),
    /self_message/,
  );
});

test('check_delivery on unknown message rejects', async () => {
  const { ctx, registered } = harnessCtx();
  apply(ctx);
  const send = registered.find((t) => t.name === 'send_agent_message');
  const check = registered.find((t) => t.name === 'check_delivery');
  // Untracked id → ownership error.
  await assert.rejects(
    () => check.execute({ message_id: 'nope' }, { agent: { id: 'A' } }),
    /message_not_owned_by_sender/,
  );
  // A tracked id still resolves through the fold.
  const { messageId } = await send.execute(
    { target_session_id: 'B', message: 'x' },
    { agent: { id: 'A' } },
  );
  const r = await check.execute({ message_id: messageId }, { agent: { id: 'A' } });
  assert.ok(['pending', 'claimed', 'processed', 'unknown'].includes(r.status));
});
