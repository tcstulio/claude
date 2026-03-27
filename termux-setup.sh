#!/bin/bash
# ============================================================
# Setup para rodar Claude Code dentro de tmux no Termux
# sem que o Android mate o processo ao bloquear a tela
# ============================================================

set -e

echo "=== Termux + tmux + Claude Code Setup ==="
echo ""

# -------------------------------------------------------
# 1. Adquirir Wake Lock (impede CPU de dormir)
# -------------------------------------------------------
echo "[1/4] Adquirindo wake lock..."
if command -v termux-wake-lock &>/dev/null; then
    termux-wake-lock
    echo "  ✓ Wake lock adquirido"
else
    echo "  ✗ termux-wake-lock não encontrado."
    echo "    Instale com: pkg install termux-api"
    echo "    E instale o app Termux:API do F-Droid."
    exit 1
fi

# -------------------------------------------------------
# 2. Instalar tmux se necessário
# -------------------------------------------------------
echo "[2/4] Verificando tmux..."
if ! command -v tmux &>/dev/null; then
    echo "  Instalando tmux..."
    pkg install -y tmux
fi
echo "  ✓ tmux disponível"

# -------------------------------------------------------
# 3. Configurar tmux
# -------------------------------------------------------
echo "[3/4] Configurando tmux..."
TMUX_CONF="$HOME/.tmux.conf"
if [ ! -f "$TMUX_CONF" ] || ! grep -q "# termux-claude-setup" "$TMUX_CONF" 2>/dev/null; then
    cat >> "$TMUX_CONF" << 'TMUXEOF'

# termux-claude-setup
# Aumenta histórico do scroll
set -g history-limit 50000
# Mantém sessão ativa
set -g remain-on-exit off
set -g destroy-unattached off
# Mouse habilitado para facilitar no celular
set -g mouse on
TMUXEOF
    echo "  ✓ .tmux.conf atualizado"
else
    echo "  ✓ .tmux.conf já configurado"
fi

# -------------------------------------------------------
# 4. Criar/atachar sessão tmux com Claude
# -------------------------------------------------------
SESSION_NAME="claude"

echo "[4/4] Iniciando sessão tmux '$SESSION_NAME'..."
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo ""
    echo "Sessão '$SESSION_NAME' já existe. Reconectando..."
    echo ""
    exec tmux attach-session -t "$SESSION_NAME"
else
    echo ""
    echo "Criando nova sessão '$SESSION_NAME'..."
    echo ""
    exec tmux new-session -s "$SESSION_NAME"
fi
