// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import * as receiptLib from './ledger/receipt.js';
import type { LedgerLike, MeshLike, ProtocolLike, LocalToolsLike } from './types.js';

interface McpContent {
  content: Array<{ type: string; text: string }>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>): McpContent;
}

interface LocalToolsDeps {
  ledger?: LedgerLike;
  mesh?: MeshLike;
  protocol?: ProtocolLike;
}

export function createLocalTools(deps: LocalToolsDeps = {}): LocalToolsLike {
  const { ledger, mesh } = deps;
  const tools: Record<string, ToolDef> = {};

  // ─── get_ledger ──────────────────────────────────────────────────────

  tools.get_ledger = {
    name: 'get_ledger',
    description: 'Consulta o ledger local: saldo, receipts e resumo econômico do agente',
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['summary', 'balance', 'receipts'],
          description: 'Tipo de consulta (default: summary)',
        },
        peer: { type: 'string', description: 'Filtrar por peer ID' },
        skill: { type: 'string', description: 'Filtrar por skill' },
        limit: { type: 'number', description: 'Limitar número de receipts' },
      },
    },
    handler(args) {
      if (!ledger) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Ledger não configurado' }) }] };
      }

      const view = (args.view as string) || 'summary';
      let data: unknown;

      switch (view) {
        case 'balance':
          data = ledger.getBalance();
          break;
        case 'receipts':
          data = ledger.getReceipts({
            peer: args.peer as string | undefined,
            skill: args.skill as string | undefined,
            limit: args.limit as number | undefined,
          });
          break;
        case 'summary':
        default: {
          const summary = ledger.getSummary() as Record<string, unknown>;
          if (args.peer) {
            summary.peerDetail = {
              peerId: args.peer,
              balance: ledger.getPeerBalance(args.peer as string),
              receipts: ledger.getReceipts({ peer: args.peer as string, limit: (args.limit as number) || 10 }),
            };
          }
          data = summary;
          break;
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  };

  // ─── verify_receipt ──────────────────────────────────────────────────

  tools.verify_receipt = {
    name: 'verify_receipt',
    description: 'Verifica a validade de um TaskReceipt (hash + assinaturas)',
    inputSchema: {
      type: 'object',
      properties: {
        receipt: { type: 'object', description: 'O TaskReceipt completo a verificar' },
        fromPublicKey: { type: 'string', description: 'Chave pública do requester (base64)' },
        toPublicKey: { type: 'string', description: 'Chave pública do executor (base64)' },
      },
      required: ['receipt'],
    },
    handler(args) {
      const rcpt = args.receipt as Record<string, unknown>;
      const fromKey = (args.fromPublicKey as string) || mesh?.registry.get(rcpt.from as string)?.metadata?.publicKey as string | undefined;
      const toKey = (args.toPublicKey as string) || mesh?.registry.get(rcpt.to as string)?.metadata?.publicKey as string | undefined;

      const result = receiptLib.verifyReceipt(rcpt as unknown as import('./ledger/receipt.js').TaskReceipt, { fromPublicKey: fromKey, toPublicKey: toKey });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  };

  return {
    list() {
      return Object.values(tools).map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },

    handle(name: string, args: Record<string, unknown> = {}) {
      const tool = tools[name];
      if (!tool) return null;
      return tool.handler(args);
    },
  };
}

export default createLocalTools;
