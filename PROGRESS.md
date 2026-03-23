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

## Próximo passo: send_prompt P2P

### Objetivo
Usar `send_prompt` do gateway MCP para enviar prompts reais ao Servidor 2070, que executa via Claude CLI e retorna o resultado. Integrar com o mesh para delegação distribuída de tarefas.

### Por que este passo
- É o **core use case** da rede: agentes delegando trabalho entre si
- O `send_prompt` já existe no gateway como MCP tool
- O Servidor 2070 já respondeu PONG — a conexão P2P funciona
- Sem isso, a rede é apenas infraestrutura sem propósito prático

### O que implementar
1. `mesh.sendPrompt(nodeId, prompt, options)` — envia prompt e aguarda resposta
2. `POST /api/mesh/prompt/:nodeId` — rota REST para enviar prompt a um peer
3. Integrar com queue para retry se peer estiver temporariamente offline
4. Timeout configurável (prompts podem demorar)
5. Teste fim a fim: enviar prompt para Servidor 2070 e receber resposta

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
