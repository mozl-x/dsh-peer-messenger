// Delivery: resolve the target to a live Agent (resume offline peers), re-check
// archive/eligibility AFTER resume and BEFORE commit (0.2.1 resume window race),
// then deliver over native followup/steer/inject. Handles for offline-resumed
// peers are cached and released on unload.
import { buildRelayMessage } from './message.js';
import { checkTarget } from './admission.js';

/**
 * @param {object} services - { ctx, budget, ledger }.
 */
export function createDelivery(services) {
  const { ctx, budget, ledger } = services;
  const resumed = new Map(); // sessionId -> AgentHandle (offline cold-resume cache)

  ctx.effect(() => () => {
    for (const handle of resumed.values()) Promise.resolve(handle.dispose()).catch(() => {});
    resumed.clear();
  }, 'dsh-peer-messenger: handle cache');

  async function resolveLive(targetId, signal) {
    const existing = ctx.agents.get(targetId);
    if (existing) return { agent: existing, owned: false };
    const cached = resumed.get(targetId);
    if (cached) return { agent: cached.agent, owned: true };
    const handle = await ctx.agents.resume({ resumeSessionId: targetId, signal });
    resumed.set(targetId, handle);
    return { agent: handle.agent, owned: true };
  }

  /**
   * Deliver one relay message to a target session.
   * @param {string} senderId - real caller session id.
   * @param {string} targetId - destination session id.
   * @param {string} text - message body.
   * @param {'followup'|'steer'|'inject'} mode - delivery semantics.
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ accepted: boolean, messageId: string, targetStatus: string }>}
   * @throws on ineligible target, budget rejection, or mode/availability mismatch.
   */
  return async function deliver(senderId, targetId, text, mode, signal) {
    // Pre-reserve budget so a rejection never touches the target Inbox.
    const reservation = budget.reserve(senderId, targetId);
    if (!reservation.ok) throw new Error(reservation.reason);

    try {
      const record = await ctx.sessionQuery.readSession(targetId);
      const archivedSet = new Set(ctx.workspaceRegistry?.archivedSessionIds ?? []);
      const eligible = checkTarget({ header: record.session }, { archivedSet }, senderId);
      if (!eligible.ok) throw new Error(eligible.reason);

      const { agent } = await resolveLive(targetId, signal);

      // Re-check after the resume window (cancel / archive may have landed).
      if (ctx.workspaceRegistry?.archivedSessionIds?.some((x) => String(x) === targetId)) {
        throw new Error('target_archived');
      }

      const { message, messageId } = buildRelayMessage(senderId, text);

      // steer / inject require a running target; followup admits idle or running.
      if (mode !== 'followup' && agent.status !== 'running') {
        throw new Error(`${mode}_requires_running_target`);
      }
      if (mode === 'steer') agent.steer(message);
      else if (mode === 'inject') agent.inject(message);
      else agent.followup(message);

      // Record for receipt; keyed by the native messageId this send minted.
      ledger.set(String(messageId), {
        senderId: String(senderId),
        targetId: String(targetId),
      });

      return { accepted: true, messageId, targetStatus: agent.status };
    } catch (error) {
      budget.release(reservation.token);
      throw error;
    }
  };
}
