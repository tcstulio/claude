# Tulipa

Rede distribuida de agentes IA onde qualquer dispositivo se torna um no autonomo com identidade criptografica.

**Autor:** Tulio Silva (CoolGroove / Teatro Mars)
**Hub:** https://agent.coolgroove.com.br

## Quick Start

```bash
# Instalar dependencias
npm install

# Rodar testes
npm test

# Iniciar servidor
npm start

# Modo desenvolvimento (watch)
npm run dev
```

## Arquitetura

```
lib-ts/
  server.ts           # Express app principal (100+ endpoints)
  handlers/            # Rotas HTTP (11 modulos)
  mesh/                # Rede P2P (discovery, federation, logs federados)
  transport/           # WhatsApp, Telegram, Email, Webhook
  ledger/              # TaskReceipt + economia (SHA-256 + Ed25519)
  infra/               # Scanner, adoption, canary
  middleware/          # Auth, scope guard, token federation
  org/                 # Organizacoes e governanca

test/                  # 22 test files, 301 testes (Vitest)
.github/workflows/     # CI matrix (Ubuntu, Windows, macOS)
```

## Camadas

| Camada | Escopo | Exemplo |
|--------|--------|---------|
| **Infraestrutura** | Publica | CPU, GPU, storage, SSH, relay |
| **Conhecimento** | Privado | Contatos, financeiro, conversas |
| **Economia** | Verificavel | TaskReceipts com dupla assinatura Ed25519 |

## Endpoints Principais

| Categoria | Endpoint | Descricao |
|-----------|----------|-----------|
| Health | `GET /api/health` | Status do gateway |
| Mesh | `GET /api/mesh/peers` | Peers conhecidos |
| Prompt P2P | `POST /api/mesh/prompt/:nodeId` | Enviar prompt a peer |
| Logs | `POST /api/network/logs` | Logs federados (todas as maquinas) |
| Federation | `POST /api/network/query` | Busca por skill na rede |
| Ledger | `GET /api/ledger/balance` | Saldo do no |
| Deploy | `POST /api/deploy/trigger` | Deploy manual |

Documentacao completa dos endpoints em `CLAUDE.md`.

## Testes

```bash
# Unitarios (Vitest)
npm test

# Watch mode
npm run test:watch

# TypeScript check
npm run typecheck

# E2E manual
npm run test:manual
```

### CI/CD

GitHub Actions roda testes automaticamente em:
- **OS:** Ubuntu, Windows, macOS
- **Node.js:** 22, 24

Workflow: `.github/workflows/test.yml`

## Scripts

| Comando | Descricao |
|---------|-----------|
| `npm start` | Iniciar servidor (porta 3000) |
| `npm run dev` | Modo watch |
| `npm test` | Rodar testes |
| `npm run build` | Compilar TypeScript |
| `npm run typecheck` | Verificar tipos |
| `npm run clean` | Limpar dist/ |

## Documentacao

| Arquivo | Conteudo |
|---------|---------|
| `CLAUDE.md` | Endpoints, tokens, MCP tools, regras |
| `PROGRESS.md` | Historico de desenvolvimento |
| `PROJETO-TULIPA.md` | Arquitetura completa, visao, economia |
| `PROJETO-TULIPA-MESH.md` | Detalhes da rede mesh P2P |

## Licenca

Apache-2.0
