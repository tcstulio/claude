# Projeto Tulipa Mesh — Transport Layer Multi-Canal

> Rede de agentes distribuídos com comunicação resiliente via múltiplos canais
> Owner: Tulio Silva (tcstulio@gmail.com)
> Data: 2026-03-23
> Status: Em desenvolvimento

---

## 1. Visão Geral

### O que é
Tulipa Mesh é uma evolução do projeto Tulipa que transforma a rede de agentes de uma arquitetura **hub-and-spoke** (todos dependem de um gateway central) para uma arquitetura **mesh** (nós se comunicam entre si por múltiplos canais).

### O problema
Hoje todos os nós dependem de um único gateway (`agent.coolgroove.com.br`). Se ele cai, **todos** ficam isolados — não conseguem enviar mensagens, verificar status, nem saber que os outros existem.

### A solução
Usar **qualquer canal de comunicação** (WhatsApp, Telegram, Instagram, etc.) como barramento de transporte entre nós. Cada grupo nesses canais funciona como um **pub/sub distribuído e gratuito**. Se um canal cai, os outros continuam funcionando.

```
ANTES (hub-and-spoke):                    DEPOIS (mesh):

Nó A ──► Gateway ◄── Nó B               Nó A ◄── Gateway ──► Nó B
              │                            │    ◄── WhatsApp ──►  │
         WhatsApp                          │    ◄── Telegram ──►  │
                                           └────◄── Instagram ──► ┘
Se cai = todos isolados                  Se um cai = outros compensam
```

---

## 2. O que existe hoje

### 2.1 Infraestrutura atual

| Componente | Descrição | Status |
|---|---|---|
| **Gateway MCP** | `https://agent.coolgroove.com.br` | Produção |
| **Agent ID** | `agent_00726da6-5b9e-4d63-afcd-2f04c9572ebc` | Ativo |
| **server.js** | Proxy Express + Watchdog (284 linhas) | Produção |
| **Watchdog** | Monitora gateway, alerta via WhatsApp | Produção |
| **Auth** | Bearer token via env ou header passthrough | Produção |

### 2.2 MCP Tools disponíveis no gateway

| Tool | Descrição | Relevância p/ Mesh |
|---|---|---|
| `get_status` | Status do agente/gateway | Monitoramento |
| `get_network_identity` | Identidade na rede | Descoberta de nós |
| `list_peers` | Listar agentes conectados | Descoberta de nós |
| `list_tasks` | Listar tarefas | Coordenação |
| `list_tokens` | Listar tokens de acesso | Auth |
| `create_token` | Criar novo token | Auth |
| `revoke_token` | Revogar token | Auth |
| `run_command` | Executar comando remoto | Controle remoto |
| `send_prompt` | Enviar prompt para outro agente | Comunicação P2P |
| `get_logs` | Ver logs do sistema | Debug |
| `send_whatsapp` | Enviar mensagem WhatsApp | **Transport** |
| `get_whatsapp_history` | Histórico de WhatsApp | **Transport** |

### 2.3 API REST atual (server.js)

| Método | Rota | Função |
|---|---|---|
| `GET` | `/api/health` | Proxy health do gateway |
| `GET` | `/api/status` | Status do agente (`get_status`) |
| `GET` | `/api/monitor` | Estado do watchdog |
| `GET` | `/api/peers` | Listar agentes conectados |
| `GET` | `/api/logs` | Logs do sistema |
| `GET` | `/api/whatsapp/history` | Histórico WhatsApp |
| `POST` | `/api/whatsapp/send` | Enviar WhatsApp |
| `POST` | `/api/mcp/:tool` | Proxy genérico MCP |

### 2.4 Dependências

```json
{
  "express": "^4.21.0",
  "undici": "^7.24.5"
}
```

### 2.5 Ecossistema CoolGroove completo

Este projeto faz parte do ecossistema CoolGroove de gestão de eventos em São Paulo:

