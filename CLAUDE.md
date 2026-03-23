# Tulipa — Rede de Agentes IA

Este projeto está conectado à rede Tulipa (agent.coolgroove.com.br). Tulipa é uma plataforma distribuída de agentes IA criada por Tulio Silva (CoolGroove / Teatro Mars).

## Conexão

- **Endpoint:** https://agent.coolgroove.com.br
- **Token:** tulipa_2a541781565121490338aa48fe471474e23615b6c21c2e90
- **Token ID:** tok_0bdbbbebec62
- **Auth:** Header `Authorization: Bearer <token>`

## API

- **REST:** `GET /api/health`, `/api/tokens`, `/api/tasks` | `POST /api/message`
- **MCP:** `POST /mcp` (JSON-RPC 2.0, Bearer auth)

## MCP Tools

| Tool | Descrição |
|------|-----------|
| `get_status` | Status do sistema |
| `get_network_identity` | Identidade do agente |
| `list_peers` | Peers na rede |
| `list_tasks` / `list_tokens` | Tarefas e tokens |
| `create_token` / `revoke_token` | Gerenciar tokens |
| `run_command` | Executar comando shell no dispositivo |
| `send_prompt` | Enviar prompt ao Claude CLI local |
| `get_logs` | Logs dos serviços |
| `send_whatsapp` / `get_whatsapp_history` | WhatsApp |

## Exemplo de chamada MCP

```bash
curl -X POST https://agent.coolgroove.com.br/mcp \
  -H "Authorization: Bearer tulipa_2a541781565121490338aa48fe471474e23615b6c21c2e90" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"get_status","arguments":{}}}'
```

## Regras

1. **Ao iniciar conversa:** testar `/api/health` para confirmar que o agente está online
2. **Se token falhar (401):** informar o usuário e pedir novo token
3. **Guardar tokens rotativos** na memória (memory_user_edits), nunca no chat
4. **Nunca expor tokens completos no chat** — referir pelos últimos 8 chars
5. **Dono da rede:** Tulio Silva (tcstulio@gmail.com)
