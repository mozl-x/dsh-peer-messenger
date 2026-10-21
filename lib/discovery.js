// Discovery: enumerate messaging-eligible peers by composing native services.
// Truth source is always the Harness (sessionQuery list + workspaces archived +
// agents live registry + readTitleSnapshots). currentCwd comes from the
// working-directory projection, NOT the immutable header.cwd (0.2.1 correction).
import { checkTarget } from './admission.js';

/**
 * Build the peer candidate list from native services, for a given caller.
 * @param {object} services - { ctx } with sessionQuery/workspaces/agents/sessionProjections.
 * @param {string} selfId - caller session id to exclude.
 * @param {AbortSignal} [signal] - tool cancellation.
 * @returns {Promise<Array<object>>} eligible peer descriptors.
 */
export async function listPeers(services, selfId, signal) {
  const { ctx } = services;
  const records = await ctx.sessionQuery.listSessions(signal);
  const archivedSet = new Set(ctx.workspaceRegistry?.archivedSessionIds ?? []);

  // Live agent ids, once, for O(1) membership + status.
  const liveById = new Map();
  for (const agent of ctx.agents.list()) liveById.set(String(agent.id), agent);

  const candidates = [];
  for (const record of records) {
    const eligible = checkTarget(record, { archivedSet }, selfId);
    if (!eligible.ok) continue;
    candidates.push(record);
  }

  const titleResults = await ctx.sessionQuery.readTitleSnapshots(
    candidates.map((r) => r.header.id),
    signal,
  );
  const titleById = new Map();
  for (const res of titleResults) {
    // Fulfilled carries value: SessionTitleObservation; its .title is a
    // SessionTitleSnapshot whose .title is the string.
    if (res.status === 'fulfilled' && res.value?.title) {
      titleById.set(String(res.sessionId), res.value.title.title);
    }
  }

  return candidates.map((record) => {
    const id = String(record.header.id);
    const agent = liveById.get(id);
    const cwd = agent
      ? ctx.sessionProjections?.stateOf?.(agent.session, 'workingDirectory') ?? null
      : null;
    return {
      id,
      title: titleById.get(id) ?? null,
      live: Boolean(agent),
      status: agent ? agent.status : 'offline',
      cwd,
      createdAt: record.header.createdAt,
    };
  });
}
