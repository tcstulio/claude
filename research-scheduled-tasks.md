# Pesquisa: Scheduled Tasks do Claude Code

## Contexto
Pesquisa sobre como funcionam os Scheduled Tasks do Claude Code, se rodam no Linux e se rodam no Android (via Termux).

---

## O que são Scheduled Tasks do Claude Code?

Recurso que permite agendar prompts para rodar automaticamente em intervalos regulares ou horários específicos, direto dentro do Claude Code.

### Dois tipos:

1. **CLI Session-Scoped (`/loop`)** — tarefas vinculadas à sessão atual, morrem ao fechar o terminal
2. **Desktop Scheduled Tasks** — persistentes, sobrevivem a restarts, rodam enquanto o app estiver aberto

---

## Como funciona no CLI

### Comando `/loop`
```
/loop 5m check the CI status on PR #247 and tell me if it passed or failed
```
Claude verifica a cada 5 minutos e reporta.

### Lembretes únicos (linguagem natural)
```
remind me at 3pm to push the release branch
```

### Detalhes técnicos
- Usa cron expressions internamente
- Cada tarefa tem um ID de 8 caracteres (pode cancelar com `CronDelete`)
- Limite de **50 tarefas** por sessão
- Tarefas recorrentes expiram após **3 dias**
- Horários no **fuso local** (não UTC)
- Executa **entre seus turnos** — não interrompe resposta em andamento
- Se Claude estiver ocupado quando a tarefa dispara, ela espera até ele ficar livre
- **Jitter**: tarefas recorrentes podem atrasar até 10% do período (máx 15 min)
- Para desabilitar: `CLAUDE_CODE_DISABLE_CRON=1`

### Limitações
- Session-scoped: morrem ao fechar o terminal
- Sem catch-up de tarefas perdidas
- Sem persistência entre restarts (apenas no CLI)
- Expiram em 3 dias automaticamente

---

## Funciona no Linux?

**Sim!** Claude Code roda nativamente no Linux. Os scheduled tasks e `/loop` funcionam normalmente.

---

## Funciona no Android (Termux)?

**Sim, com ressalvas.** Claude Code pode ser instalado e executado no Termux.

### Como instalar no Termux
1. Instalar Termux pelo **F-Droid** (NÃO pela Google Play Store — versão da Play Store é obsoleta)
2. `pkg update && pkg upgrade`
3. `termux-setup-storage`
4. Instalar Node.js 18+: `pkg install nodejs git`
5. `npm install -g @anthropic-ai/claude-code`
6. Rodar `claude` e autenticar

### Problemas conhecidos
- **Paths hardcoded de `/tmp/claude/`**: O Android/Termux não tem `/tmp` acessível. Claude Code deveria usar `$TMPDIR` (`/data/data/com.termux/files/usr/tmp`), mas em algumas versões os paths são hardcoded. (Issue #15637)
- **Node.js v24 pode travar**: Há relatos de Claude Code CLI travando com Node.js v24 no Termux (Issue #23634). O `--version` funciona, mas a sessão interativa pode não iniciar.
- **Sessão morre ao fechar o Termux**: Como os scheduled tasks são session-scoped, fechar o app Termux cancela tudo.

### Alternativa recomendada: SSH + Tailscale + tmux
1. Rodar Claude Code em um computador/servidor Linux
2. Conectar do celular via SSH (Termux + Tailscale)
3. Usar `tmux` para manter sessões vivas
4. Scheduled tasks continuam rodando enquanto o tmux/servidor estiver ativo

Essa abordagem é mais estável e contorna os problemas de compatibilidade do Termux.

---

## Resumo

| Plataforma | Funciona? | Como? | Limitações |
|---|---|---|---|
| **Linux** | Sim, nativo | `npm install -g @anthropic-ai/claude-code` | Nenhuma relevante |
| **Android (Termux direto)** | Sim, com ressalvas | Instalar Node.js + Claude Code no Termux | Bugs de `/tmp`, possível travamento com Node v24 |
| **Android (SSH + tmux)** | Sim, recomendado | SSH do Termux para servidor rodando Claude Code | Precisa de máquina remota |

---

## Fontes
- [Run prompts on a schedule - Claude Code Docs](https://code.claude.com/docs/en/scheduled-tasks)
- [Claude Code Scheduled Tasks: Complete Setup Guide](https://claudefa.st/blog/guide/development/scheduled-tasks)
- [How I Use Claude Code on My Phone with Termux and Tailscale](https://www.skeptrune.com/posts/claude-code-on-mobile-termux-tailscale/)
- [Run Claude Code in Termux (Android)](https://blog.closex.org/posts/8e3fd37d/)
- [Claude Code CLI hangs on Termux - Issue #23634](https://github.com/anthropics/claude-code/issues/23634)
- [Hardcoded /tmp paths break on Termux - Issue #15637](https://github.com/anthropics/claude-code/issues/15637)
- [Anthropic turns Claude Code into a background worker](https://the-decoder.com/anthropic-turns-claude-code-into-a-background-worker-with-local-scheduled-tasks/)
- [The Definitive Guide to Using Claude Code on Your Phone](https://sealos.io/blog/claude-code-on-phone)
