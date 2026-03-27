#!/bin/bash
# ============================================================
# Script para ~/.termux/boot/ - inicia automaticamente no boot
#
# Instalação:
#   1. Instale Termux:Boot do F-Droid
#   2. Abra o app Termux:Boot uma vez
#   3. Copie este script:
#      cp termux-boot-claude.sh ~/.termux/boot/start-claude.sh
#      chmod +x ~/.termux/boot/start-claude.sh
# ============================================================

# Adquire wake lock para manter CPU ativo
termux-wake-lock

# Inicia sessão tmux em background (se não existir)
if ! tmux has-session -t claude 2>/dev/null; then
    tmux new-session -d -s claude
fi
