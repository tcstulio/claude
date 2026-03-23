# Tulipa — Rede de Agentes IA

Este projeto está conectado à rede Tulipa (agent.coolgroove.com.br).
Tulipa é uma plataforma distribuída de agentes IA criada por Tulio Silva (CoolGroove / Teatro Mars).

## Conexão

- **Endpoint:** https://agent.coolgroove.com.br
- **Token:** disponível via variável de ambiente `TULIPA_TOKEN`
- **Token ID:** tok_0bdbbbebec62
- **Auth:** Header `Authorization: Bearer <token>`

## API

- **REST:** `GET /api/health`, `/api/tokens`, `/api/tasks` | `POST /api/message`
- **MCP:** `POST /mcp` (JSON-RPC 2.0, Bearer auth)

## MCP Tools

- `get_status` — status do sistema
- `get_network_identity` — identidade do agente
- `list_peers` — peers na rede
- `list_tasks` / `list_tokens` — tarefas e tokens
- `create_token` / `revoke_token` — gerenciar tokens
- `run_command` — executar comando shell no dispositivo
- `send_prompt` — enviar prompt ao Claude CLI local
- `get_logs` — logs dos serviços
- `send_whatsapp` / `get_whatsapp_history` — WhatsApp

## Exemplo de chamada MCP

```bash
curl -X POST https://agent.coolgroove.com.br/mcp \
  -H "Authorization: Bearer $TULIPA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"get_status","arguments":{}}}'
```

## Regras

1. Ao iniciar conversa: testar `/api/health` para confirmar que o agente está online
2. Se token falhar (401): informar o usuário e pedir novo token
3. Nunca expor tokens completos no chat — referir pelos últimos 8 chars
4. O dono da rede é Tulio Silva (tcstulio@gmail.com)
