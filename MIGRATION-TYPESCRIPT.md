# Opção C — Migração para TypeScript (Integração Nativa no Gateway)

## Objetivo

Migrar todos os módulos desenvolvidos em JavaScript (CommonJS) para TypeScript (ESM),
integrando-os diretamente no monorepo Tulipa como pacotes nativos do gateway.

**Resultado final:** Um único servidor, uma única porta, zero proxy.

---

## 1. Estrutura Atual do Monorepo Tulipa

```
~/tulipa/
├── gateway/          # API gateway (TypeScript ESM, http nativo)
│   └── src/
│       ├── router.ts       # Roteamento URL-based (if/else)
│       ├── handlers/       # Handlers por domínio
│       ├── middleware.ts    # Auth, CORS, helpers
│       ├── auth.ts         # Tokens + validação
│       └── permissions.ts  # Contexto de request
├── network/          # Identity, peering, registry (TypeScript ESM)
│   └── src/
│       ├── identity.ts     # Ed25519 keypair (SPKI/PKCS8 DER base64)
│       ├── peering.ts      # Peering bilateral
│       ├── registry.ts     # Registry de peers
│       └── types.ts        # Tipos compartilhados
├── task-engine/      # Tasks, skills, delegation
│   └── src/
│       ├── task-runner.ts
│       ├── task-store.ts
│       ├── task-delegation.ts
│       └── skills/
├── tulipa-core/      # Core do agente
├── supervisor/       # Process manager
├── whatsapp-bridge/  # WhatsApp integration
├── rtc/              # Real-time communication
└── termux-shell/     # Termux-specific
```

## 2. Módulos a Migrar

### De `claude/lib/` para `~/tulipa/`

| Módulo JS (atual) | Pacote TS (destino) | Prioridade |
|---|---|---|
| `lib/ledger/receipt.js` | `task-engine/src/receipt.ts` | P1 |
| `lib/ledger/ledger.js` | `task-engine/src/ledger.ts` | P1 |
| `lib/ledger/dashboard.js` | `gateway/src/handlers/economy.ts` | P2 |
| `lib/mesh/trust.js` | `network/src/trust.ts` | P1 |
| `lib/mesh/crawler.js` | `network/src/crawler.ts` | P2 |
| `lib/mesh/federation.js` | `network/src/federation.ts` | P2 |
| `lib/capabilities.js` | `network/src/capabilities.ts` | P1 |
| `lib/middleware/scope-guard.js` | `gateway/src/scope-guard.ts` | P1 |
| `lib/local-tools.js` | `gateway/src/handlers/local-mcp.ts` | P3 |
| `lib/infra/scanner.js` | `network/src/infra-scanner.ts` | P3 |
| `lib/infra/adopt.js` | `network/src/infra-adopt.ts` | P3 |
| `lib/infra/ssh-task.js` | `task-engine/src/ssh-task.ts` | P3 |
| `lib/infra/canary.js` | `task-engine/src/canary.ts` | P3 |
| `lib/org/organization.js` | `network/src/organization.ts` | P2 |
| `lib/org/org-registry.js` | `network/src/org-registry.ts` | P2 |

## 3. Plano de Execução

### Fase 1: Tipos e Interfaces (P1)

Criar `network/src/types.ts` e `task-engine/src/types.ts` com os tipos:

```typescript
// network/src/types.ts (adicionar)
export type CapabilityCategory = "infra" | "private";

export interface CapabilityInfo {
  name: string;
  category: CapabilityCategory;
  scope: string | null;
}

export interface TrustEntry {
  score: number;         // 0.0 a 1.0
  reason: string;
  updatedAt: number;
}

export interface TrustConfig {
  defaultTrust: number;
  transitiveDecay: number;
  delegationThreshold: number;
  maxHops: number;
}

export interface DelegationRanking {
  peer: { nodeId: string; name: string };
  score: number;
  trust: number;
  balanceFactor: number;
  eligible: boolean;
}

// task-engine/src/types.ts (adicionar)
export interface TaskReceipt {
  id: string;                    // "rcpt_" + hash[:16]
  taskId: string;
  from: string;
  to: string;
  skill: string;
  resultHash: string;            // SHA-256(result)
  resourceUsed: {
    durationMs: number;
    cpuSeconds?: number;
    memoryMB?: number;
    diskMB?: number;
  };
  timestamp: string;
  hash: string;                  // SHA-256(canonical fields)
  fromSignature: string | null;  // Ed25519
  toSignature: string | null;    // Ed25519
}

export interface LedgerBalance {
  credits: number;
  earned: number;
  spent: number;
  bootstrap: number;
  byPeer: Record<string, number>;
}

export interface Organization {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  policies: OrgPolicies;
}

export interface OrgPolicies {
  minTrust: number;
  maxHops: number;
  votingThreshold: number;
  allowedScopes: string[];
  maxMembers: number;
  requireApproval: boolean;
}
```

### Fase 2: Migrar módulos core (P1)

1. **`network/src/capabilities.ts`**
   - Copiar lógica de `lib/capabilities.js`
   - Adicionar tipos TypeScript
   - Exportar via `network/src/index.ts`

2. **`network/src/trust.ts`**
   - Copiar `TrustGraph` de `lib/mesh/trust.js`
   - Usar `AgentIdentity` e `PeerInfo` existentes do network
   - Integrar com `signChallenge()` de `identity.ts`

