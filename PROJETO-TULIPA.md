# Projeto Tulipa — Rede Distribuída de Agentes IA

**Autor:** Tulio Silva (CoolGroove / Teatro Mars)
**Contato:** tcstulio@gmail.com
**Versão:** 0.4.0
**Data de início:** 20 de março de 2026
**Repositório:** github.com/tcstulio/claude
**Hub:** https://agent.coolgroove.com.br
**Atualizado:** 2 de abril de 2026

---

## 1. Visão

Tulipa é uma **rede distribuída de agentes IA** onde qualquer dispositivo — celular, servidor, Raspberry Pi, VPS — se torna um nó autônomo com identidade criptográfica, capaz de oferecer e consumir serviços da rede.

A interface é a conversa. WhatsApp, chat web, API REST, MCP.

Três princípios:
1. **Nada é hardcoded** — infraestrutura entra pela rede, não pelo código
2. **Conhecimento é soberano** — dados privados nunca saem do nó sem permissão
3. **Toda troca é verificável** — recibos assinados por ambas as partes

---

## 2. Estado Atual — O que Existe

### 2.1 Código (tulipa-api)

| Módulo | Arquivos | Função |
|--------|----------|--------|
| **handlers/** | 11 .ts | Rotas HTTP: core, mesh, transport, hub, infra, org, deploy, logs |
| **mesh/** | 9 .ts | MeshManager, federation, crawler, hub-council, log-query |
| **transport/** | 4 .ts | WhatsApp, Telegram, Email, Webhook |
| **ledger/** | 3 .ts | TaskReceipt, Ledger, Dashboard |
| **infra/** | 4 .ts | Scanner, Adopter, Canary, NetworkRoutes |
| **middleware/** | 2 .ts | Scope guard, Token federation |
| **org/** | 2 .ts | OrgRegistry, OrgEconomy |
| **Outros** | 21 .ts | Server, storage, protocol, queue, router, types, etc. |
| **Total** | **56 .ts** | Fonte principal em `lib-ts/` |

### 2.2 Testes

- **301 passando** / 0 falhando / 22 test files
- Framework: Vitest 4.1
- CI: GitHub Actions matrix (Ubuntu, Windows, macOS x Node 22, 24)
- Duração: ~2.5s

### 2.3 Hub Online (Tulipa #1)

| Componente | Valor |
|------------|-------|
| Hardware | Android (Termux) |
| Identidade | `agent_00726da6-5b9e-4d63-afcd-2f04c9572ebc` |
| Endpoint | https://agent.coolgroove.com.br (Cloudflare Tunnel) |
| Uptime | 2+ dias contínuos |
| IP externo | 177.188.7.92 (Telefônica SP) |
| Serviços | Gateway :18800, WhatsApp :18790, Cloudflared, Supervisor |
| Git | 59 commits, branch `main` |

### 2.4 Rede

| Nó | Tipo | Status |
|----|------|--------|
| Tulipa #1 (Hub) | Android/Termux | Online, hub mode |
| Tulipa Agent (Peer) | Desconhecido | Conectado, reputation 50, endorsed |
| Proxmox n97 | Servidor | Configurado, offline (sem endpoint externo) |

### 2.5 Distribuição

| Artefato | Versão |
|----------|--------|
| tulipa-latest.tar.gz | 0.3.3 (build f78bb75) |
| tulipa-0.3.1.tar.gz | Com SHA256 |
| tulipa-0.3.0.tar.gz | Com SHA256 |
| tulipa-0.2.1.tar.gz | Com SHA256 |
| install.sh | Linux/macOS/Termux |
| install.ps1 | Windows |

### 2.6 O que Funciona Hoje

| Feature | Status |
|---------|--------|
| Identidade Ed25519 | ✓ Keypair único, signChallenge/verifyChallenge |
| Peering 3-step | ✓ Request → Response → Confirm |
| Tokens bilaterais | ✓ Cada peer dá e recebe token |
| mDNS Discovery | ✓ LAN broadcast/listen |
| Hub Registry | ✓ Catálogo central, busca por skill |
| Reputação local | ✓ 0-100 por peer, +1/-5 por task |
| Endorsement | ✓ endorsedBy[] no registry |
| Peer Permissions | ✓ skills, dataScopes, rate limit, expiração, canRedelegate |
| Proxy/Failover | ✓ Nó serve tasks de outro offline |
| Task Delegation | ✓ POST /api/tasks + polling |
| Task Decomposition | ✓ Claude decompõe em steps com DAG |
| Agent Card (A2A) | ✓ /.well-known/agent.json |
| QR Code + NFC | ✓ Peering presencial |
| Social Graph | ✓ nodes + edges |
| Provision Node | ✓ SSH + install + Cloudflare tunnel |
| WhatsApp Bridge | ✓ Mensagens, media, contacts, profiles |
| Chat Web | ✓ /chat com streaming |
| Deploy + Rollback | ✓ git pull + tsc, 5 rollbacks |
| Backup automático | ✓ Diário, 7 retenções |
| Health checks | ✓ HTTP + port, auto-restart |
| WebAuthn/Passkeys | ✓ Login biométrico |
| Audit log | ✓ Toda request logada |
| Claim codes | ✓ Convites com aprovação |
| Tarballs SHA256 | ✓ Integridade de deploy |
| Capability detection | ✓ Auto-detecta gpu, ssh, whatsapp, etc. |
| Proxmox client | ✓ CRUD containers (LXC), VMs |

### 2.7 O que foi Implementado (antes listado como "falta")

| Feature | Status |
|---------|--------|
| Gossip discovery | Implementado — BFS crawler, max 3 hops, cache TTL |
| Confiança transitiva | Implementado — trust(A->C) = trust(A->B) x trust(B->C) x 0.7 |
| Federated skill search | Implementado — POST /api/network/query com propagação multi-hop |
| TaskReceipt / Ledger | Implementado — SHA-256 + Ed25519 dual-sign |
| Economia / Créditos | Implementado — Bootstrap credits, ranking composto |
| Separação infra/conhecimento | Implementado — requireScope + resolveScopes middleware |
| Canary autônomo | Implementado — CanaryRunner com LXC efêmero |
| Organizações | Implementado — Policies, invite, accept, roles |
| Logs federados | Implementado — POST /api/network/logs (cross-machine) |
| CI/CD cross-platform | Implementado — GitHub Actions matrix (3 OS x 2 Node) |

### 2.8 O que Falta

| Feature | Status |
|---------|--------|
| Multi-owner | Pendente — Um owner por nó |
| Proxmox como peer | Pendente — Config local, não via rede |
| WebSocket real-time | Pendente — Upgrade de HTTP polling para WS |
| Mais transports | Pendente — Instagram, Discord, Slack |
| Log level estruturado | Pendente — console.log sem nível formal |

---

## 3. Arquitetura de Camadas

A rede tem 3 camadas que **não se misturam**:

### Camada 1: Infraestrutura (pública)

Recursos que qualquer nó anuncia à rede. Público por natureza.

| Recurso | Capability | Exemplo |
|---------|-----------|---------|
| CPU/RAM | `compute` | Proxmox LXC, Docker, bare metal |
| Proxmox VE | `proxmox` | Containers sob demanda |
| GPU | `gpu-compute` | Inference, rendering |
| Storage | `storage` | Backup, cache, artefatos |
| SSH | `ssh-access` | Shell mediado pela rede |
| Network | `relay`, `proxy` | Túnel, proxy entre nós |

**Princípio:** Nenhum recurso é hardcoded. Todo nó entra igual: instalar Tulipa → detectar capabilities → peering → anunciar.

**Adoção de um servidor (Proxmox, VPS, qualquer coisa):**
```
1. Instalar Tulipa no servidor
2. tulipa setup → identidade Ed25519
3. tulipa peer connect <hub-url> → peering
4. detectCapabilities() → ["compute", "proxmox", "ssh-access", "storage"]
5. Hub registra no registry com endpoint externo do peer
6. Rede sabe que este nó existe e o que ele oferece
```

**SSH pela rede (mediado, não exposto):**
```
Nó A quer shell no Nó B
  → task { skill: "ssh-access", request: "ls -la /data" }
  → Rede verifica: allowedSkills inclui "ssh-access"?
  → B executa localmente, retorna resultado
  → TaskReceipt assinado por ambos
```

### Camada 2: Conhecimento (privado)

Dados que pertencem a alguém. Nunca saem sem permissão.

| Dado | dataScope | Acesso |
|------|-----------|--------|
| Clientes, agenda | `contacts` | Owner |
| Financeiro | `financeiro` | Owner |
| Conversas | `messages` | Owner + peers autorizados |
| Config de negócio | `business` | Owner |
| Modelos treinados | `models` | Local |
| Credenciais | — | Nunca exposto |

**Proteção:** `PeerPermissions.dataScopes` — default `[]`, ninguém lê nada.

**Princípio:** Infraestrutura é pública, conhecimento é soberano.

### Camada 3: Economia (verificável)

Toda troca de serviço gera um recibo criptográfico.

#### TaskReceipt

```typescript
interface TaskReceipt {
  id: string;                    // "rcpt_" + hash[:16]
  taskId: string;

  from: string;                  // quem pediu
  to: string;                    // quem executou

  skill: string;
  resultHash: string;            // SHA-256(result) — prova sem expor

  resourceUsed: {
    durationMs: number;
    cpuSeconds?: number;
    memoryMB?: number;
    diskMB?: number;
  };

  timestamp: string;
  hash: string;                  // SHA-256(from + to + taskId + skill + resultHash + timestamp)
  fromSignature: string;         // Ed25519 de quem pediu
  toSignature: string;           // Ed25519 de quem executou
}
```

**Por que funciona:**
- Dupla assinatura = ambas as partes concordam que aconteceu
- `resultHash` prova o trabalho sem expor dados
- Qualquer nó verifica com as public keys (já existem no peering)
- Não é blockchain — é ledger bilateral entre pares de nós

#### Ledger Local

```
~/.tulipa/ledger/
  receipts/        # TaskReceipts (from ou to = eu)
  balance.json     # { "agent_xyz": +50, "agent_abc": -20 }
  summary.json     # totais por skill, earned, spent
```

#### Créditos

```
Novo nó → bootstrap credits (100)
  → Consome tasks da rede (gasta créditos)
  → Executa tasks para outros (ganha créditos)
  → Saldo negativo → prioridade cai
  → Saldo positivo → prioridade sobe

Ranking de delegação = trust × reputation × saldo
```

---

## 4. Plano de Execução

### Sprint 1: Estabilizar Base ✅
- [x] Corrigir 4 testes falhando (task-store ordering, log rotation, backup)
- [x] Build tarball v0.4.0 com SHA256
- [x] Atualizar build-info.json
- [x] Proxmox sem IP hardcoded (✓ feito no código, falta rebuild)

### Sprint 2: TaskReceipt + Ledger ✅
- [x] `lib/ledger/receipt.js` — SHA-256 + Ed25519 dual-sign
- [x] Integrar com signChallenge (Ed25519 compatível)
- [x] Ledger local em `data/ledger/`
- [x] Gerar receipt ao final de cada sendPrompt
- [x] Endpoint `GET /api/ledger` — consultar saldo e receipts
- [x] MCP tool `get_ledger` + `verify_receipt`
- [x] Testes (22 novos)

### Sprint 3: Separação Infra vs Conhecimento ✅
- [x] Novo tipo: `CapabilityCategory = "infra" | "private"`
- [x] Classificar 24 capabilities (14 infra + 10 private)
- [x] Guard em rotas: `requireScope` + `resolveScopes` middleware
- [x] `GET /api/infra` — o que este nó oferece (público, sem auth)
- [x] `GET /api/knowledge` — catálogo do que existe (requer permissão por scope)
- [x] Testes (27 novos)

### Sprint 4: Adoção de Infra ✅
- [x] `POST /api/infra/adopt` — detecta tipo, faz peering, registra
- [x] Proxmox/Docker/Portainer/SSH como peer da rede
- [x] SSH mediado por tasks (`SSHTaskRunner` — sem port forwarding)
- [x] Auto-discovery na LAN (scan Proxmox :8006, Docker :2375, etc.)
- [x] Testes (19 novos)

### Sprint 5: Canary Autônomo ✅
- [x] `CanaryRunner` com workflow completo (pending → testing → passed → promoting)
- [x] Rede decide qual nó roda (ranking por compute + trust + saldo)
- [x] Container LXC efêmero: cria → instala → testa → destrói
- [x] Notificação via WhatsApp/MCP
- [x] Fluxo de promoção com aprovação do owner
- [x] Testes (12 novos)

### Sprint 6: Gossip + Confiança Transitiva ✅
- [x] `GET /api/network/peers/public` — lista pública (sem tokens)
- [x] BFS crawler com visited set, max hops, cache TTL
- [x] Trust transitivo: `trust(A→C) = trust(A→B) × trust(B→C) × 0.7`
- [x] Trust score no ranking de `queryBySkill()`
- [x] Threshold mínimo para delegação (default: 0.3)
- [x] Testes (28 novos)

### Sprint 7: Federated Search + Relay ✅
- [x] `POST /api/network/query` — busca por skill na rede
- [x] Propagação entre hubs com dedup por queryId
- [x] Relay de tasks via hub intermediário
- [x] Rate limiting cross-network (30 queries + 10 relays / min)
- [x] Testes (10 novos)

### Sprint 8: Economia Completa ✅
- [x] Bootstrap credits (100 por nó)
- [x] Ranking composto: trust × reputation × saldo
- [x] Dashboard: saldo, top contribuidores, skills mais usadas
- [x] Disputas: verificação de receipts por terceiro
- [x] Testes (8 novos)

### Sprint 9: Organizações e Governança ✅
- [x] Interface Organization (id, name, owners, members, policies)
- [x] API: `POST /api/org`, invite, accept, policies, remove
- [x] Políticas por org (minTrust, maxHops, votingThreshold, maxMembers)
- [x] Reputação cross-hub (orgReputation, trustBoost)
- [x] Testes (28 novos)

---

## 5. Resumo Técnico

| Métrica | Valor |
|---------|-------|
| Linguagem | TypeScript (ES2022, strict mode) |
| Runtime | Node.js >= 22 |
| Testes | **301 passando** (22 test files, Vitest 4.1) |
| CI/CD | GitHub Actions matrix (Ubuntu, Windows, macOS x Node 22, 24) |
| Rotas HTTP | 100+ endpoints |
| Source | 56 arquivos `.ts` em `lib-ts/` |
| MCP Tools | 13 gateway + 2 locais (get_ledger, verify_receipt) |
| Plataformas | Android (Termux), Linux, macOS, Windows |
| Protocolo | HTTP + Ed25519 + Bearer tokens bilaterais |
| Discovery | mDNS (LAN) + Hub Registry (WAN) + InfraScanner |
| Economia | TaskReceipt (SHA-256 + Ed25519 dual-sign) |
| Trust | Transitivo BFS (decay 0.7, max 3 hops, threshold 0.3) |
| Federation | Busca distribuída + relay via hub intermediário |
| Logs | Federados — query cross-machine via POST /api/network/logs |
| Camadas | Infraestrutura (pública) · Conhecimento (privado) · Economia (verificável) |
| Governança | Organizações com políticas, roles (owner/admin/member) |
| Deploy | git pull, auto-deploy webhook, mesh deploy |
| Licença | Apache-2.0 |

---

## 6. Hash de Registro

Este documento serve como registro do estado do projeto Tulipa na data abaixo.

**Data:** 2026-04-02
**Versão:** 0.4.0
**Testes passando:** 301/301

Para verificar a integridade deste registro, o hash SHA-256 do commit HEAD do repositório pode ser consultado a qualquer momento via:
```bash
curl -s https://agent.coolgroove.com.br/mcp -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"run_command","arguments":{"command":"cd ~/tulipa && git rev-parse HEAD && git log -1 --format=%H"}}}'
```

---

*Registrado por Tulio Silva — CoolGroove / Teatro Mars — 2 de abril de 2026.*
