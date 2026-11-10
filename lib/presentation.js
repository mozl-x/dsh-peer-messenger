// Presentation helpers shared by the sender's receipt and the receiver's
// header line.
//
// The relay source is a CLOSED durable record: the v2→v3 session migration
// accepts exactly {kind, form, senderSessionId} and rejects any extra key, so
// delivery metadata (sender/target title, mode, send time) cannot ride along
// in the source. It travels in the message's first line instead — the only
// carrier the receiving transcript renders besides the source itself.
/** Delivery mode names as shown to a human reader. */export const MODE_LABELS = {
  followup: '下一轮',
  steer: '当前回合纠偏',
  inject: '后台上下文注入',
};

/**
 * Read the latest title of each session.
 *
 * A session without a generated title is not an error — the raw session id
 * stays the identity — but a failing title observation is reported as "no
 * title" rather than failing the delivery, because a title is auxiliary
 * metadata and never the message's identity.
 * @param {object} ctx - host context carrying sessionQuery.
 * @param {Iterable<string>} sessionIds - sessions to name.
 * @param {AbortSignal} [signal] - tool cancellation.
 * @returns {Promise<Map<string, string|null>>} session id -> title or null.
 */
export async function readSessionTitles(ctx, sessionIds, signal) {
  const ids = [...new Set([...sessionIds].map((id) => String(id)))];
  const titles = new Map();
  if (ids.length === 0) return titles;
  const results = await ctx.sessionQuery.readTitleSnapshots(ids, signal);
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      titles.set(String(result.sessionId), null);
      continue;
    }
    const title = result.value?.title?.title;
    titles.set(
      String(result.sessionId),
      typeof title === 'string' && title !== '' ? title : null,
    );
  }
  return titles;
}

/**
 * Summarize a message body for the sender's receipt: its first line plus a
 * count of what follows, so the receipt shows WHAT was sent without echoing
 * a whole long body into the transcript.
 * @param {string} text - the delivered body.
 * @param {number} [maxChars] - maximum characters of the quoted first line.
 * @returns {string} the summary.
 */
export function summarizeMessage(text, maxChars = 120) {
  const normalized = String(text ?? '');
  const lines = normalized.split('\n');
  const first = lines[0] ?? '';
  const quoted = first.length > maxChars ? `${first.slice(0, maxChars)}…` : first;
  const rest = lines.length - 1;
  if (rest <= 0) return quoted;
  return `${quoted}…（另有 ${rest} 行，共 ${normalized.length} 字符）`;
}

/**
 * Format the send moment in the host's local time.
 * @param {Date} date - the instant the message was handed to the target.
 * @returns {string} `YYYY-MM-DD HH:mm:ss`.
 */
export function formatSentAt(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Name one session for a human reader: its title with the raw id beside it,
 * so a reader can always address the session.
 * @param {string} sessionId - the session id.
 * @param {string|null} title - the session title, or null when it has none.
 * @returns {string} the display name.
 */
export function sessionLabel(sessionId, title) {
  return title ? `《${title}》（${sessionId}）` : `会话 ${sessionId}`;
}

/**
 * Build the header the receiver reads: who sent it, which session received
 * it, how it was delivered, and when it left.
 * @param {object} meta - { senderSessionId, senderTitle, targetSessionId, targetTitle, mode, sentAt }.
 * @returns {string} the header, one line per fact group.
 */
export function relayHeader(meta) {
  const from = sessionLabel(meta.senderSessionId, meta.senderTitle);
  const to = sessionLabel(meta.targetSessionId, meta.targetTitle);
  const mode = MODE_LABELS[meta.mode] ?? meta.mode;
  return `来自${from} · 投递至${to}\n投递方式 ${mode} · 发送时间 ${meta.sentAt}`;
}
