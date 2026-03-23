'use strict';

/**
 * Local MCP Tools — tools que o agente expõe localmente (não dependem do gateway).
 *
 * Cada tool é um objeto { name, description, inputSchema, handler(args, context) }.
 * O handler retorna { content: [{ type: 'text', text }] } no formato MCP.
 */

/**
 * Cria o registro de tools locais.
 * @param {object} deps - { ledger, mesh, protocol }
 * @returns {object} { tools, handle(name, args), list() }
 */
function createLocalTools(deps = {}) {
  const { ledger, mesh } = deps;

  const tools = {};

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

      const view = args.view || 'summary';
      let data;

      switch (view) {
        case 'balance':
          data = ledger.getBalance();
          break;
        case 'receipts':
          data = ledger.getReceipts({
            peer: args.peer,
            skill: args.skill,
            limit: args.limit,
          });
          break;
        case 'summary':
        default:
          data = ledger.getSummary();
          if (args.peer) {
            data.peerDetail = {
              peerId: args.peer,
              balance: ledger.getPeerBalance(args.peer),
              receipts: ledger.getReceipts({ peer: args.peer, limit: args.limit || 10 }),
            };
          }
          break;
      }

      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  };

  // ─── verify_receipt ──────────────────────────────────────────────────
  const receiptLib = require('./ledger/receipt');

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
      const fromKey = args.fromPublicKey || mesh?.registry.get(args.receipt.from)?.metadata?.publicKey;
      const toKey = args.toPublicKey || mesh?.registry.get(args.receipt.to)?.metadata?.publicKey;

      const result = receiptLib.verifyReceipt(args.receipt, { fromPublicKey: fromKey, toPublicKey: toKey });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  };

  return {
    tools,

    /** Lista tools no formato MCP tools/list */
    list() {
      return Object.values(tools).map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },

    /** Executa uma tool local. Retorna null se não encontrar. */
    handle(name, args = {}) {
      const tool = tools[name];
      if (!tool) return null;
      return tool.handler(args);
    },
  };
}

module.exports = createLocalTools;
