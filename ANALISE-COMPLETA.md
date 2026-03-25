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
- [x] Metrics (CPU, RAM, GPU, contadores MCP/mensagens/tasks/HTTP)
- [x] Terminal (tmux: sessões, painéis, pane_current_command, capture-pane)

### tulipa-pet
- [x] 6 necessidades: energia, limpeza, saúde, segurança, humor, social
- [x] 7 moods (radiante → crítico) com expressões visuais
- [x] 6 estágios de evolução (Semente → Floresta)
- [x] 30+ achievements em 7+ categorias (incluindo Economia)
- [x] Rede social P2P (amizades, presentes entre pets)
- [x] Notificações WhatsApp em 1a pessoa
- [x] Dashboard web com canvas animado, WebSocket, charts

---

## O que precisa de revisão

### Segurança
- [ ] CLAUDE.md contém token real — deveria ser env var
- [ ] requireAuth usa comparação simples de string — timing attack?
- [ ] callMcpTool não sanitiza inputs
- [ ] Webhook deploy aceita qualquer push se DEPLOY_SECRET vazio

### Performance
- [ ] rateLimitMap nunca limpa IPs antigos
- [ ] Dashboard do pet refaz fetch completo a cada update
- [ ] terminal-collector pode gerar muitas requests

### Economia
- [ ] Definir "economia" formalmente
- [ ] Dashboard consolidado rede × pet × economia
- [ ] Relatório semanal/mensal
