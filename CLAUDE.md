# Projeto Tulipa — Rede de Agentes IA

Tulipa é uma rede de agentes conectados via gateway MCP, criada por Tulio Silva (CoolGroove / Teatro Mars).

## Gateway

- **Endpoint**: https://agent.coolgroove.com.br
- **Agent ID**: agent_00726da6-5b9e-4d63-afcd-2f04c9572ebc
- **Agent Name**: Tulipa #1 (Hub Mode)
- **Token:** tulipa_2a541781565121490338aa48fe471474e23615b6c21c2e90
- **Token ID:** tok_0bdbbbebec62
- **Auth:** Header `Authorization: Bearer <token>`

## API REST — Endpoints Principais

### Core
- `GET /api/health` — status do gateway
- `GET /api/status` — status do agente (via MCP get_status)
- `GET /api/build-info` — versão, build, features
- `GET /api/monitor` — estado do watchdog
- `GET /api/peers` — listar agentes conectados
- `GET /api/logs` — logs do sistema (via gateway MCP)
- `POST /api/mcp/:tool` — proxy para qualquer MCP tool
- `POST /api/send` — enviar via protocolo (router)

### Transports
- `POST /api/whatsapp/send` — enviar WhatsApp
- `GET /api/whatsapp/history` — histórico WhatsApp
- `POST /api/telegram/send` — enviar Telegram
- `GET /api/telegram/updates` — mensagens recebidas
- `POST /api/email/send` — enviar email
- `GET /api/email/search` — buscar email
- `POST /api/webhook/send` — enviar webhook
- `GET /api/webhook/endpoints` — listar endpoints
- `POST /api/webhook/endpoints` — registrar endpoint
- `POST /api/webhook/incoming/:source` — receber webhook

### Mesh P2P
- `GET /api/mesh` — estado do mesh
- `GET /api/mesh/peers` — peers conhecidos (filtros: status, capability)
- `POST /api/mesh/discover` — forçar discovery
- `POST /api/mesh/ping/:nodeId` — ping peer
- `POST /api/mesh/send/:nodeId` — enviar para peer
- `POST /api/mesh/prompt/:nodeId` — enviar prompt a peer (Claude P2P)
- `POST /api/mesh/incoming` — receber de peer (P2P)
- `POST /api/mesh/heartbeat` — pingar todos

### Hub & Governança
- `GET /api/hub/status` — status do hub
- `GET /api/hub/registry` — registro de peers
- `GET /api/hub/council` — membros do conselho
- `POST /api/hub/propose` — propor ação
- `POST /api/hub/vote` — votar proposta
- `POST /api/hub/election` — eleição de líder

### Logs Federados (novo)
- `POST /api/logs/query` — consulta logs locais do peer
- `POST /api/network/logs` — consulta federada (agrega todos os peers)
- `GET /api/network/logs` — conveniência via query params

### Network & Federação
- `POST /api/network/query` — busca por skill na rede
- `POST /api/network/relay` — relay via hub intermediário
- `GET /api/network/trust` — relações de confiança
- `GET /api/network/rank/:skill` — ranking por skill
- `POST /api/network/crawl` — crawl da topologia
- `GET /api/network/peers/public` — peers públicos

### Economia & Organizações
- `GET /api/ledger` — estado do ledger
- `GET /api/ledger/balance` — saldo do nó
- `GET /api/economy/dashboard` — visualização
- `GET /api/org` — listar organizações
- `POST /api/org` — criar organização

### Infraestrutura
- `GET /api/infra` — dashboard de infra
- `POST /api/infra/scan` — scan de subnet
- `POST /api/infra/adopt` — adotar nó descoberto
- `GET /api/capabilities` — capacidades do nó
- `GET /api/platform` — detecção de plataforma

### Deploy
- `POST /api/deploy/webhook` — GitHub auto-deploy
- `POST /api/deploy/trigger` — deploy manual
- `POST /api/deploy/remote` — deploy remoto
- `GET /api/deploy/log` — log de deploys

