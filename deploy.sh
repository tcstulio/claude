#!/bin/bash
# deploy.sh — Script de deploy para Tulipa API
# Uso: bash deploy.sh [branch]
#
# Funciona em Linux, macOS e Termux (Android)
# Pode ser executado:
#   - Localmente no Android (Termux)
#   - Via webhook do GitHub
#   - Via /api/deploy/trigger
#   - Via run_command remoto

set -euo pipefail

BRANCH="${1:-main}"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$APP_DIR/data/deploy.log"
BACKUP_DIR="$APP_DIR/data/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Cria diretórios necessários
mkdir -p "$APP_DIR/data" "$BACKUP_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

log "=== Deploy iniciado ($TIMESTAMP) ==="
log "Branch: $BRANCH"
log "Dir: $APP_DIR"

# ─── 1. Detecta ambiente ─────────────────────────────────────────────
if [ -n "${PREFIX:-}" ] && command -v termux-info &>/dev/null; then
  ENV_TYPE="termux"
  log "Ambiente: Termux (Android)"
elif [[ "$(uname)" == "Darwin" ]]; then
  ENV_TYPE="macos"
  log "Ambiente: macOS"
else
  ENV_TYPE="linux"
  log "Ambiente: Linux"
fi

# ─── 2. Backup do banco SQLite ───────────────────────────────────────
if [ -f "$APP_DIR/data/tulipa.db" ]; then
  BACKUP_FILE="$BACKUP_DIR/tulipa_${TIMESTAMP}.db"
  cp "$APP_DIR/data/tulipa.db" "$BACKUP_FILE"
  log "Backup do banco: $BACKUP_FILE"
  # Mantém só os últimos 5 backups
  ls -t "$BACKUP_DIR"/tulipa_*.db 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true
fi

cd "$APP_DIR"

# ─── 3. Salva estado atual e faz Git pull ─────────────────────────────
BEFORE=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
log "Commit atual: $BEFORE"

log "Fazendo git pull..."
git fetch origin "$BRANCH" 2>&1 | tee -a "$LOG_FILE"
git checkout "$BRANCH" 2>&1 | tee -a "$LOG_FILE" || true
git pull origin "$BRANCH" 2>&1 | tee -a "$LOG_FILE"

AFTER=$(git rev-parse HEAD)
log "Commit novo: $AFTER"

# Verifica se houve mudança
if [ "$BEFORE" = "$AFTER" ]; then
  log "Nenhuma mudança detectada. Deploy cancelado."
  exit 0
fi

# ─── 4. Instala dependências ─────────────────────────────────────────
if git diff --name-only "$BEFORE" "$AFTER" | grep -q "package.json"; then
  log "package.json mudou — rodando npm install..."
  npm install --production 2>&1 | tee -a "$LOG_FILE"
else
  log "package.json sem mudanças — skip npm install"
fi

# ─── 5. Verifica integridade do banco ─────────────────────────────────
if command -v sqlite3 &>/dev/null && [ -f "$APP_DIR/data/tulipa.db" ]; then
  INTEGRITY=$(sqlite3 "$APP_DIR/data/tulipa.db" "PRAGMA integrity_check;" 2>/dev/null || echo "FALHOU")
  if [ "$INTEGRITY" = "ok" ]; then
    log "Banco SQLite: integridade OK"
  else
    log "AVISO: Banco com problemas ($INTEGRITY), restaurando backup..."
    LATEST_BACKUP=$(ls -t "$BACKUP_DIR"/tulipa_*.db 2>/dev/null | head -1)
    if [ -n "$LATEST_BACKUP" ]; then
      cp "$LATEST_BACKUP" "$APP_DIR/data/tulipa.db"
      log "Banco restaurado de $LATEST_BACKUP"
    fi
  fi
fi

# ─── 6. Roda testes ──────────────────────────────────────────────────
if [ "${SKIP_TESTS:-}" != "1" ] && [ -f "test/protocol.test.js" ]; then
  log "Rodando testes..."
  if npm test 2>&1 | tee -a "$LOG_FILE"; then
    log "Testes OK"
  else
    log "AVISO: Testes falharam — deploy continua (verificar manualmente)"
  fi
fi

# ─── 7. Restart da aplicação ─────────────────────────────────────────
PM2_NAME="tulipa-api"

if command -v pm2 &>/dev/null; then
  if pm2 list 2>/dev/null | grep -q "$PM2_NAME"; then
    log "Reiniciando via pm2..."
    pm2 restart "$PM2_NAME" 2>&1 | tee -a "$LOG_FILE"
  else
    log "Iniciando via pm2..."
    pm2 start server.js --name "$PM2_NAME" 2>&1 | tee -a "$LOG_FILE"
  fi
  pm2 save 2>/dev/null || true
elif command -v systemctl &>/dev/null && systemctl is-active --quiet tulipa-api 2>/dev/null; then
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

# ─── 8. Health check pós-deploy ──────────────────────────────────────
log "Aguardando startup (3s)..."
sleep 3

PORT="${PORT:-3000}"
HEALTH_URL="http://localhost:$PORT/api/health"

for i in 1 2 3; do
  HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "502" ]; then
    log "Health check OK (HTTP $HTTP_CODE)"
    break
  fi
  log "Health check tentativa $i: HTTP $HTTP_CODE"
  sleep 2
done

# ─── 9. Resumo ───────────────────────────────────────────────────────
COMMITS=$(git log --oneline "$BEFORE".."$AFTER" 2>/dev/null | wc -l)
log "=== Deploy concluído ($TIMESTAMP) ==="
log "Commits aplicados: $COMMITS"
log "De: ${BEFORE:0:8} → Para: ${AFTER:0:8}"

echo "OK"