| Repositório | Função | Tech |
|---|---|---|
| **sistemav2** | Hub operacional (CRM, banking, scraping, WhatsApp) | React 19 + TS + Node |
| **TeatroMars** | Booking de venue e orçamentos | PHP + Tailwind |
| **carnaval** | App de engajamento (gamificação, jukebox, tickets) | React 19 + TS + Socket.IO |
| **stagemaster-ai** | Automação de produção de shows (DMX, OSC, OBS) | React 19 + TS + Node |
| **claude** | Protótipos, visualizações e **Tulipa Mesh** | Node + Express |

Fluxo do venue: PLAN (sistemav2) → SELL (TeatroMars/carnaval) → ENGAGE (carnaval) → PRODUCE (stagemaster-ai) → OPERATE (sistemav2)

### 2.6 Histórico de desenvolvimento (Git)

| # | Commit | O que foi feito |
|---|---|---|
| 1 | `0ee681f` | Visualização 3D da arquibancada (Three.js) |
| 2 | `473287d` | Documentação inicial do codebase |
| 3 | `3aa96f7` | Pesquisa sobre scheduled tasks (Linux + Termux) |
| 4 | `2c0feb4` | Diagrama do ecossistema CoolGroove (5 repos) |
| 5 | `c03dd7c` | Configuração MCP Server Meta Ads |
| 6 | `2054401` | Calculadora ROI de vídeo |
| 7 | `8d04d75` | Nicho música + plataformas streaming |
| 8 | `79a5891` | Scripts Termux para sessões persistentes |
| 9 | `0df6a7f` | Página /join para registro de usuários |
| 10 | `c71d96c` | Config de conexão com rede Tulipa |
| 11 | `0734292` | Instruções de conexão Tulipa |
| 12 | `4a16ef2` | Documentação Tulipa no CLAUDE.md |
| 13 | `b8a7979` | **Proxy API REST para WhatsApp e MCP tools** |
| 14 | `9c3efb6` | Proxy HTTP + auth Bearer |
| 15 | `8e9527a` | Tratamento de erro quando MCP offline |
| 16 | `cd1fcb3` | **Watchdog com alertas WhatsApp** |

---

## 3. Arquitetura Proposta

### 3.1 Estrutura de arquivos

```
/home/user/claude/
├── server.js                    ← servidor principal (refatorado)
├── package.json
├── CLAUDE.md
├── PROJETO-TULIPA-MESH.md      ← este documento
├── tulipa-connection.json
├── arquibancada.html
│
├── lib/
│   ├── transport/
│   │   ├── base.js             ← classe abstrata Transport
│   │   ├── whatsapp.js         ← transport WhatsApp (via MCP gateway)
│   │   ├── telegram.js         ← transport Telegram (Bot API)
│   │   └── instagram.js        ← transport Instagram (Graph API)
│   │
│   ├── router.js               ← roteador multi-canal com fallback
│   ├── queue.js                ← fila persistente de mensagens
│   ├── protocol.js             ← formato padronizado de mensagens
│   └── mesh.js                 ← descoberta e comunicação P2P
│
└── config/
    └── transports.json         ← configuração dos canais ativos
```

### 3.2 Camadas da arquitetura

```
┌─────────────────────────────────────────────┐
│              APLICAÇÃO (server.js)           │
│         Watchdog, API REST, MCP proxy        │
├─────────────────────────────────────────────┤
│                MESH LAYER                    │
│     Descoberta de nós, estado da rede,       │
│     heartbeat, coordenação                   │
├─────────────────────────────────────────────┤
│               PROTOCOL LAYER                 │
│     Formato de mensagens, tipos,             │
│     serialização, validação                  │
├─────────────────────────────────────────────┤
│                ROUTER LAYER                  │
│     Seleção de canal, fallback,              │
│     balanceamento, prioridade                │
├─────────────────────────────────────────────┤
│                QUEUE LAYER                   │
│     Fila persistente, retry,                 │
│     deduplicação, TTL                        │
├─────────────────────────────────────────────┤
│             TRANSPORT LAYER                  │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│   │ WhatsApp │ │ Telegram │ │Instagram │   │
│   │ (MCP)    │ │ (Bot API)│ │(Graph API)│   │
│   └──────────┘ └──────────┘ └──────────┘   │
└─────────────────────────────────────────────┘
```

