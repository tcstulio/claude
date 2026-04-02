# Tulipa — Instruções para Claude Code

> Este arquivo é lido automaticamente pelo Claude Code como contexto de sessão.
> Para documentação do projeto, veja `README.md`, `PROJETO-TULIPA.md` e `PROGRESS.md`.

## Gateway (conexão com a rede)

- **Endpoint**: https://agent.coolgroove.com.br
- **Agent ID**: agent_00726da6-5b9e-4d63-afcd-2f04c9572ebc
- **Agent Name**: Tulipa #1 (Hub Mode)
- **Token:** tulipa_2a541781565121490338aa48fe471474e23615b6c21c2e90
- **Token ID:** tok_0bdbbbebec62
- **Auth:** Header `Authorization: Bearer <token>`

## Verificar saúde do gateway

```bash
curl -s https://agent.coolgroove.com.br/api/health
```

## Chamar MCP tool

```bash
curl -X POST https://agent.coolgroove.com.br/mcp \
  -H "Authorization: Bearer tulipa_2a541781565121490338aa48fe471474e23615b6c21c2e90" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"get_status","arguments":{}}}'
```

## MCP Tools disponíveis

| Tool | Descrição |
|---|---|
| `get_status` | Status do agente/gateway |
| `get_network_identity` | Identidade na rede |
| `list_peers` | Listar agentes conectados |
| `list_tasks` | Listar tarefas |
| `list_tokens` | Listar tokens de acesso |
| `create_token` | Criar novo token |
| `revoke_token` | Revogar token |
| `run_command` | Executar comando remoto |
| `send_prompt` | Enviar prompt para outro agente |
| `get_logs` | Ver logs do sistema |
| `send_whatsapp` | Enviar mensagem WhatsApp |
| `get_whatsapp_history` | Histórico de WhatsApp |

## Regras de comportamento

1. **Ao iniciar conversa:** testar `/api/health` para confirmar que o agente está online
2. **Se token falhar (401):** informar o usuário e pedir novo token
3. **Nunca expor tokens completos no chat** — referir pelos últimos 8 chars
4. **Dono da rede:** Tulio Silva (tcstulio@gmail.com)

## Convenções do projeto

- **Branch de desenvolvimento:** sempre prefixado com `claude/`
- **Idioma:** português (BR)
- **Linguagem:** TypeScript (ES2022, strict mode)
- **Runtime:** Node.js >= 22
- **Testes:** Vitest (`npm test`)
- **CI:** GitHub Actions matrix (Ubuntu, Windows, macOS x Node 22, 24)
- **Owner:** Tulio Silva

## Comandos úteis

```bash
npm test              # Rodar testes (Vitest)
npm run typecheck     # Verificar tipos TypeScript
npm run build         # Compilar para dist/
npm run dev           # Modo watch
npm run test:manual   # Testes E2E via curl
```
