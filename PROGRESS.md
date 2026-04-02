# Tulipa Mesh — Progresso de Desenvolvimento

> Atualizado: 2026-04-02
> Branch: `claude/e2e-testing-windows-issues-WPjHF`

---

## Estado Atual

### Infraestrutura

| Componente | Endpoint | Status |
|---|---|---|
| Gateway MCP (Tulipa #1) | `https://agent.coolgroove.com.br` | Online |
| Agent ID | `agent_00726da6-5b9e-4d63-afcd-2f04c9572ebc` | Hub Mode |
| Servidor 2070 (peer LAN) | `http://192.168.15.15:18800` | Online (Windows, win32 x64) |
| Peer ID | `agent_cd1454ae-dcaa-4aaf-a203-022625a37765` | Trusted |

### Stack Técnico

| Item | Valor |
|---|---|
| Linguagem | TypeScript (ES2022, strict mode) |
| Runtime | Node.js >= 22 |
| Framework | Express 4 |
| Testes | Vitest 4.1 — **301 passando** (22 test files) |
| CI/CD | GitHub Actions (matrix: Ubuntu, Windows, macOS x Node 22, 24) |
| Build | tsc (tsconfig.build.json) |
| Source | 56 arquivos `.ts` em `lib-ts/` |

### Fases implementadas

| Fase | Status | Detalhes |
|---|---|---|
| 1. Transport Base + WhatsApp | Completa | 4 transports: WhatsApp, Telegram, Email, Webhook |
| 2. Queue + Router | Completa | Fila persistente JSON + failover multi-canal |
| 3. Telegram Transport | Completa | Bot API com polling |
| 4. Mesh P2P | Completa | Discovery, registry, heartbeat, endpoint HTTP |
| 5. sendPrompt P2P | Completa | 3 estratégias com fallback (HTTP -> gateway -> MCP) |
| 6. Hub Consensus | Completa | Council, voting, quorum, election |
| 7. TaskReceipt + Ledger | Completa | SHA-256 + Ed25519 dual-sign |
| 8. Infra + Conhecimento | Completa | Scanner, adoption, capabilities |
| 9. Canary Autônomo | Completa | Workflow completo, LXC efêmero |
| 10. Gossip + Trust | Completa | BFS crawler, trust transitivo |
| 11. Federation + Relay | Completa | Busca distribuída, relay via hub |
| 12. Economia | Completa | Bootstrap credits, ranking composto |
| 13. Organizações | Completa | Policies, invite, roles |
| 14. Logs Federados | Completa | Query local + federada cross-machine |
| 15. CI/CD Cross-Platform | Completa | GitHub Actions matrix (3 OS x 2 Node) |

### Estrutura do Projeto

```
lib-ts/                          # 56 arquivos TypeScript
├── server.ts                    # Express app principal
├── handlers/                    # Route handlers (11 arquivos)
│   ├── core-routes.ts           # Health, status, logs, MCP proxy
│   ├── mesh-routes.ts           # P2P mesh
│   ├── transport-routes.ts      # WhatsApp, Telegram, Email, Webhook
│   ├── hub-routes.ts            # Hub consensus, voting
│   ├── capabilities-routes.ts   # Knowledge registry
│   ├── infra-routes.ts          # Infrastructure scanning
│   ├── org-economy-routes.ts    # Organizações & ledger
│   ├── services-deploy-routes.ts # Deploy
│   ├── log-routes.ts            # Logs federados
│   └── index.ts
├── mesh/                        # Rede P2P
│   ├── mesh-manager.ts          # Discovery, heartbeat, comunicação
│   ├── peer-registry.ts         # Registro de peers
│   ├── federation.ts            # Busca federada
│   ├── crawler.ts               # BFS network crawler
│   ├── hub-role.ts              # Hub state machine
│   ├── hub-council.ts           # Consensus & voting
│   ├── log-query.ts             # Tipos de log query
│   ├── log-query-service.ts     # Query local (SQLite + file logs)
│   ├── federated-log-query.ts   # Query federada cross-machine
│   └── mesh-proxy.ts            # Proxy routing
├── transport/                   # 4 canais de comunicação
│   ├── whatsapp.ts, telegram.ts, email.ts, webhook.ts
├── ledger/                      # Economia
│   ├── ledger.ts, receipt.ts, dashboard.ts
├── infra/                       # Infraestrutura
│   ├── infra-scanner.ts, infra-adopt.ts, canary.ts
├── middleware/                  # Auth & tokens
│   ├── scope-guard.ts, token-federation.ts
├── storage.ts                   # SQLite (audit_log, tasks, peers, messages)
├── protocol.ts                  # Protocolo v1 (13 tipos de mensagem)
├── router.ts                    # Router multi-canal com fallback
├── queue.ts                     # Fila com retry exponencial
├── task-engine.ts               # Decomposição & delegação de tasks
├── identity.ts                  # Ed25519 identity
└── types.ts                     # Interfaces TypeScript

test/                            # 22 test files (301 testes)
├── log-query.test.ts            # Logs federados (19 testes)
├── federation.test.ts           # Busca federada
├── mesh.test.ts                 # Rede P2P
├── trust.test.ts                # Grafo de confiança
├── protocol.test.ts             # Protocolo de mensagens
├── infra.test.ts                # Scanner de infra
├── ledger.test.ts               # Economia
├── org.test.ts                  # Organizações
├── ...e mais 14 arquivos
└── manual.sh                    # Testes E2E via curl

.github/workflows/test.yml      # CI matrix (Ubuntu, Windows, macOS)
```

---

## Histórico de Sessões

### Sessão 1 — Base da rede
- Proxy API REST para WhatsApp e MCP tools
- Auth Bearer passthrough
- Watchdog com alertas WhatsApp

### Sessão 2 — Transport Layer
- 4 transports: WhatsApp, Telegram, Email, Webhook
- Classe abstrata Transport com interface padronizada

### Sessão 3 — Protocol + Queue + Router
- Protocolo v1: PING, PONG, STATUS, ALERT, CMD, MSG, DISCOVER, ANNOUNCE
- Fila persistente com retry exponencial
- Router com seleção por prioridade e fallback

### Sessão 4 — Mesh P2P
- PeerRegistry com TTL (stale 5min, dead 15min)
- MeshManager: discovery, heartbeat, endpoint HTTP

### Sessão 5 — P2P real + fix gateway
- Fix EADDRINUSE na porta 18800
- P2P testado com sucesso: Servidor 2070 respondeu PONG

### Sessão 6 — sendPrompt P2P
- 3 estratégias com fallback: HTTP direto -> gateway relay -> send_prompt MCP
- Teste E2E: "Quanto é 2+2?" -> Servidor 2070 respondeu "4"

### Sessão 7 — Diagnóstico Servidor 2070 + Paridade
- Windows (win32 x64), Node v24.12.0
- IPC fix: Unix socket -> Windows named pipe (`\\.\pipe\tulipa-supervisor`)
- Hub mode ativado, supervisor rodando
- config/services-windows.yaml criado

### Sessão 8 — Migração TypeScript
- Migração completa de JS (lib/) para TS (lib-ts/)
- 282 testes passando com Vitest
- Strict mode, ES2022

### Sessão 9 — Logs Federados + CI/CD (atual)
- Sistema de log query distribuído: `POST /api/logs/query` (local) + `POST /api/network/logs` (federado)
- LogQueryService: consulta SQLite audit_log + tail de ~/.tulipa/logs/*.log
- FederatedLogQuery: propagação para todos peers com dedup, rate limit, timeout
- 19 novos testes (301 total)
- GitHub Actions workflow com matrix strategy (3 OS x 2 Node)
- Documentação completa atualizada

---

## Referências úteis

- Gateway health: `GET https://agent.coolgroove.com.br/api/health`
- MCP endpoint: `POST https://agent.coolgroove.com.br/mcp` (JSON-RPC 2.0)
- Servidor 2070: `http://192.168.15.15:18800/.well-known/agent.json`
- Dashboard: `http://localhost:3000/`
- CI: `.github/workflows/test.yml`
- Docs: `CLAUDE.md`, `PROJETO-TULIPA.md`, `PROJETO-TULIPA-MESH.md`
