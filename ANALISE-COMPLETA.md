# Tulipa — Análise Completa e Proposta de Economia

> Use este arquivo como prompt para solicitar uma análise completa do projeto.
> Cole em uma nova sessão ou passe como contexto para o agente analisar tudo.

---

## O que é o Tulipa

Rede de agentes IA conectados via gateway MCP, criada por Tulio Silva.
Dois sistemas principais:

1. **tulipa-api** (porta 3000) — servidor Node.js que faz proxy do gateway MCP, gerencia mensagens multi-canal, mesh de peers, tasks, deploy, e monitoramento
2. **tulipa-pet** (porta 3333) — pet virtual estilo Tamagotchi que reflete a saúde real dos dispositivos (CPU, memória, GPU, tokens, WhatsApp, etc.)

---

## Estrutura do Projeto

```
/
├── server.js                          # API principal (~1200 linhas)
├── lib/
│   ├── metrics.js                     # Coleta CPU, RAM, GPU, contadores
│   ├── terminal.js                    # Captura estado tmux
│   ├── storage.js                     # SQLite (better-sqlite3 / sql.js)
│   ├── queue-sqlite.js                # Fila de mensagens persistente
│   ├── task-engine.js                 # Engine de tarefas (decompose, delegate)
│   ├── identity.js                    # Ed25519 (assinatura de mensagens)
│   ├── protocol.js                    # Protocolo de mensagens
│   ├── router.js                      # Roteador multi-canal
│   ├── transport/
│   │   ├── whatsapp.js                # Via MCP send_whatsapp
│   │   ├── telegram.js                # Via Bot API
│   │   ├── email.js                   # Via Gmail MCP
│   │   └── webhook.js                 # HTTP genérico
│   └── mesh/
│       ├── index.js                   # MeshManager (discovery, heartbeat)
│       └── registry.js                # PeerRegistry (Map de peers)
├── tulipa-pet/
│   ├── src/
│   │   ├── index.ts                   # Entry point
│   │   ├── types.ts                   # Tipos compartilhados
│   │   ├── api/server.ts              # Express + WebSocket (porta 3333)
│   │   ├── web/index.html             # Dashboard interativo
│   │   ├── engine/
│   │   │   ├── pet-state.ts           # Needs, mood, evolution, XP
│   │   │   ├── pet-manager.ts         # Orquestrador de sensores
│   │   │   ├── achievements.ts        # 30+ conquistas
│   │   │   ├── pet-network.ts         # P2P (amizades, presentes)
│   │   │   └── notifications.ts       # Alertas WhatsApp 1a pessoa
│   │   └── sensors/
│   │       ├── collector-factory.ts   # Auto-detecta ambiente
│   │       ├── api-collector.ts       # Consome /api/metrics/sensors
│   │       ├── terminal-collector.ts  # Consome /api/terminal/panes
│   │       ├── server-collector.ts    # Coleta local (fallback)
│   │       ├── android-collector.ts   # Termux APIs
│   │       └── tulipa-collector.ts    # MCP network (peers, tasks, WhatsApp)
│   └── data/                          # Persistência (pet.json, history, achievements)
├── public/index.html                  # Dashboard da rede Tulipa
├── test/                              # 122 testes (node --test)
├── deploy.sh                          # Auto-deploy via webhook
├── CLAUDE.md                          # Instruções do projeto
└── package.json
```

---

## O que já funciona

### tulipa-api (server.js)
- [x] Proxy MCP com retry + JSON-RPC 2.0
- [x] 4 transportes: WhatsApp, Telegram, Email, Webhook
- [x] Router com fallback automático entre canais
- [x] Fila de mensagens SQLite (retry exponencial)
- [x] Mesh: discovery de peers, heartbeat, ping
- [x] Task Engine: submit, decompose, delegate
- [x] Identity Ed25519 (assinar/verificar mensagens)
- [x] Rate limiting + autenticação Bearer
- [x] Service Registry (com cleanup de nodes mortos)
- [x] Deploy webhook (GitHub → auto-update) + deploy remoto
- [x] Monitor/Watchdog (health check periódico + alertas WhatsApp)
- [x] **Metrics** (CPU, RAM, GPU, contadores MCP/mensagens/tasks/HTTP)
- [x] **Terminal** (tmux: sessões, painéis, pane_current_command, capture-pane)
- [x] Endpoint `/api/metrics/sensors` (ponte para o pet)