## MCP Tools disponíveis

| Tool | Descrição |
|---|---|
| `get_status` | Status do agente/gateway |
| `get_network_identity` | Identidade na rede |
| `list_peers` | Listar agentes conectados |
| `list_tasks` | Listar tarefas |
| `list_tokens` | Listar tokens de acesso |
| `create_token` | Criar novo token |
| `revoke_token` | Revogar token |
| `run_command` | Executar comando remoto |
| `send_prompt` | Enviar prompt para outro agente |
| `get_logs` | Ver logs do sistema |
| `send_whatsapp` | Enviar mensagem WhatsApp |
| `get_whatsapp_history` | Histórico de WhatsApp |

## Exemplo de chamada MCP

```bash
curl -X POST https://agent.coolgroove.com.br/mcp \
  -H "Authorization: Bearer tulipa_2a541781565121490338aa48fe471474e23615b6c21c2e90" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"get_status","arguments":{}}}'
```

## Exemplo de consulta de logs federados

```bash
# Consultar logs de todas as máquinas da rede
curl -X POST http://localhost:3000/api/network/logs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"since":"2026-04-01","events":["task.created"],"limit":50}'

# Incluir logs de arquivo + busca por texto
curl -X POST http://localhost:3000/api/network/logs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"includeFileLog":true,"search":"error","limit":100}'
```

## Monitor / Watchdog

O servidor inclui um sistema de monitoramento automático que verifica o gateway periodicamente e envia alertas via WhatsApp.

### Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `ALERT_PHONE` | (vazio) | Número WhatsApp para alertas (ex: 5511999999999) |
| `MONITOR_INTERVAL` | `120000` | Intervalo entre checks em ms (2 min) |
| `SLOW_THRESHOLD` | `10000` | Tempo máximo aceitável de resposta em ms |
| `TULIPA_DB_PATH` | `./data/tulipa.db` | Caminho do banco SQLite |
| `GATEWAY_URL` | `https://agent.coolgroove.com.br` | URL do gateway MCP |
| `PORT` | `3000` | Porta do servidor Express |
| `NODE_ID` | (auto) | ID do nó (gerado automaticamente) |
| `NODE_NAME` | `Tulipa #1` | Nome do nó |
| `NODE_CAPABILITIES` | `chat,monitoring,deploy,relay` | Capacidades do nó |
| `MESH_DISCOVERY_INTERVAL` | `120000` | Intervalo de discovery (ms) |
| `MESH_HEARTBEAT_INTERVAL` | `60000` | Intervalo de heartbeat (ms) |

### Comportamento

- Verifica health do gateway + MCP a cada `MONITOR_INTERVAL`
- Envia alerta após **2 falhas consecutivas** (evita falso positivo)
- Notifica quando o serviço **volta ao normal**
- `GET /api/monitor` retorna estado atual do watchdog

### Tipos de alerta

- OFFLINE — gateway ou MCP inacessível
- Lenta — resposta acima do threshold
- Recuperacao — voltou ao normal

## CI/CD

O projeto usa GitHub Actions com matrix strategy para testes cross-platform:

- **OS:** Ubuntu, Windows, macOS
- **Node.js:** 22, 24
- **Workflow:** `.github/workflows/test.yml`
- Executa `npm test` (Vitest) + `npm run typecheck` em todos os ambientes

## Regras

1. **Ao iniciar conversa:** testar `/api/health` para confirmar que o agente está online
2. **Se token falhar (401):** informar o usuário e pedir novo token
3. **Guardar tokens rotativos** na memória (memory_user_edits), nunca no chat
4. **Nunca expor tokens completos no chat** — referir pelos últimos 8 chars
5. **Dono da rede:** Tulio Silva (tcstulio@gmail.com)

## Convenções

- Branch de desenvolvimento: sempre prefixado com `claude/`
- Idioma principal: português (BR)
- Owner: Tulio Silva
- Framework de testes: Vitest
- Linguagem: TypeScript (ES2022, strict mode)
- Runtime: Node.js >= 22
