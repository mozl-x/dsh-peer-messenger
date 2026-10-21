import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTarget, createBudget } from '../lib/admission.js';

const id = (s) => ({ id: s });
const rec = (id_, extra = {}) => ({ header: { id: id_, ...extra } });

test('self is rejected', () => {
  assert.equal(checkTarget(rec('A'), { archivedSet: new Set() }, 'A').reason, 'self_message');
});

test('subagent origin is rejected; ordinary fork (parentSession) is allowed', () => {
  assert.equal(
    checkTarget(rec('B', { origin: 'subagent' }), { archivedSet: new Set() }, 'A').reason,
    'subagent_not_peer',
  );
  assert.equal(checkTarget(rec('B', { parentSession: 'A' }), { archivedSet: new Set() }, 'A').ok, true);
});

test('archived is rejected', () => {
  const archived = new Set(['B']);
  assert.equal(checkTarget(rec('B'), { archivedSet: archived }, 'A').reason, 'target_archived');
});

test('missing target is rejected', () => {
  assert.equal(checkTarget(undefined, { archivedSet: new Set() }, 'A').reason, 'target_not_found');
});

test('pair budget caps at 10 per 60s window, direction-insensitive', () => {
  const b = createBudget();
  let ok = 0;
  for (let i = 0; i < 12; i++) {
    const r = b.reserve('A', 'B');
    if (r.ok) ok++;
    else assert.equal(r.reason, 'pair_rate_limited');
  }
  assert.equal(ok, 10);
  // Unordered pair: A->B and B->A share the budget, so it is already exhausted.
  assert.equal(b.reserve('B', 'A').ok, false);
});

test('reserve then release frees exactly one slot', () => {
  const b = createBudget();
  const toks = [];
  for (let i = 0; i < 10; i++) toks.push(b.reserve('A', 'B').token);
  assert.equal(b.reserve('A', 'B').ok, false);
  b.release(toks[0]);
  assert.equal(b.reserve('A', 'B').ok, true);
});

test('sender fan-out caps independently across targets after pair cap', () => {
  const b = createBudget();
  // 20 distinct targets, under the per-pair cap of 10 each.
  let ok = 0;
  for (let t = 0; t < 25; t++) {
    const r = b.reserve('S', `T${t}`);
    if (r.ok) ok++;
    else assert.equal(r.reason, 'sender_rate_limited');
  }
  assert.equal(ok, 20);
});