### tulipa-pet
- [x] 6 necessidades: energia, limpeza, saúde, segurança, humor, social
- [x] 7 moods (radiante → crítico) com expressões visuais
- [x] 6 estágios de evolução (Semente → Floresta)
- [x] Sistema de XP e level
- [x] 30+ achievements em 7+ categorias (incluindo Economia)
- [x] Rede social P2P (amizades, presentes entre pets)
- [x] Notificações WhatsApp em 1a pessoa ("Tô com fome!")
- [x] Resumo diário com seção de economia
- [x] Dashboard web com canvas animado, WebSocket, charts
- [x] **Consome `/api/metrics/sensors`** ao invés de coletar duplicado
- [x] **Terminal como sensor** (pane_current_command → humor/energia)
- [x] **Seção Economia** no dashboard (contadores, barras, tags de impacto)
- [x] **Seção Terminal** no dashboard (painéis tmux em tempo real)

---

## Integração Metrics ↔ Pet (já implementada)

```
tulipa-api                          tulipa-pet
─────────                          ──────────
lib/metrics.js ──────────────────→ api-collector.ts
  CPU, RAM, GPU                      (substitui server-collector.ts)
  Contadores MCP/msgs/tasks
  Picos (watermarks)

lib/terminal.js ─────────────────→ terminal-collector.ts
  Sessões tmux                       pane_current_command → humor
  capture-pane                       Painéis ativos → social
  pane_current_command               Comandos pesados → energia drain

/api/metrics/sensors ────────────→ pet-state.ts
  Formato SensorReadings              mcpErrors → saúde
  Contadores de economia              messagesRouted → social
  Picos                               peakCpu > 80% → estresse
                                      heapUsed > 200MB → limpeza

                                    achievements.ts
                                      economista, workaholic, mensageiro
                                      resiliente, leve_como_pluma
                                      terminal_master
```

---

## O que precisa de revisão / análise

### 1. Qualidade do código
- [ ] server.js tem ~1200 linhas — considerar dividir em módulos
- [ ] Merge conflicts residuais — verificar se todo o fluxo está correto
- [ ] Funções duplicadas entre tulipa-api e tulipa-pet
- [ ] Tratamento de erros — há catch vazio em vários lugares

### 2. Performance e memória
- [ ] rateLimitMap nunca limpa IPs se o servidor rodar por semanas?
- [ ] Queue interval (15s) — é adequado para o volume de mensagens?
- [ ] Histórico do metrics (360 amostras) — quanto de memória isso usa?
- [ ] PeerRegistry + serviceRegistry — dois registros de peers paralelos?

### 3. Segurança
- [ ] CLAUDE.md contém token real (tulipa_2a54...) — deveria ser env var?
- [ ] requireAuth usa comparação simples de string — timing attack?
- [ ] callMcpTool não sanitiza inputs (tool name, args)
- [ ] Webhook deploy aceita qualquer push se DEPLOY_SECRET vazio

### 4. Integração Pet ↔ API
- [ ] api-collector.ts faz fallback silencioso — deveria alertar?
- [ ] Sensores de economia são cumulativos — resetam quando?
- [ ] terminal-collector pode gerar muitas requests se pet tick = 60s
- [ ] Achievements de economia (workaholic, mensageiro) nunca resetam contadores

### 5. Dashboard
- [ ] Dashboard do pet refaz fetch de TUDO a cada state update (performance)
- [ ] Seção economia não tem dados históricos (só snapshot atual)
- [ ] Falta chart de economia ao longo do tempo
- [ ] Dashboard principal (public/index.html) não mostra métricas

### 6. Proposta de economia
- [ ] Definir "economia" formalmente — o que estamos medindo?
- [ ] Custo por mensagem MCP, custo por mensagem WhatsApp
- [ ] Dashboard consolidado rede × pet × economia
- [ ] Alertas de economia (gasto alto, eficiência baixa)
- [ ] Relatório semanal/mensal

---

## Como solicitar a análise

Cole este trecho em uma nova sessão:

```
Analise completamente o projeto Tulipa. Leia:
1. ANALISE-COMPLETA.md (este arquivo)
2. server.js (API principal)
3. lib/metrics.js e lib/terminal.js (novos módulos)
4. tulipa-pet/src/engine/ (pet state, achievements, notifications)
5. tulipa-pet/src/sensors/ (api-collector, terminal-collector, factory)
6. tulipa-pet/src/web/index.html (dashboard)
7. tulipa-pet/src/api/server.ts (API do pet)
8. test/ (testes existentes)

Responda:
- O que está bom e pode ficar como está
- O que precisa ser corrigido urgentemente
- O que pode ser melhorado mas não é urgente
- Proposta detalhada para o sistema de economia
- Plano de ação priorizado (o que fazer primeiro)
```
