#!/bin/bash
# =============================================================================
# Deploy remoto para Servidor 2070 via MCP
# =============================================================================
#
# Executa o setup no Servidor 2070 usando run_command via gateway Tulipa #1.
# Precisa de token com scope admin no 2070.
#
# Uso:
#   ADMIN_TOKEN_2070="tulipa_xxx" ./scripts/deploy-to-2070.sh
#
# =============================================================================

set -e

GATEWAY="https://agent.coolgroove.com.br"
HUB_TOKEN="tulipa_2a541781565121490338aa48fe471474e23615b6c21c2e90"
PEER_ENDPOINT="http://192.168.15.15:18800"

# Token admin do 2070 (deve ser fornecido via env)
ADMIN_TOKEN="${ADMIN_TOKEN_2070:-}"

if [ -z "$ADMIN_TOKEN" ]; then
  echo "Erro: defina ADMIN_TOKEN_2070 com o token admin do Servidor 2070"
  echo ""
  echo "Para obter o token, no terminal do Servidor 2070:"
  echo "  cat ~/.tulipa/api-tokens.yaml"
  echo "  # Copie o token com scope owner ou admin"
  echo ""
  echo "Ou crie um novo:"
  echo "  cd ~/tulipa && node bin/tulipa.js token create --name hub-admin --scopes admin"
  echo ""
  exit 1
fi

GREEN='\033[1;32m'
NC='\033[0m'
log() { echo -e "${GREEN}[deploy-2070]${NC} $1"; }

# Funcao para executar comando no 2070 via MCP
run_on_2070() {
  local cmd="$1"
  local timeout="${2:-30}"

  local result=$(curl -s --max-time $((timeout + 10)) -X POST "$GATEWAY/mcp" \
    -H "Authorization: Bearer $HUB_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"jsonrpc\":\"2.0\",
      \"method\":\"tools/call\",
      \"id\":1,
      \"params\":{
        \"name\":\"run_command\",
        \"arguments\":{
          \"command\":\"curl -s --connect-timeout 5 --max-time $timeout -X POST $PEER_ENDPOINT/mcp -H \\\"Content-Type: application/json\\\" -H \\\"Authorization: Bearer $ADMIN_TOKEN\\\" -d '{\\\"jsonrpc\\\":\\\"2.0\\\",\\\"method\\\":\\\"tools/call\\\",\\\"id\\\":1,\\\"params\\\":{\\\"name\\\":\\\"run_command\\\",\\\"arguments\\\":{\\\"command\\\":\\\"$cmd\\\"}}}' 2>&1\"
        }
      }
    }" 2>&1)

  echo "$result"
}

log "=== Deploy remoto para Servidor 2070 ==="
log ""

# 1. Testar conexao com token admin
log "1. Testando token admin..."
run_on_2070 "echo OK" 10
log ""

# 2. Atualizar codigo
log "2. Atualizando codigo..."
run_on_2070 "cd ~/tulipa && git stash 2>/dev/null; git pull origin main 2>&1 | tail -3" 60
log ""

# 3. Compilar
log "3. Compilando TypeScript..."
run_on_2070 "cd ~/tulipa && npx tsc -p tulipa-core/tsconfig.json && npx tsc -p supervisor/tsconfig.json && npx tsc -p gateway/tsconfig.json && echo COMPILED" 120
log ""

# 4. Hub mode
log "4. Ativando hub mode..."
run_on_2070 "cd ~/tulipa && node bin/tulipa.js network hub enable 2>&1 | tail -3" 30
log ""

# 5. Restart supervisor
log "5. Reiniciando com supervisor..."
run_on_2070 "cd ~/tulipa && node bin/tulipa.js up --skip-build 2>&1 &" 10
log ""

log "=== Deploy concluido ==="
log "Verificar: curl -s $PEER_ENDPOINT/api/health"
