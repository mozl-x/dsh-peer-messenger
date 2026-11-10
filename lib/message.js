// Message construction. 0.2.1 exports no public createAgentMessage, so build
// the native UserMessage inline with the relay source form. The sender is
// derived only from the real calling Agent (exec.agent) — never from model
// arguments — and a first-line prefix keeps the sender, the receiving
// session, the delivery mode and the send time visible even if the client
// renders no relay card (defensive degrade, see README invariant 16).
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { relayHeader } from './presentation.js';

/** Max serialized size for one relay message body. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * Build one relay UserMessage carrying the true sender session id.
 * @param {object} meta - { senderSessionId, senderTitle, targetSessionId, targetTitle, mode, text, sentAt }.
 * @param {Date} [meta.sentAt] - the send moment; defaults to now.
 * @returns {{ message: object, messageId: string }} native message + its id.
 */
export function buildRelayMessage(meta) {
  const { senderSessionId, senderTitle, targetSessionId, targetTitle, mode, text } = meta;
  const source = {
    kind: 'agent-message',
    form: 'relay',
    senderSessionId,
  };
  const content = [
    {
      type: 'text',
      text: `${relayHeader({ senderSessionId, senderTitle, targetSessionId, targetTitle, mode, sentAt: meta.sentAt })}\n${text}`,
    },
  ];
  const bytes = new TextEncoder().encode(JSON.stringify(content)).length;
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new Error(`message exceeds ${MAX_MESSAGE_BYTES} bytes`);
  }
  const message = createUserMessage({ content, source });
  return { message, messageId: message.id };
}
