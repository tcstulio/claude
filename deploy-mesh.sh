#!/bin/bash
# ─── Deploy Tulipa Mesh — Termux / Linux ───────────────────────
#
# Instala e configura o servidor mesh como serviço.
# Uso: bash deploy-mesh.sh [--start]
#
set -e

MESH_DIR="${MESH_DIR:-$HOME/tulipa-mesh}"
LOG_DIR="${LOG_DIR:-$HOME/.tulipa/logs}"
ENV_FILE="$MESH_DIR/.env"

echo "╔══════════════════════════════════════╗"
echo "║   Tulipa Mesh — Deploy               ║"
echo "╚══════════════════════════════════════╝"

# ── 1. Cria diretórios ───────────────────────────
mkdir -p "$LOG_DIR"
mkdir -p "$MESH_DIR/data"

# ── 2. Copia código para diretório de deploy ─────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[1/4] Copiando código para $MESH_DIR..."

# Copia arquivos do mesh (server.js, lib/, config/, public/, package.json)
cp "$SCRIPT_DIR/server.js" "$MESH_DIR/"
cp "$SCRIPT_DIR/package.json" "$MESH_DIR/"
cp "$SCRIPT_DIR/package-lock.json" "$MESH_DIR/" 2>/dev/null || true
cp -r "$SCRIPT_DIR/lib" "$MESH_DIR/"
cp -r "$SCRIPT_DIR/config" "$MESH_DIR/"
cp -r "$SCRIPT_DIR/public" "$MESH_DIR/"

# ── 3. Instala dependências ──────────────────────
echo "[2/4] Instalando dependências..."
cd "$MESH_DIR"
npm install --production 2>&1 | tail -3

# ── 4. Cria .env se não existe ────────────────────
if [ ! -f "$ENV_FILE" ]; then
  echo "[3/4] Criando .env..."
  cat > "$ENV_FILE" << 'ENVEOF'
# ─── Tulipa Mesh — Configuração ──────────────────
# Gateway (local no Termux, ou remoto)
GATEWAY_URL=http://localhost:18800
TULIPA_TOKEN=

# Servidor
PORT=3000
NODE_NAME=Tulipa Android

# Monitor
MONITOR_INTERVAL=120000
SLOW_THRESHOLD=10000
ALERT_PHONE=

# WhatsApp groups (separados por vírgula)
WHATSAPP_GROUPS=

# Telegram (opcional — fallback channel)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Email (via Gmail MCP — opcional)
EMAIL_DEFAULT_TO=
EMAIL_AUTO_SEND=false

# Webhook (opcional)
WEBHOOK_URL=
WEBHOOK_NAME=

# Mesh
MESH_DISCOVERY_INTERVAL=120000
MESH_HEARTBEAT_INTERVAL=60000
ENVEOF
  echo "  -> Edite $ENV_FILE com seus tokens!"
else
  echo "[3/4] .env já existe, mantendo."
fi

# ── 5. Cria script de inicialização ──────────────
STARTUP_SCRIPT="$MESH_DIR/start.sh"
cat > "$STARTUP_SCRIPT" << 'STARTEOF'
#!/bin/bash
# Carrega .env
set -a
DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$DIR/.env" ] && source "$DIR/.env"
set +a

# Inicia o servidor
cd "$DIR"
exec node server.js
STARTEOF
chmod +x "$STARTUP_SCRIPT"

echo "[4/4] Setup completo!"
echo ""
echo "────────────────────────────────────────"
echo "Próximos passos:"
echo ""
echo "  1. Edite o .env:"
echo "     nano $ENV_FILE"
echo ""
echo "  2. Inicie manualmente:"
echo "     cd $MESH_DIR && bash start.sh"
echo ""
echo "  3. Ou como serviço (background):"
echo "     nohup bash $STARTUP_SCRIPT >> $LOG_DIR/tulipa-mesh.log 2>&1 &"
echo ""
echo "  4. Dashboard: http://localhost:3000/"
echo "────────────────────────────────────────"

# ── Auto-start se pedido ─────────────────────────
if [ "$1" = "--start" ]; then
  echo ""
  echo "Iniciando Tulipa Mesh..."
  cd "$MESH_DIR"
  set -a
  [ -f .env ] && source .env
  set +a
  nohup node server.js >> "$LOG_DIR/tulipa-mesh.log" 2>&1 &
  echo "PID: $!"
  echo "Log: tail -f $LOG_DIR/tulipa-mesh.log"
fi
