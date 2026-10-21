// Message construction. 0.2.1 exports no public createAgentMessage, so build the
// native UserMessage inline with the relay source form. The sender is derived
// only from the real calling Agent (exec.agent) — never from model arguments —
// and a first-line prefix keeps the sender human/model-visible even if the
// client renders no relay card (defensive degrade, see README invariant 16).
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** Max serialized size for one relay message body. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * Build one relay UserMessage carrying the true sender session id.
 * @param {string} senderSessionId - the real calling agent's session id.
 * @param {string} text - the message body (single text block).
 * @returns {{ message: object, messageId: string }} native message + its id.
 */
export function buildRelayMessage(senderSessionId, text) {
  const source = {
    kind: 'agent-message',
    form: 'relay',
    senderSessionId,
  };
  const content = [
    { type: 'text', text: `Peer message from agent ${senderSessionId}:\n${text}` },
  ];
  const bytes = new TextEncoder().encode(JSON.stringify(content)).length;
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new Error(`message exceeds ${MAX_MESSAGE_BYTES} bytes`);
  }
  const message = createUserMessage({ content, source });
  return { message, messageId: message.id };
}