3. **`task-engine/src/receipt.ts`**
   - Copiar lógica de `lib/ledger/receipt.js`
   - Usar `signChallenge()`/`verifyChallenge()` do identity.ts
   - Integrar com `TaskResult` existente do task-engine

4. **`task-engine/src/ledger.ts`**
   - Copiar `Ledger` de `lib/ledger/ledger.js`
   - Persistir em `~/.tulipa/ledger/`
   - Integrar com `task-runner.ts` para gerar receipts

5. **`gateway/src/scope-guard.ts`**
   - Adaptar para HTTP nativo (não Express)
   - Integrar com `auth.ts` e `permissions.ts` existentes

### Fase 3: Handlers do Gateway (P2)

6. **`gateway/src/handlers/economy.ts`**
   - Dashboard, disputas, ranking
   - Rotas: `/api/economy/*`

7. **`gateway/src/handlers/org.ts`**
   - CRUD de organizações
   - Rotas: `/api/org/*`

8. **`network/src/crawler.ts`** + **`network/src/federation.ts`**
   - Crawl BFS + busca federada
   - Rotas: `/api/network/query`, `/api/network/crawl`

### Fase 4: Infra e Canary (P3)

9. **`network/src/infra-scanner.ts`** + **`network/src/infra-adopt.ts`**
10. **`task-engine/src/ssh-task.ts`** + **`task-engine/src/canary.ts`**

### Fase 5: Rotas no Router

Adicionar no `gateway/src/router.ts`:

```typescript
// Economy
if (path === "/api/economy/dashboard" && method === "GET") return handleEconomyDashboard(req, res);
if (path === "/api/economy/dispute" && method === "POST") return handleEconomyDispute(req, res);
if (path === "/api/economy/ranking" && method === "GET") return handleEconomyRanking(req, res);

// Ledger
if (path === "/api/ledger" && method === "GET") return handleLedgerSummary(req, res);
if (path === "/api/ledger/balance" && method === "GET") return handleLedgerBalance(req, res);
if (path === "/api/ledger/receipts" && method === "GET") return handleLedgerReceipts(req, res);
if (path === "/api/ledger/verify" && method === "POST") return handleLedgerVerify(req, res);

// Trust & Network
if (path === "/api/network/trust" && method === "GET") return handleNetworkTrust(req, res);
if (path.startsWith("/api/network/rank/") && method === "GET") return handleNetworkRank(req, res);
if (path === "/api/network/query" && method === "POST") return handleNetworkQuery(req, res);
if (path === "/api/network/relay" && method === "POST") return handleNetworkRelay(req, res);

// Capabilities
if (path === "/api/infra" && method === "GET") return handleInfra(req, res);
if (path === "/api/capabilities" && method === "GET") return handleCapabilities(req, res);
if (path === "/api/knowledge" && method === "GET") return handleKnowledge(req, res);

// Org
if (path === "/api/org" && method === "GET") return handleOrgList(req, res);
if (path === "/api/org" && method === "POST") return handleOrgCreate(req, res);
// ... etc
```

## 4. Compatibilidade

### Ed25519 — 100% compatível
O `identity.ts` usa exatamente o mesmo formato:
- SPKI DER base64 (public key)
- PKCS8 DER base64 (private key)
- `crypto.sign(null, data, privateKey)` para Ed25519

### Persistência
- Ledger: `~/.tulipa/ledger/` (mesmo formato JSON)
- Orgs: `~/.tulipa/network/orgs.json`
- Trust: em memória + recalculado na inicialização

### Build
Adicionar ao script `build` do `package.json` raiz:
```json
"build": "cd task-engine && npx tsc && cd ../network && npx tsc && ..."
```
(já incluído — basta adicionar os novos arquivos ao `tsconfig.json` de cada pacote)

## 5. Testes

Migrar de `node:test` para `vitest` (já usado no monorepo):

```bash
# Monorepo usa vitest
npx vitest run
```

Converter os 238 testes existentes para a sintaxe vitest:
```typescript
// De:
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Para:
import { describe, it, expect } from 'vitest';
```

## 6. Estimativa

| Fase | Arquivos | Complexidade |
|---|---|---|
| 1: Tipos | 2 | Baixa |
| 2: Core (trust, receipt, ledger, capabilities) | 5 | Média |
| 3: Handlers (economy, org, federation) | 4 | Média |
| 4: Infra + Canary | 4 | Média |
| 5: Router + testes | 2 | Baixa |

## 7. Riscos

1. **Conflito com código existente do gateway** — o router já tem muitas rotas. Verificar colisão de paths.
2. **ESM vs CommonJS** — monorepo é ESM (`"type": "module"`). Todos os `require()` viram `import`.
3. **Memória no Android** — mais código = mais RAM. Monitorar uso.
4. **Breaking changes no network/** — se alterar tipos do `registry.ts` pode quebrar peering existente.

## 8. Ordem de Execução Recomendada

```
1. Criar tipos (types.ts) — sem quebrar nada
2. capabilities.ts — standalone, sem dependências
3. trust.ts — depende apenas de types
4. receipt.ts + ledger.ts — depende de identity.ts (já existe)
5. Handlers do gateway — depende dos módulos acima
6. Router — adicionar rotas
7. Testes vitest
8. Build + deploy
9. Remover proxy e tulipa-mesh
```