### 3.3 Transport Base — Interface

Cada transport deve implementar:

```javascript
class Transport {
  constructor(config) {}

  // Identidade
  get name() {}        // 'whatsapp' | 'telegram' | 'instagram'
  get available() {}   // true/false — canal está acessível?

  // Operações
  async send(destination, message) {}     // enviar mensagem
  async receive(source, options) {}       // buscar mensagens recentes
  async listen(callback) {}              // escutar mensagens em tempo real (polling/webhook)

  // Saúde
  async healthCheck() {}                 // verificar se o canal está ok
  get lastSeen() {}                      // último timestamp de atividade
}
```

### 3.4 Protocolo de Mensagens

Formato padronizado para comunicação entre nós, independente do canal:

```json
{
  "v": 1,
  "type": "STATUS | PING | PONG | ALERT | CMD | MSG | DISCOVER | ANNOUNCE",
  "id": "uuid-v4",
  "from": {
    "nodeId": "node-abc123",
    "name": "Tulipa #1"
  },
  "to": {
    "nodeId": "node-xyz789 | *",
    "name": "Tulipa #2 | broadcast"
  },
  "timestamp": "2026-03-23T12:00:00Z",
  "channel": "whatsapp | telegram | instagram",
  "payload": {},
  "ttl": 300,
  "replyTo": "uuid-do-msg-original"
}
```

#### Tipos de mensagem

| Tipo | Direção | Descrição |
|---|---|---|
| `PING` | Nó → Nó | Verificar se outro nó está vivo |
| `PONG` | Nó → Nó | Resposta ao PING |
| `STATUS` | Nó → Grupo | Anunciar estado atual do nó |
| `ALERT` | Nó → Grupo | Alerta sobre problema (gateway down, etc.) |
| `CMD` | Nó → Nó | Comando para executar |
| `MSG` | Nó → Nó/Grupo | Mensagem genérica |
| `DISCOVER` | Nó → Broadcast | Pergunta "quem está na rede?" |
| `ANNOUNCE` | Nó → Broadcast | Responde "eu estou aqui, esses são meus canais" |

### 3.5 Router — Lógica de seleção de canal

```
1. Tentar canal preferido do destinatário
2. Se falhou → tentar próximo canal disponível (round-robin)
3. Se todos falharam → colocar na fila (queue)
4. Fila faz retry com backoff exponencial
5. Após N falhas → alertar operador
```

Prioridades configuráveis por nó:

```json
{
  "transports": {
    "whatsapp": { "enabled": true, "priority": 1, "groups": ["5511999..."] },
    "telegram": { "enabled": true, "priority": 2, "botToken": "...", "chatId": "..." },
    "instagram": { "enabled": false, "priority": 3 }
  },
  "fallback": "queue",
  "retryPolicy": {
    "maxRetries": 5,
    "backoff": "exponential",
    "initialDelay": 2000
  }
}
```

### 3.6 Queue — Fila de mensagens

```javascript
// Fila em memória com persistência em disco (JSON)
{
  "pending": [
    {
      "id": "uuid",
      "message": { /* protocolo completo */ },
      "attempts": 2,
      "lastAttempt": "2026-03-23T12:05:00Z",
      "nextRetry": "2026-03-23T12:05:08Z",
      "createdAt": "2026-03-23T12:05:00Z",
      "expiresAt": "2026-03-23T12:10:00Z"
    }
  ],
  "delivered": [],
  "failed": []
}
```

### 3.7 Mesh — Descoberta e topologia

Cada nó mantém uma tabela de peers conhecidos:

```javascript
{
  "self": {
    "nodeId": "node-abc123",
    "name": "Tulipa #1",
    "channels": ["whatsapp", "telegram"],
    "capabilities": ["gateway", "whatsapp", "watchdog"]
  },
  "peers": {
    "node-xyz789": {
      "name": "Tulipa #2",
      "channels": ["whatsapp"],
      "lastSeen": "2026-03-23T12:00:00Z",
      "status": "online",
      "capabilities": ["compute"]
    }
  }
}
```

