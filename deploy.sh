#!/bin/bash
# deploy.sh — Script de deploy para Tulipa API
# Uso: bash deploy.sh [branch]
#
# Pode ser executado:
#   - Localmente no Android (Termux)
#   - Via webhook do GitHub
#   - Via /api/deploy/trigger
#   - Via run_command remoto

set -euo pipefail

BRANCH="${1:-main}"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$APP_DIR/data/deploy.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

log "=== Deploy iniciado ==="
log "Branch: $BRANCH"
log "Dir: $APP_DIR"

cd "$APP_DIR"

# 1. Salva estado atual
BEFORE=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
log "Commit atual: $BEFORE"

# 2. Fetch + Pull
log "Fazendo git pull..."
git fetch origin "$BRANCH" 2>&1 | tee -a "$LOG_FILE"
git checkout "$BRANCH" 2>&1 | tee -a "$LOG_FILE" || true
git pull origin "$BRANCH" 2>&1 | tee -a "$LOG_FILE"

AFTER=$(git rev-parse HEAD)
log "Commit novo: $AFTER"

# 3. Verifica se houve mudança
if [ "$BEFORE" = "$AFTER" ]; then
  log "Nenhuma mudança detectada. Deploy cancelado."
  exit 0
fi

# 4. Instala dependências se package.json mudou
if git diff --name-only "$BEFORE" "$AFTER" | grep -q "package.json"; then
  log "package.json mudou — rodando npm install..."
  npm install --production 2>&1 | tee -a "$LOG_FILE"
else
  log "package.json sem mudanças — skip npm install"
fi

# 5. Roda testes (se disponíveis e não em produção)
if [ "${SKIP_TESTS:-}" != "1" ] && [ -f "test/protocol.test.js" ]; then
  log "Rodando testes..."
  if npm test 2>&1 | tee -a "$LOG_FILE"; then
    log "Testes OK"
  else
    log "AVISO: Testes falharam — deploy continua (verificar manualmente)"
  fi
fi

# 6. Restart da aplicação
if command -v pm2 &>/dev/null; then
  log "Reiniciando via pm2..."
  pm2 restart tulipa-api 2>&1 | tee -a "$LOG_FILE" || pm2 start server.js --name tulipa-api 2>&1 | tee -a "$LOG_FILE"
elif command -v systemctl &>/dev/null && systemctl is-active --quiet tulipa-api; then
  log "Reiniciando via systemctl..."
  sudo systemctl restart tulipa-api 2>&1 | tee -a "$LOG_FILE"
else
  # Termux / bare metal: mata o processo antigo e reinicia
  log "Reiniciando processo Node..."
  pkill -f "node server.js" 2>/dev/null || true
  sleep 1
  nohup node server.js > "$APP_DIR/data/server.log" 2>&1 &
  log "Processo iniciado (PID: $!)"
fi

# 7. Resumo
COMMITS=$(git log --oneline "$BEFORE".."$AFTER" 2>/dev/null | wc -l)
log "=== Deploy concluído ==="
log "Commits aplicados: $COMMITS"
log "De: ${BEFORE:0:8} → Para: ${AFTER:0:8}"

echo "OK"
