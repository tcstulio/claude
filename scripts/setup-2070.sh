#!/bin/bash
# =============================================================================
# Setup Servidor 2070 — Paridade com Tulipa #1
# =============================================================================
#
# Este script traz o Servidor 2070 para paridade com o Tulipa #1.
# Pode ser executado remotamente via run_command (precisa token admin)
# ou diretamente no terminal do Windows (Git Bash / PowerShell).
#
# Uso remoto (via MCP do Tulipa #1):
#   run_command: "bash ~/tulipa/scripts/setup-2070.sh"
#
# Uso local (no Windows):
#   bash scripts/setup-2070.sh
#   # ou via PowerShell:
#   .\start.ps1 setup
#
# Requisitos:
#   - Node.js v24+
#   - Git configurado com acesso ao repo tulipa
#   - Tulipa clonado em ~/tulipa
# =============================================================================

set -e

TULIPA_DIR="${HOME}/tulipa"
TULIPA_CONFIG="${HOME}/.tulipa"
YELLOW='\033[1;33m'
GREEN='\033[1;32m'
RED='\033[1;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[setup]${NC} $1"; }
warn() { echo -e "${YELLOW}[setup]${NC} $1"; }
err()  { echo -e "${RED}[setup]${NC} $1"; }

# --- 1. Verificar pre-requisitos ---
log "Verificando pre-requisitos..."

if ! command -v node &>/dev/null; then
  err "Node.js nao encontrado. Instale v24+ e tente novamente."
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
log "Node.js v$(node -v | sed 's/v//')"

if ! command -v git &>/dev/null; then
  err "Git nao encontrado."
  exit 1
fi

# --- 2. Atualizar codigo ---
log "Atualizando codigo do Tulipa..."
cd "$TULIPA_DIR"

# Salvar mudancas locais
git stash 2>/dev/null || true

# Puxar ultima versao
git pull origin main 2>&1 || {
  warn "git pull falhou. Verificar acesso ao repo."
}

VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "?")
COMMIT=$(git log --oneline -1 2>/dev/null || echo "?")
log "Versao: $VERSION ($COMMIT)"

# --- 3. Compilar TypeScript ---
log "Compilando modulos..."
MODULES="tulipa-core whatsapp-bridge termux-shell supervisor gateway network"
for mod in $MODULES; do
  if [ -d "$mod" ] && [ -f "$mod/tsconfig.json" ]; then
    log "  Compilando $mod..."
    cd "$TULIPA_DIR/$mod"
    npx tsc 2>&1 || warn "  $mod: compilacao com warnings"
  fi
done
cd "$TULIPA_DIR"

# --- 4. Criar diretorios ---
log "Criando diretorios de config..."
mkdir -p "$TULIPA_CONFIG/logs"
mkdir -p "$TULIPA_CONFIG/backups"
mkdir -p "$TULIPA_CONFIG/network"

# --- 5. Copiar services.yaml se nao existir ---
if [ ! -f "$TULIPA_CONFIG/services.yaml" ]; then
  log "Criando services.yaml..."
  # Gera o default via supervisor
  node -e "
    const { loadSupervisorConfig } = require('./supervisor/dist/config.js');
    loadSupervisorConfig('$TULIPA_CONFIG/services.yaml');
  " 2>/dev/null || {
    warn "Geracao automatica falhou. Usando template."
    # Fallback: copiar template se existir no repo
    if [ -f "$TULIPA_DIR/config/services-windows.yaml" ] 2>/dev/null; then
      cp "$TULIPA_DIR/config/services-windows.yaml" "$TULIPA_CONFIG/services.yaml"
    fi
  }
  log "services.yaml criado em $TULIPA_CONFIG/services.yaml"
else
  log "services.yaml ja existe, mantendo."
fi

# --- 6. Ativar hub mode ---
log "Ativando hub mode..."
node bin/tulipa.js network hub enable 2>&1 || {
  warn "Hub mode: comando falhou (pode ja estar ativo)"
}

# --- 7. Verificar identidade ---
log "Verificando identidade..."
if [ -f "$TULIPA_CONFIG/network/identity.json" ]; then
  AGENT_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TULIPA_CONFIG/network/identity.json','utf8')).id)" 2>/dev/null)
  HUB_MODE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TULIPA_CONFIG/network/identity.json','utf8')).hubMode)" 2>/dev/null)
  log "  Agent ID: $AGENT_ID"
  log "  Hub Mode: $HUB_MODE"
else
  warn "Identidade nao encontrada. Inicialize com: tulipa network init"
fi

# --- 8. Resumo ---
echo ""
log "========================================="
log "Setup concluido!"
log "========================================="
log ""
log "Versao:     $VERSION"
log "Commit:     $COMMIT"
log "Config:     $TULIPA_CONFIG/services.yaml"
log "Agent ID:   ${AGENT_ID:-nao inicializado}"
log "Hub Mode:   ${HUB_MODE:-desconhecido}"
log ""
log "Proximo passo: iniciar o supervisor"
log "  node bin/tulipa.js up"
log ""
log "Ou no Windows PowerShell:"
log "  .\\start.ps1 up"
log ""
