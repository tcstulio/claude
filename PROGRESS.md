# Tulipa Mesh — Progresso de Desenvolvimento

> Atualizado: 2026-03-23
> Branch: `claude/tulipa-agent-connection-yZLs6`

---

## Estado Atual

### Infraestrutura

| Componente | Endpoint | Status |
|---|---|---|
| Gateway MCP (Tulipa #1) | `https://agent.coolgroove.com.br` | Online |
| Agent ID | `agent_00726da6-5b9e-4d63-afcd-2f04c9572ebc` | Hub Mode |
| Servidor 2070 (peer LAN) | `http://192.168.15.15:18800` | Online (degraded - sem supervisor) |
| Peer ID | `agent_cd1454ae-dcaa-4aaf-a203-022625a37765` | Trusted |
| Token | `tulipa_2a54...1474e23615b6c21c2e90` | Ativo |
| Remote Token (p/ Servidor 2070) | `tulipa_peer_f798...fbc70fc8` | Ativo |

### Fases implementadas

| Fase | Status | Detalhes |
|---|---|---|
| 1. Transport Base + WhatsApp | ✅ Completa | 4 transports: WhatsApp, Telegram, Email, Webhook |
| 2. Queue + Router | ✅ Completa | Fila persistente JSON + failover multi-canal |
| 3. Telegram Transport | ✅ Completa | Bot API com polling |
| 4. Mesh P2P | ✅ Completa | Discovery, registry, heartbeat, endpoint HTTP |
| 5. Mais transports | ⏳ Pendente | Instagram, Discord, Slack |

### Arquivos do projeto

```
lib/
├── mesh/
│   ├── index.js      (14 KB)  — MeshManager: discovery, heartbeat, P2P
│   └── registry.js   (4.3 KB) — PeerRegistry: estado dos peers
├── transport/
│   ├── base.js       (1.7 KB) — Classe abstrata Transport
│   ├── whatsapp.js   (5.2 KB) — WhatsApp via MCP gateway
│   ├── telegram.js   (5.0 KB) — Telegram Bot API
│   ├── email.js      (5.0 KB) — Gmail/Email via MCP
│   └── webhook.js    (7.2 KB) — HTTP webhook genérico
├── protocol.js       (3.1 KB) — Protocolo v1, 8 tipos de mensagem
├── queue.js          (5.3 KB) — Fila com retry + backoff exponencial
└── router.js         (3.8 KB) — Router multi-canal com fallback
server.js             (35 KB)  — Express app, 24+ rotas, watchdog, service registry
test/                          — 78 testes (todos passando)
```

### Testes: 78/78 passando

---

## O que foi feito (cronológico)

### Sessão 1 — Base da rede
- Proxy API REST para WhatsApp e MCP tools
- Auth Bearer passthrough
- Tratamento de erro quando MCP offline
- Watchdog com alertas WhatsApp

### Sessão 2 — Transport Layer
- Classe abstrata Transport com interface padronizada
- WhatsApp transport via `send_whatsapp` / `get_whatsapp_history`
- Telegram transport via Bot API
- Email transport via Gmail MCP
- Webhook transport genérico (Slack, Discord, n8n, etc.)

### Sessão 3 — Protocol + Queue + Router
- Protocolo v1: PING, PONG, STATUS, ALERT, CMD, MSG, DISCOVER, ANNOUNCE
- Fila persistente com retry exponencial (2s→4s→8s→16s→32s)
- Router com seleção por prioridade e fallback automático
- NODE_ID persistente em `data/node-id`

### Sessão 4 — Mesh P2P
- PeerRegistry com TTL (stale 5min, dead 15min)
- MeshManager: discovery via `list_peers`, heartbeat periódico
- Rotas: `/api/mesh`, `/api/mesh/peers`, `/api/mesh/discover`, etc.
- Integração completa no server.js

### Sessão 5 (atual) — P2P real + fix gateway
- **Diagnóstico 502**: EADDRINUSE na porta 18800 durante restart
- **Fix**: `services.yaml` do gateway atualizado com `fuser -k 18800/tcp` + delay 5s
- **P2P testado com sucesso**: Servidor 2070 respondeu PONG via `POST /api/message`
- **Protocolo P2P descoberto**: `POST /api/message` + `Authorization: Bearer <remoteToken>`
- **_sendToPeerRaw**: agora tenta HTTP direto → mesh incoming → relay
- **_discoverPeerEndpoints**: extrai IPs de logs mDNS do gateway
- **POST /api/mesh/peers/:nodeId**: registrar endpoint manualmente

---

## Sessão 6 — sendPrompt P2P (concluído)

- `mesh.sendPrompt(nodeId, prompt, { systemPrompt, model, timeoutMs })` implementado
- 3 estratégias com fallback: HTTP direto → gateway relay → send_prompt MCP
- `POST /api/mesh/prompt/:nodeId` — rota REST
- Teste E2E: "Quanto é 2+2?" → Servidor 2070 respondeu "4"
- 6 testes unitários (84 total, todos passando)

## Sessão 7 — Diagnóstico Servidor 2070 + Paridade

### Descobertas sobre o Servidor 2070
- **Plataforma**: Windows (win32 x64), Node v24.12.0
- **Gateway**: 0.1.0 (Tulipa #1 é 0.4.0) — 3 versões atrás
- **Hub mode**: false (nó comum)
- **Supervisor**: NÃO rodando
- **Logs**: NÃO persistentes
- **Auto-deploy**: NÃO configurado
- **Token peer scopes**: [read, write, peer] — sem admin
- **MCP**: Funcionando (12 tools), mas run_command bloqueado sem admin
- **Tokens existentes**: bootstrap, owner, owner-session

### Hub Mode — Como funciona
- `hubMode` é booleano no `~/.tulipa/network/identity.json`
- Ativar: `tulipa network hub enable`
- Hub mantém Registry global de peers, expõe `/api/network/registry`
- Qualquer nó pode ser hub — não é exclusivo
- Hub pode intermediar msgs entre peers que não se conhecem

### O que falta para paridade
1. Token admin no 2070 (obter via terminal local)
2. `git pull origin main` (atualizar 0.1.0 → 0.4.0)
3. Compilar TypeScript (todos os módulos)
4. Criar `services.yaml` (template pronto em config/services-windows.yaml)
5. Ativar hub mode (`tulipa network hub enable`)
6. Iniciar via supervisor (`tulipa up`)

### Arquivos criados
- `config/services-windows.yaml` — template de serviços para Windows
- `scripts/setup-2070.sh` — script de setup local
- `scripts/deploy-to-2070.sh` — deploy remoto via MCP (precisa admin token)

### Blocker (RESOLVIDO)
Token admin criado manualmente no 2070: `tulipa_4d30...d79b` (tok_xxx, scope [read,write,admin]).
Tokens no 2070 são hasheados — valor original só aparece na criação.

### Setup executado no 2070
1. git init + fetch + reset --hard origin/main → **v0.4.0**
2. npm install + typescript instalado
3. network compilado (--skipLibCheck)
4. supervisor compilado
5. gateway: dist/ do git (erros TS non-critical, JS funcional)
6. Hub mode: pendente (precisa rodar no terminal)
7. Supervisor: pendente (precisa restart do gateway)

### Handshake fix
- `mesh.requestAdminToken(nodeId)` — solicita create_token no peer via MCP
- `POST /api/mesh/admin-token/:nodeId` — rota REST
- Salva adminToken no registry do peer
- Problema: no peering original, só trocaram tokens peer [read,write,peer]
  sem trocar admin token para gerenciamento remoto

### Depois disso
- TaskReceipt + Ledger (Sprint 2) — contabilidade de tarefas
- WebSocket real-time — upgrade de HTTP polling para WS persistente
- Separação Infra vs Knowledge (Sprint 3)
- Mais transports (Instagram, Discord)

---

## Referências úteis

- Gateway health: `GET https://agent.coolgroove.com.br/api/health`
- MCP endpoint: `POST https://agent.coolgroove.com.br/mcp` (JSON-RPC 2.0)
- Servidor 2070 agent.json: `http://192.168.15.15:18800/.well-known/agent.json`
- Dashboard: servidor Express local na porta 3000
- Docs: `PROJETO-TULIPA-MESH.md`, `PROJETO-TULIPA.md`, `CLAUDE.md`