Fluxo de descoberta:

```
1. Nó novo entra na rede
2. Envia DISCOVER em todos os canais disponíveis
3. Nós existentes respondem com ANNOUNCE
4. Nó novo atualiza sua tabela de peers
5. Periodicamente, todos enviam STATUS (heartbeat)
6. Se um nó não envia STATUS por N minutos → marcado offline
```

---

## 4. Fases de implementação

### Fase 1 — Transport Base + WhatsApp (PRIORIDADE)

**Objetivo**: Extrair o WhatsApp existente para a nova abstração.

- [ ] Criar `lib/transport/base.js` — classe abstrata
- [ ] Criar `lib/transport/whatsapp.js` — implementação usando `callMcpTool`
- [ ] Criar `lib/protocol.js` — formato de mensagens
- [ ] Refatorar `server.js` para usar o novo transport
- [ ] Testes manuais: enviar/receber via WhatsApp usando nova camada

**Resultado**: O sistema funciona igual ao que já existe, mas com a abstração no lugar.

### Fase 2 — Queue + Router

**Objetivo**: Nunca perder uma mensagem, mesmo se o canal cair.

- [ ] Criar `lib/queue.js` — fila com persistência em arquivo JSON
- [ ] Criar `lib/router.js` — seleção de canal com fallback
- [ ] Integrar queue no watchdog (alertas vão para fila se WhatsApp cair)
- [ ] Retry com backoff exponencial
- [ ] Endpoint `GET /api/queue` — ver estado da fila

**Resultado**: Mensagens sobrevivem a quedas temporárias do canal.

### Fase 3 — Telegram Transport

**Objetivo**: Segundo canal de comunicação.

- [ ] Criar `lib/transport/telegram.js` — usando Telegram Bot API
- [ ] Polling de mensagens do bot
- [ ] Configuração via `config/transports.json`
- [ ] Router seleciona entre WhatsApp e Telegram automaticamente

**Resultado**: Se WhatsApp cai, Telegram assume.

### Fase 4 — Mesh (Descoberta P2P)

**Objetivo**: Nós se conhecem e se comunicam sem depender do gateway.

- [ ] Criar `lib/mesh.js` — tabela de peers + heartbeat
- [ ] Implementar DISCOVER/ANNOUNCE via grupos
- [ ] Heartbeat periódico (STATUS a cada N minutos)
- [ ] Detecção de nó offline
- [ ] Endpoint `GET /api/mesh` — topologia da rede

**Resultado**: Rede auto-organizada, nós sabem quem está online.

### Fase 5 — Instagram e outros transports

**Objetivo**: Expandir canais disponíveis.

- [ ] Criar `lib/transport/instagram.js`
- [ ] Avaliar outros canais: Discord, Slack, Email, SMS
- [ ] Cada canal = novo transport implementando a mesma interface

**Resultado**: Rede praticamente impossível de ficar totalmente offline.

---

## 5. Princípios de design

1. **Interface única** — Todo transport implementa `send()`, `receive()`, `listen()`, `healthCheck()`
2. **Canal agnóstico** — O protocolo não sabe nem se importa se é WhatsApp, Telegram ou pombo-correio
3. **Falha esperada** — Canais vão cair. A fila e o router existem para isso
4. **Zero infraestrutura nova** — Grupos de WhatsApp/Telegram já são pub/sub distribuídos gratuitos
5. **Qualquer participante é um nó** — Uma pessoa no grupo pode responder um PING manualmente
6. **Simplicidade** — Prefira 3 linhas diretas a 1 abstração prematura
7. **Mínimo de dependências** — Usar APIs HTTP nativas, evitar SDKs pesados

---

## 6. Configuração de ambiente

### Variáveis existentes

| Variável | Padrão | Descrição |
|---|---|---|
| `GATEWAY_URL` | `https://agent.coolgroove.com.br` | Gateway MCP |
| `PORT` | `3000` | Porta do servidor |
| `TULIPA_TOKEN` | (vazio) | Token de autenticação |
| `ALERT_PHONE` | (vazio) | WhatsApp para alertas |
| `MONITOR_INTERVAL` | `120000` | Intervalo watchdog (ms) |
| `SLOW_THRESHOLD` | `10000` | Limite de resposta lenta (ms) |

