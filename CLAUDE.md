# Projeto Tulipa

## O que é
Tulipa é uma rede de agentes conectados via gateway MCP. O dono é Tulio Silva (tcstulio@gmail.com).

## Gateway
- **Endpoint**: https://agent.coolgroove.com.br
- **Agent ID**: agent_00726da6-5b9e-4d63-afcd-2f04c9572ebc
- **Agent Name**: Tulipa #1 (Hub Mode)

## API REST
- `GET /api/health` — status do gateway
- `GET /api/tokens` — listar tokens ativos
- `GET /api/tasks` — listar tarefas pendentes
- `POST /api/message` — enviar mensagem
- `POST /mcp` — chamar MCP tools

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

## Como chamar MCP tools via API
```bash
curl -X POST https://agent.coolgroove.com.br/mcp \
  -H "Content-Type: application/json" \
  -d '{"tool": "get_status", "arguments": {}}'
```

## Convenções
- Branch de desenvolvimento: sempre prefixado com `claude/`
- Idioma principal: português (BR)
- Owner: Tulio Silva
