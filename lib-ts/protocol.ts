// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const MSG_TYPES = [
  'PING', 'PONG', 'STATUS', 'ALERT', 'CMD', 'MSG', 'DISCOVER', 'ANNOUNCE',
  'HUB_HEARTBEAT', 'HUB_PROMOTE', 'HUB_DEMOTE', 'HUB_ELECTION', 'HUB_REGISTRY_SYNC',
] as const;

export type MsgType = typeof MSG_TYPES[number];

export interface NodeAddress {
  nodeId: string;
  name: string;
}

export interface Message {
  v: 1;
  type: MsgType;
  id: string;
  from: NodeAddress;
  to: NodeAddress;
  timestamp: string;
  channel: string | null;
  payload: Record<string, unknown>;
  ttl: number;
  replyTo: string | null;
}

export interface MessageOptions {
  channel?: string;
  ttl?: number;
  replyTo?: string;
  dataSources?: Array<Record<string, unknown>>;
  platform?: string | null;
}

const NODE_ID_PATH: string = path.join(__dirname, '..', 'data', 'node-id');

function loadOrCreateNodeId(): string {
  if (process.env.NODE_ID) return process.env.NODE_ID;
  try {
    const saved = fs.readFileSync(NODE_ID_PATH, 'utf-8').trim();
    if (saved) return saved;
  } catch { /* ignore */ }
  const id = `node-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const dir = path.dirname(NODE_ID_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(NODE_ID_PATH, id);
    console.log(`[protocol] NODE_ID gerado e salvo: ${id}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[protocol] Falha ao salvar NODE_ID: ${message}`);
  }
  return id;
}

export const NODE_ID: string = loadOrCreateNodeId();
export const NODE_NAME: string = process.env.NODE_NAME || 'Tulipa #1';

export function createMessage(
  type: MsgType,
  payload: Record<string, unknown>,
  to?: NodeAddress | null,
  options: MessageOptions = {},
): Message {
  if (!MSG_TYPES.includes(type)) {
    throw new Error(`Tipo inválido: ${type}. Use: ${MSG_TYPES.join(', ')}`);
  }
  return {
    v: 1,
    type,
    id: crypto.randomUUID(),
    from: { nodeId: NODE_ID, name: NODE_NAME },
    to: to || { nodeId: '*', name: 'broadcast' },
    timestamp: new Date().toISOString(),
    channel: options.channel || null,
    payload: payload || {},
    ttl: options.ttl || 300,
    replyTo: options.replyTo || null,
  };
}

export function ping(to?: NodeAddress, options?: MessageOptions): Message {
  return createMessage('PING', {}, to, options);
}

export function pong(replyTo: string, to?: NodeAddress, options?: MessageOptions): Message {
  return createMessage('PONG', {}, to, { ...options, replyTo });
}

export function status(payload: Record<string, unknown>, options?: MessageOptions): Message {
  return createMessage('STATUS', payload, null, options);
}

export function alert(payload: Record<string, unknown>, options?: MessageOptions): Message {
  return createMessage('ALERT', payload, null, options);
}

export function cmd(command: string, to?: NodeAddress, options?: MessageOptions): Message {
  return createMessage('CMD', { command }, to, options);
}

export function msg(text: string, to?: NodeAddress, options?: MessageOptions): Message {
  return createMessage('MSG', { text }, to, options);
}

export function discover(capabilities: string[], options?: MessageOptions): Message {
  return createMessage('DISCOVER', { capabilities }, null, options);
}

export function announce(
  capabilities: string[],
  channels: string[],
  options?: MessageOptions,
): Message {
  return createMessage('ANNOUNCE', {
    capabilities,
    channels,
    dataSources: options?.dataSources || [],
    platform: options?.platform || null,
  }, null, options);
}

export function hubHeartbeat(metrics: Record<string, unknown>, options?: MessageOptions): Message {
  return createMessage('HUB_HEARTBEAT', { metrics }, null, options);
}

export function hubPromote(
  targetNodeId: string,
  reason: string,
  epoch: number,
  options?: MessageOptions,
): Message {
  return createMessage('HUB_PROMOTE', { targetNodeId, reason, epoch, promotedBy: NODE_ID }, null, options);
}

export function hubDemote(
  targetNodeId: string,
  reason: string,
  epoch: number,
  options?: MessageOptions,
): Message {
  return createMessage('HUB_DEMOTE', { targetNodeId, reason, epoch, demotedBy: NODE_ID }, null, options);
}

export function hubElection(proposal: Record<string, unknown>, options?: MessageOptions): Message {
  return createMessage('HUB_ELECTION', proposal, null, options);
}

export function hubRegistrySync(
  hubs: Array<Record<string, unknown>>,
  epoch: number,
  options?: MessageOptions,
): Message {
  return createMessage('HUB_REGISTRY_SYNC', { hubs, epoch }, null, options);
}

export function validate(message: unknown): message is Message {
  if (!message || typeof message !== 'object') return false;
  const msg = message as Record<string, unknown>;
  if (msg.v !== 1) return false;
  if (!MSG_TYPES.includes(msg.type as MsgType)) return false;
  if (!msg.id || !(msg.from as NodeAddress)?.nodeId || !msg.timestamp) return false;
  return true;
}

export function serialize(message: Message): string {
  return JSON.stringify(message);
}

export function parse(raw: string | Record<string, unknown>): Message | null {
  try {
    const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return validate(msg) ? msg : null;
  } catch {
    return null;
  }
}
