// Admission: pure target eligibility checks + an in-process rolling delivery
// budget (pair + sender, cross-restart not required for a process-local fuse).
// No whitelist / allowedPairs — the goal is any-to-any send; runaway loops are
// bounded by the budget, not by an approval gate (documented design stance).

/** Pair window: at most PAIR_MAX successes per PAIR_WINDOW_MS per unordered pair. */
const PAIR_WINDOW_MS = 60_000;
const PAIR_MAX = 10;
/** Sender fan-out window: at most SENDER_MAX successes per window across targets. */
const SENDER_WINDOW_MS = 60_000;
const SENDER_MAX = 20;

/**
 * Decide whether a peer session is eligible to receive a cross-session message.
 * @param {object} record - a SessionRecord (or observation header) to classify.
 * @param {object} facts - { archivedSet:Set<string> }.
 * @param {string} selfId - caller's session id.
 * @returns {{ ok: boolean, reason?: string }} eligibility with a stable reason code.
 */
export function checkTarget(record, facts, selfId) {
  const header = record?.header;
  if (!header) return { ok: false, reason: 'target_not_found' };
  const id = String(header.id);
  if (id === String(selfId)) return { ok: false, reason: 'self_message' };
  // Real subagents are owned by a parent's delegation; ordinary forks have only
  // parentSession and stay independent — do not misclassify forks.
  if (header.origin === 'subagent') return { ok: false, reason: 'subagent_not_peer' };
  if (facts.archivedSet?.has(id)) return { ok: false, reason: 'target_archived' };
  return { ok: true };
}

/**
 * Rolling-window budget. reserve() must be paired with release() on failure or a
 * commit on success; nothing escapes.
 */
export function createBudget() {
  const pair = new Map(); // unordered pair key -> number[] timestamps
  const sender = new Map(); // senderId -> number[] timestamps

  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  function prune(map, key, window, now) {
    const arr = map.get(key);
    if (!arr) return [];
    const kept = arr.filter((t) => now - t < window);
    if (kept.length) map.set(key, kept);
    else map.delete(key);
    return kept;
  }

  return {
    /**
     * @returns {{ ok: true, token: object } | { ok: false, reason: string }}
     */
    reserve(senderId, targetId) {
      const now = Date.now();
      const pk = pairKey(senderId, targetId);
      const pairs = prune(pair, pk, PAIR_WINDOW_MS, now);
      if (pairs.length >= PAIR_MAX) return { ok: false, reason: 'pair_rate_limited' };
      const sends = prune(sender, senderId, SENDER_WINDOW_MS, now);
      if (sends.length >= SENDER_MAX) return { ok: false, reason: 'sender_rate_limited' };
      pairs.push(now);
      sends.push(now);
      pair.set(pk, pairs);
      sender.set(senderId, sends);
      return { ok: true, token: { pk, senderId, at: now } };
    },
    /** Give back one reserved slot (delivery failed before commit). */
    release(token) {
      if (!token) return;
      for (const [map, key] of [[pair, token.pk], [sender, token.senderId]]) {
        const arr = map.get(key);
        if (!arr) continue;
        const idx = arr.indexOf(token.at);
        if (idx >= 0) arr.splice(idx, 1);
        if (!arr.length) map.delete(key);
      }
    },
  };
}
