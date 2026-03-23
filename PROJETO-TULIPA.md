# Projeto Tulipa — Rede Social Distribuída de Agentes IA

**Autor:** Tulio Silva (CoolGroove / Teatro Mars)
**Versão atual:** 0.4.0
**Repositório:** github.com/tcstulio/tulipa (privado)
**Hub:** https://agent.coolgroove.com.br

---

## 1. O que é o Tulipa

Tulipa é uma **plataforma distribuída de agentes IA** que transforma qualquer dispositivo (Android, Linux, Mac, Windows, Raspberry Pi, VPS) num nó autônomo de uma rede mesh. Cada nó tem identidade criptográfica Ed25519, se conecta a peers via handshake de 3 etapas, e oferece suas capacidades (sensores, CPU, GPU, WhatsApp, shell) para a rede.

A interface é a conversa — via WhatsApp, chat web, API REST ou MCP.

---

## 2. Inventário Completo da Plataforma

### 2.1 Módulos (8 pacotes TypeScript, ~37.000 linhas)

| Módulo | Linhas | Função |
|--------|--------|--------|
| **gateway/** | 7.310 | Servidor HTTP puro, 60+ rotas REST + MCP (JSON-RPC 2.0), auth, rate limiter, audit, WebSocket |
| **whatsapp-bridge/** | 13.486 | Baileys, media inbox, contact enrichment, profiles, historico JSONL, self-chat, dossier |
| **tulipa-core/** | 5.750 | CLI (30+ comandos), setup wizard, blueprints, tenant manager, onboarding |
| **network/** | 2.877 | Identidade Ed25519, peering 3-step, mDNS, hub registry, proxy, permissions granulares |
| **task-engine/** | 2.734 | Decomposição de tasks em steps, runner paralelo, delegation, progress tracking |
| **supervisor/** | 2.084 | Gerenciador de processos (systemd-like), health checks, backup, deploy, rollback, diagnóstico IA |
| **rtc/** | 1.551 | WebRTC virtual camera, signaling server, canvas rendering, TTS |
| **termux-shell/** | 998 | Integração Android/Termux, sandbox, sensores, Termux API bridge |

### 2.2 Infraestrutura Atual (Tulipa #1 — Hub)

| Componente | Detalhes |
|------------|----------|
| **Hardware** | Android (Termux) — dispositivo móvel do Tulio |
| **Identidade** | `agent_00726da6-5b9e-4d63-afcd-2f04c9572ebc` |
| **Endpoint** | https://agent.coolgroove.com.br (Cloudflare Tunnel) |
| **Modo** | Hub (nó central da rede) |
| **Uptime** | 2+ dias contínuos |
| **Serviços** | Gateway (:18800), WhatsApp Bridge (:18790), Cloudflared, Supervisor |
| **Git** | Branch `main`, 20 commits, deploy via `git pull + tsc` |

### 2.3 Nós na Rede

| Nó | ID | Tipo | Status |
|----|------|------|--------|
| **Tulipa #1** (Hub) | `agent_007...ebc` | Android/Termux | Online, hub mode |
| **Tulipa Agent** (Peer) | `agent_cd1...765` | Desconhecido | Conectado, reputação 50, endossado |

### 2.4 Serviços Supervisionados (services.yaml)

| Serviço | Porta | Autostart | Health Check |
|---------|-------|-----------|-------------|
| Gateway | 18800 | Sim | HTTP /api/health a cada 30s |
| WhatsApp Bridge | 18790 | Sim | Port check a cada 30s |
| Cloudflared | — | Sim | HTTP externo a cada 60s |
| RTC (WebRTC) | 18850 | Não | HTTP /api/rtc/status |
| SSHD | 8022 | Não | Port check |

### 2.5 APIs Expostas

**Públicas (sem auth):**
- `GET /` — Landing page
- `GET /join` — Portal de onboarding
- `GET /chat` — Chat web
- `GET /api/health` — Health check
- `GET /.well-known/agent.json` — A2A Agent Card
- `GET /llms.txt` — LLM-readable service description
- `POST /api/network/peer/request` — Handshake step 1
- `POST /api/network/peer/confirm` — Handshake step 3
- `GET /install.sh`, `/install.ps1` — Installers
- `GET /tulipa-*.tar.gz` — Tarballs versionados

**Autenticadas (Bearer token):**
- `POST /api/message` — Enviar prompt ao agente
- `POST /mcp` — MCP Server (12 tools)
- `GET /api/status` — Status do sistema
- `GET /api/contacts` — Contatos WhatsApp
- `POST /api/tasks` — Criar task
- `GET /api/network/peers` — Listar peers
- `POST /api/network/peer/initiate` — Iniciar peering
- `GET /api/network/registry` — Hub registry (busca por skill)
- `POST /api/deploy/trigger` — Deploy remoto
- `POST /api/deploy/rollback` — Rollback

### 2.6 MCP Tools (12 tools)

| Tool | Scope | Função |
|------|-------|--------|
| `get_status` | read | Status do sistema |
| `get_network_identity` | read | Identidade do nó |
| `list_peers` | read | Peers conectados |
| `list_tasks` | read | Tasks e progresso |
| `list_tokens` | admin | Tokens ativos |
| `create_token` | admin | Criar token |
| `revoke_token` | admin | Revogar token |
| `run_command` | write | Executar shell |
| `send_prompt` | write | Enviar prompt ao Claude CLI |
| `get_logs` | read | Logs dos serviços |
| `send_whatsapp` | write | Enviar WhatsApp |
| `get_whatsapp_history` | read | Histórico WhatsApp |
| `provision_node` | admin | Instalar Tulipa em host remoto via SSH |

### 2.7 Sistema de Segurança

- **Tokens:** SHA-256 hashed, scopes (`read`, `write`, `admin`), categorias
- **Roles:** `owner` (passphrase scrypt), `admin`, `peer`
- **Peer permissions:** skills permitidas, data scopes, rate limit/hora, expiração, canRedelegate
- **WebAuthn/Passkeys:** Registro e login biométrico
- **Audit log:** Toda request API logada com token, IP, duração
- **Tarball SHA256:** Verificação de integridade nos deploys

### 2.8 Sistema de Rede (o que já existe)

| Feature | Status | Detalhes |
|---------|--------|----------|
| Identidade Ed25519 | Pronto | Keypair único por nó, nunca muda |
| Peering 3-step | Pronto | Request → Response (challenge) → Confirm |
| Tokens bilaterais | Pronto | Cada peer dá e recebe um token |
| mDNS Discovery | Pronto | Broadcast/listen na LAN |
| Hub Registry | Pronto | Catálogo central, busca por skill |
| Reputação local | Pronto | Score 0-100 por peer |
| Endorsement | Pronto | endorsedBy[] / notEndorsedBy[] no registry |
| Peer Permissions | Pronto | Skills, data scopes, rate limit, expiração |
| Proxy/Failover | Pronto | Um nó serve tasks de outro quando offline |
| Task Delegation | Pronto | POST /api/tasks em peer remoto com polling |
| Agent Card (A2A) | Pronto | /.well-known/agent.json standard |
| QR Code + NFC | Pronto | Peering presencial via scan/tap |
| Social Graph | Pronto | getGraph() retorna nodes + edges |
| Provision Node | Pronto | SSH + install + Cloudflare tunnel automático |

---

## 3. O que falta — Roadmap para Rede Social Completa

### Fase 1: Gossip Discovery (conhecer 1 = conhecer todos)

**Problema:** Hoje cada nó só conhece seus peers diretos. Não há propagação.

**Solução:** BFS crawl recursivo pela rede.

```
Novo MCP tool: discover_network
Novo endpoint: GET /api/network/peers/public (retorna peers sem tokens)

Fluxo:
1. Nó A chama list_peers local → Peer B (com endpoint)
2. Nó A chama GET /api/network/peers/public em B → Peers C, D
3. Nó A chama o mesmo em C → Peers E, F
4. Repete até visited set parar de crescer
5. Registra tudo no hub registry local
```

**Regras de propagação:**
- Peers só expõem lista pública (nome, endpoint, skills) — nunca tokens
- Cada nó decide se quer ser listável (`discoverable: true/false` na config)
- Profundidade máxima configurável (default: 3 hops)
- Cache com TTL (default: 1 hora)

### Fase 2: Confiança Transitiva (Web of Trust)

**Problema:** Reputação é local. Se A confia em B e B confia em C, A não sabe nada sobre C.

**Solução:** Trust score transitivo com decay.

```typescript
// Fórmula
trust(A→C) = trust(A→B) × trust(B→C) × DECAY_FACTOR

// Onde:
// trust(X→Y) = peer.reputation / 100 (normalizado 0-1)
// DECAY_FACTOR = 0.7 por hop (configurable)

// Exemplo:
// A→B = 0.9 (reputation 90)
// B→C = 0.8 (reputation 80)
// A→C = 0.9 × 0.8 × 0.7 = 0.504 (trust indireto)
```

**Implementação:**
- Novo campo `transitiveTrust: number` no HubEntry
- Cálculo feito durante gossip discovery
- Trust score influencia ranking no `queryBySkill()`
- Threshold mínimo para delegação automática (default: 0.3)

### Fase 3: Marketplace de Skills (federated search)

**Problema:** `queryBySkill()` só busca localmente no hub registry.

**Solução:** Propagação de queries pela rede.

```
Nó A precisa de skill "gpu-compute"
→ Busca local: não tem
→ Pergunta ao Hub: não tem
→ Hub propaga para peers que são hubs: Hub B responde
→ Hub B tem Nó X com GPU disponível
→ Nó A delega task para Nó X via Hub B (relay)
```

**Novo endpoint:** `POST /api/network/query`
```json
{
  "skill": "gpu-compute",
  "maxHops": 3,
  "minTrust": 0.3,
  "budget": { "maxTasksPerHour": 5 }
}
```

### Fase 4: Propriedade e Governança

**O que já existe:** Owner com passphrase, roles (owner/admin/peer), peer permissions.

**O que falta:**

1. **Multi-owner:** Mais de uma pessoa pode ser owner de um nó
2. **Organizações:** Agrupar nós sob uma entidade (CoolGroove, Teatro Mars)
3. **Delegação de governança:** Owner delega admin a outro nó/pessoa
4. **Votação:** Decisões da rede (aceitar novo hub, banir nó) por consenso
5. **Reputação cross-hub:** Hubs trocam endorsements com peso reduzido

```typescript
interface Organization {
  id: string;           // "org_" + UUID
  name: string;         // "CoolGroove"
  owners: string[];     // identity IDs com poder de voto
  members: string[];    // identity IDs dos nós membros
  policies: {
    autoAcceptPeering: boolean;
    minTrustForDelegation: number;
    maxHopsForDiscovery: number;
    votingThreshold: number; // % de owners para aprovar ação
  };
}
```

### Fase 5: Economia de Serviços

**Conceito:** Nós oferecem recursos (GPU, storage, bandwidth, skills especializadas) e consomem recursos de outros. Um sistema de créditos/karma.

```typescript
interface ServiceLedger {
  nodeId: string;
  credits: number;        // saldo atual
  earned: number;         // total ganho (servindo tasks)
  spent: number;          // total gasto (delegando tasks)
  history: LedgerEntry[];
}

interface LedgerEntry {
  timestamp: string;
  type: "earned" | "spent";
  amount: number;
  taskId: string;
  peerId: string;
  skill: string;
}
```

**Regras:**
- Cada task delegada custa créditos proporcionais ao recurso
- Servir tasks ganha créditos
- Nós novos começam com créditos iniciais (bootstrap)
- Nós com saldo negativo perdem prioridade no ranking
- Sem blockchain — ledger distribuído com consenso entre hubs

---

## 4. Nó de Testes (Canary Node)

### Conceito

Um nó dedicado a testar novas versões do Tulipa antes de fazer deploy no hub principal. O fluxo:

```
Developer (push) → GitHub main
                      ↓
              Canary Node (auto-pull)
                      ↓
              Roda testes + health check
                      ↓
              Se OK → notifica owner
                      ↓
              Owner aprova → deploy no Hub
```

### Como implementar

**Opção A: Nó Linux/VPS separado**
- Provisionar via `provision_node` (já existe no MCP)
- Configurar como child do Hub com `relation: "child"`, `nodeType: "compute"`
- Deploy automático: cron ou webhook que faz `git pull + build + test`

**Opção B: Container no mesmo device**
- proot/chroot no Termux com ambiente isolado
- Branch `canary` no git — hub roda `main`, canary roda `canary`

**Opção C: Segundo device Android**
- Instalar Tulipa num celular antigo
- Peering com hub, role `canary`

### Configuração do Canary

```yaml
# services.yaml do canary node
deploy:
  repo_dir: /home/tulipa/tulipa
  branch: main              # sempre tracking main
  pre_deploy: git stash
  deploy_command: git pull origin main
  post_deploy: npm run build && npm test
  auto_deploy: true          # NOVO: pull automático a cada N minutos
  auto_deploy_interval: 5    # NOVO: a cada 5 minutos
  notify_on_success: true    # NOVO: notifica hub quando deploy OK
  notify_on_failure: true    # NOVO: notifica hub quando falha
  rollback_keep: 5

canary:
  enabled: true
  hub_endpoint: https://agent.coolgroove.com.br
  hub_token: <token do hub>
  test_command: npm test
  health_check_after_deploy: true
  promote_command: |          # Comando para promover para o hub
    curl -X POST https://agent.coolgroove.com.br/api/deploy/trigger \
      -H "Authorization: Bearer <admin_token>" \
      -H "Content-Type: application/json" \
      -d '{"source": "canary", "commit": "$COMMIT"}'
```

### Fluxo de Promoção

```
1. Push para main no GitHub
2. Canary detecta (polling ou webhook)
3. git pull + build
4. npm test (163 testes)
5. Health check nos serviços
6. Se tudo OK:
   - Notifica owner via WhatsApp: "v0.4.1 testada com sucesso no canary"
   - Owner responde "promover" (ou auto-promote se configurado)
   - Canary chama POST /api/deploy/trigger no Hub
   - Hub faz deploy (git pull + build + restart)
   - Hub confirma health → notifica owner
7. Se falha:
   - Notifica owner: "v0.4.1 falhou: 3 testes quebraram"
   - Canary faz rollback automático
   - Hub NÃO é afetado
```

---

## 5. Plano de Execução

### Sprint 1: Canary Node (esta semana)
- [ ] Provisionar nó canary (VPS ou segundo device)
- [ ] Adicionar campos `canary` no services.yaml
- [ ] Implementar auto-deploy com intervalo
- [ ] Implementar notify via WhatsApp/MCP após deploy
- [ ] Implementar health check pós-deploy
- [ ] Testar ciclo completo: push → canary → promote → hub

### Sprint 2: Gossip Discovery
- [ ] Novo endpoint `GET /api/network/peers/public`
- [ ] Novo MCP tool `discover_network`
- [ ] BFS crawler com visited set e max hops
- [ ] Merge de descobertas no hub registry
- [ ] Config `discoverable: true/false`
- [ ] Testes

### Sprint 3: Confiança Transitiva
- [ ] Campo `transitiveTrust` no HubEntry
- [ ] Cálculo durante gossip com decay factor
- [ ] Trust score no ranking de `queryBySkill()`
- [ ] Threshold mínimo para delegação
- [ ] Testes

### Sprint 4: Federated Skill Search
- [ ] Endpoint `POST /api/network/query`
- [ ] Propagação de queries entre hubs
- [ ] Relay de tasks via hub intermediário
- [ ] Rate limiting cross-network
- [ ] Testes

### Sprint 5: Organizações e Multi-owner
- [ ] Modelo Organization
- [ ] CLI: `tulipa org create`, `tulipa org invite`
- [ ] Políticas de governança por org
- [ ] Reputação cross-hub
- [ ] Testes

### Sprint 6: Economia de Serviços
- [ ] Service Ledger
- [ ] Contabilidade de créditos por task
- [ ] Bootstrap credits para novos nós
- [ ] Dashboard de economia
- [ ] Testes

---

## 6. Resumo Técnico

| Métrica | Valor |
|---------|-------|
| Linguagem | TypeScript (ESM) |
| Runtime | Node.js ≥20 |
| Linhas de código | ~37.000 |
| Testes | 163 |
| Módulos | 8 |
| Rotas API | 60+ |
| MCP Tools | 13 |
| Plataformas | Android, Linux, macOS, Windows |
| Protocolo de rede | HTTP + Ed25519 + Bearer tokens |
| Discovery | mDNS (LAN) + Hub Registry (WAN) + QR/NFC (presencial) |
| Deploy | git pull + tsc, rollback, tarballs SHA256 |
| Backup | Diário, 7 retenções, WhatsApp auth + contacts + history |

---

*Documento gerado em 2026-03-23 por análise completa do codebase Tulipa v0.4.0.*
