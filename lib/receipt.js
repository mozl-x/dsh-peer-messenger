// Receipt: report provable TRANSPORT facts only (never business completion).
// Reads one exact observation lease, folds the target's own event suffix (cut by
// inheritedEventCount so fork-inherited parent history never matches), and
// classifies the accepted message's state. Lease always released in finally.
// Scope: only messageIds this plugin recorded for the same sender are checkable
// (issue #5 — a caller cannot probe arbitrary messages).

/** Fold durable Inbox splices into messages still awaiting a claim. */
function pendingInboxMessages(events) {
  const inbox = { 'next-turn': [], 'next-step': [] };
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue;
    const { target, start, removedCount = 0, inserted = [] } = event.data;
    inbox[target].splice(start, removedCount, ...inserted);
  }
  return [...inbox['next-turn'], ...inbox['next-step']];
}

/**
 * @param {object} services - { ctx }.
 * @param {Map<string, {senderId: string, targetId: string}>} ledger - from delivery.
 */
export function createReceipt(services, ledger) {
  const { ctx } = services;

  /**
   * @param {string} senderId - caller session id (authorization filter).
   * @param {string} messageId - accepted id returned by an earlier send.
   * @returns {Promise<{ status: 'pending'|'claimed'|'processed'|'unknown' }>}
   */
  return async function check(senderId, messageId) {
    const entry = ledger.get(String(messageId));
    if (!entry || entry.senderId !== String(senderId)) {
      throw new Error('message_not_owned_by_sender');
    }

    const observation = await ctx.sessionQuery.observeSession(entry.targetId, {
      projectionMode: 'none',
    });
    try {
      const suffix = observation.events.slice(observation.inheritedEventCount);
      const isMine = (m) => m && String(m.id) === String(messageId);

      const admittedIndex = suffix.findIndex(
        (e) => e.type === 'user/message' && isMine(e.data),
      );
      if (admittedIndex >= 0) {
        // Committed to the log. We report transport only — an assistant output
        // after the message is not business completion (invariant 13); we never
        // parse content, only whether the target began producing.
        const hasFollowing = suffix
          .slice(admittedIndex + 1)
          .some((e) => e.type === 'assistant/message' || e.type === 'assistant/attempt');
        return { status: hasFollowing ? 'processed' : 'claimed' };
      }
      // Not committed: still queued in the pending inbox, or not found.
      const pending = pendingInboxMessages(suffix).some(isMine);
      return { status: pending ? 'pending' : 'unknown' };
    } finally {
      observation.dispose();
    }
  };
}
