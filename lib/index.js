// Cross-session peer messaging for DSH 0.2.1 — host half (three tools).
// Reuses native relay source + native RelayBody rendering; owns only addressing,
// admission, delivery and transport receipts. No second inbox, no auto-reply,
// no broadcast, no whitelist, and (per the host plugin-development practices) no
// reading another plugin's DOM. See README invariant list.
import { defineTool } from '@deepseek-ai/dsh-tools';
import { brandString } from '@deepseek-ai/dsh-brand';
import { listPeers } from './discovery.js';
import { createBudget } from './admission.js';
import { createDelivery } from './delivery.js';
import { createReceipt } from './receipt.js';
import { sessionLabel, summarizeMessage } from './presentation.js';

const name = 'dsh-peer-messenger';
// sessionPersistence is optional: without it offline cold-resume is unavailable
// (steer/inject still require a running target, so messaging degrades cleanly).
const inject = [
  'tools',
  'agents',
  'sessionQuery',
  'workspaceRegistry',
  'sessionProjections',
];

const DELIVERY_MODES = ['followup', 'steer', 'inject'];

function apply(ctx) {
  const budget = createBudget();
  // messageId -> { senderId, targetId }, process-local (no durable spool).
  const ledger = new Map();

  const deliver = createDelivery({ ctx, budget, ledger });
  const check = createReceipt({ ctx }, ledger);

  ctx.tools.register(defineTool({
    name: 'list_peer_agents',
    description:
      'List messaging-eligible peer sessions (independent sessions in this process: not archived, not a subagent, not yourself), with live/offline status and titles. Read-only; listing never sends or wakes anything.',
    parameters: {
      limit: {
        type: 'number',
        description: 'Max peers to return (default 25, capped 100).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          peers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                status: { type: 'string', enum: ['idle', 'running', 'offline'] },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const self = requireSelf(exec);
      const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 25)), 100);
      const peers = await listPeers({ ctx }, String(self.id), exec.signal);
      return {
        peers: peers.slice(0, limit).map((p) => ({
          sessionId: p.id,
          title: p.title,
          status: p.status === 'running' ? 'running' : p.live ? 'idle' : 'offline',
        })),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'send_agent_message',
    description:
      "Send one message to another independent session's agent, provenanced to YOUR session so the receiver can reply to you. Modes: followup (default, next turn) needs nothing; steer (correct a live turn) and inject (background context) require a running target; offline targets are resumed with defaults then delivered as followup. Reports transport acceptance only — never your task results. Use only when the user asked you to message another session or an explicit standing instruction authorizes it.",
    parameters: {
      target_session_id: {
        type: 'string',
        required: true,
        description: 'Full target SessionId (from list_peer_agents; plain ids are not guessed).',
      },
      message: {
        type: 'string',
        required: true,
        description: 'Message text for the peer agent (max 64KB serialized).',
      },
      mode: {
        type: 'string',
        enum: DELIVERY_MODES,
        description: 'followup (default) | steer | inject.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean' },
          messageId: { type: 'string' },
          targetStatus: { type: 'string', enum: ['idle', 'running', 'offline'] },
          targetTitle: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          senderTitle: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          mode: { type: 'string', enum: DELIVERY_MODES },
          sentAt: { type: 'string' },
        },
      },
      // The receipt states WHAT was sent and WHERE it went: target title with
      // its id, the delivery mode, the send time, and a summary of the body.
      render: (args, value) => [
        {
          type: 'text',
          text: [
            `已投递（${value.mode}）至 ${sessionLabel(args.target_session_id, value.targetTitle)}`,
            `发送时间 ${value.sentAt} · 目标状态 ${value.targetStatus} · 消息ID ${value.messageId}`,
            `消息内容：${summarizeMessage(args.message)}`,
          ].join('\n'),
        },
      ],
    },
    async execute(args, exec) {
      const self = requireSelf(exec);
      const mode = args.mode ?? 'followup';
      if (!DELIVERY_MODES.includes(mode)) throw new Error(`unknown mode: ${mode}`);
      return deliver(
        String(self.id),
        brandString(args.target_session_id),
        String(args.message),
        mode,
        exec.signal,
      );
    },
  }));

  ctx.tools.register(defineTool({
    name: 'check_delivery',
    description:
      'Check transport state of ONE message you previously sent via send_agent_message, by its messageId. Returns pending | claimed | processed | unknown. "processed" means the peer began producing after admitting your message — NOT that your request is complete.',
    parameters: {
      message_id: {
        type: 'string',
        required: true,
        description: 'The messageId returned by your earlier send_agent_message.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['pending', 'claimed', 'processed', 'unknown'] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `delivery status: ${value.status}` }],
    },
    async execute(args, exec) {
      const self = requireSelf(exec);
      return check(String(self.id), String(args.message_id));
    },
  }));
}

function requireSelf(exec) {
  const agent = exec?.agent;
  if (!agent) throw new Error('peer messaging requires a calling agent (exec.agent was undefined)');
  return agent;
}

export { apply, inject, name };
