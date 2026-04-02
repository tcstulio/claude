# Tulipa — Instruções para GitHub Copilot

## Sobre o projeto

Tulipa é uma rede distribuída de agentes IA com identidade criptográfica (Ed25519), comunicação multi-canal (WhatsApp, Telegram, Email, Webhook) e economia verificável (TaskReceipts com dupla assinatura).

Autor: Tulio Silva (CoolGroove / Teatro Mars)

## Stack

- **Linguagem:** TypeScript (ES2022, strict mode)
- **Runtime:** Node.js >= 22
- **Framework:** Express 4
- **Testes:** Vitest 4.1 — 301 testes, 22 test files
- **CI:** GitHub Actions matrix (Ubuntu, Windows, macOS x Node 22, 24)
- **DB:** SQLite (better-sqlite3 / sql.js fallback)

## Estrutura

```
lib-ts/                # Fonte principal (56 arquivos .ts)
  server.ts            # Express app (100+ endpoints)
  handlers/            # Rotas HTTP (11 módulos)
  mesh/                # Rede P2P (discovery, federation, logs federados)
  transport/           # WhatsApp, Telegram, Email, Webhook
  ledger/              # TaskReceipt + economia (SHA-256 + Ed25519)
  infra/               # Scanner, adoption, canary
  middleware/          # Auth, scope guard, token federation
  storage.ts           # SQLite (audit_log, tasks, peers, messages)
  types.ts             # Interfaces TypeScript
test/                  # 22 test files (Vitest)
```

## Convenções de código

- Idioma do código e comentários: português (BR)
- Imports com extensão `.js` (ESM)
- `type: "module"` no package.json
- Interfaces em `lib-ts/types.ts`
- Padrão de handler: `registerXxxRoutes(app, deps)` em `lib-ts/handlers/`
- Testes em `test/*.test.ts` usando `describe/it/expect` do Vitest

## Comandos

```bash
npm test              # Rodar testes
npm run typecheck     # Verificar tipos
npm run build         # Compilar para dist/
npm run dev           # Modo watch
```

## Gateway MCP

- Endpoint: https://agent.coolgroove.com.br
- Auth: `Authorization: Bearer <token>`
- Protocolo: JSON-RPC 2.0 via POST /mcp
- 12 MCP tools: get_status, list_peers, send_prompt, run_command, send_whatsapp, etc.