### Variáveis novas (planejadas)

| Variável | Padrão | Descrição |
|---|---|---|
| `NODE_ID` | (auto-gerado) | Identificador único deste nó |
| `NODE_NAME` | `Tulipa #N` | Nome legível deste nó |
| `TELEGRAM_BOT_TOKEN` | (vazio) | Token do bot Telegram |
| `TELEGRAM_CHAT_ID` | (vazio) | Chat/grupo do Telegram |
| `MESH_HEARTBEAT` | `60000` | Intervalo de heartbeat (ms) |
| `QUEUE_PERSIST_PATH` | `./data/queue.json` | Arquivo de persistência da fila |
| `QUEUE_MAX_RETRIES` | `5` | Máximo de tentativas por mensagem |

---

## 7. Exemplos de uso

### Cenário 1: Gateway cai

```
[12:00] Gateway offline
[12:00] Nó A detecta (watchdog)
[12:00] Nó A tenta alertar via WhatsApp (MCP) → falha (gateway é o MCP)
[12:00] Router faz fallback → tenta Telegram
[12:00] Nó A envia no grupo Telegram: "🔴 ALERT: Gateway offline"
[12:00] Nó B lê do Telegram, confirma: "PONG: estou vivo, sem gateway também"
[12:05] Gateway volta
[12:05] Nó A detecta, envia: "✅ STATUS: Gateway recuperado"
```

### Cenário 2: Novo nó entra na rede

```
[14:00] Nó C inicia pela primeira vez
[14:00] Nó C envia DISCOVER em todos os canais
[14:00] Grupo WhatsApp: "DISCOVER: node-c / Tulipa #3 / canais: [whatsapp]"
[14:01] Nó A responde: "ANNOUNCE: node-a / Tulipa #1 / canais: [whatsapp, telegram]"
[14:01] Nó B responde: "ANNOUNCE: node-b / Tulipa #2 / canais: [whatsapp]"
[14:01] Nó C agora conhece 2 peers
```

### Cenário 3: WhatsApp cai

```
[16:00] WhatsApp fora do ar globalmente
[16:00] Nó A tenta enviar STATUS via WhatsApp → falha
[16:00] Router faz fallback → Telegram
[16:00] Nó A envia no Telegram: "STATUS: OK (WhatsApp indisponível)"
[16:00] Nó B confirma via Telegram
[16:00] Mensagens pendentes entram na fila
[18:00] WhatsApp volta → fila é esvaziada, mensagens entregues
```

---

## 8. Riscos e mitigações

| Risco | Impacto | Mitigação |
|---|---|---|
| Todos os canais caem | Total | Fila local persiste, entrega quando voltar |
| Spam nos grupos | Médio | Rate limiting + mensagens compactas |
| Latência alta | Baixo | Polling configurável, priorização de canais |
| Mensagens duplicadas | Baixo | Deduplicação por `id` da mensagem |
| Custo de API | Médio | WhatsApp via MCP (gratuito), Telegram Bot (gratuito) |
| Segurança | Alto | Mensagens assinadas, tokens por nó, validação de `from` |

---

## 9. Métricas de sucesso

- [ ] Sistema sobrevive a queda do gateway sem perder mensagens
- [ ] Nós se descobrem automaticamente em < 2 minutos
- [ ] Fallback entre canais acontece em < 5 segundos
- [ ] Fila nunca perde mensagem (persistência em disco)
- [ ] Adição de novo transport = 1 arquivo + configuração

---

## 10. Próximos passos imediatos

1. **Aprovar este documento** — revisar e ajustar antes de codar
2. **Implementar Fase 1** — Transport Base + WhatsApp
3. **Testar com 2 nós** — validar comunicação via grupo WhatsApp
4. **Implementar Fase 2** — Queue para garantir entrega
5. **Adicionar Telegram** — segundo canal, validar fallback
