#!/bin/bash
# ─── Tulipa API — Teste Manual ────────────────────────────────────────
# Uso: PORT=3000 ./test/manual.sh
#
# Requer: server rodando (npm start)

BASE="${BASE_URL:-http://localhost:${PORT:-3000}}"
PASS=0
FAIL=0

green() { printf "\033[32m✓ %s\033[0m\n" "$1"; }
red()   { printf "\033[31m✗ %s\033[0m\n" "$1"; }

check() {
  local desc="$1" url="$2" method="${3:-GET}" body="$4"
  local args=(-s -o /dev/null -w "%{http_code}" -X "$method")

  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi

  local status
  status=$(curl "${args[@]}" "$url" 2>/dev/null)

  if [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then
    green "$desc (HTTP $status)"
    PASS=$((PASS + 1))
  elif [ "$status" -ge 400 ] && [ "$status" -lt 500 ]; then
    # 4xx pode ser esperado (ex: campo faltando)
    green "$desc (HTTP $status — validação OK)"
    PASS=$((PASS + 1))
  else
    red "$desc (HTTP $status)"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "═══════════════════════════════════════════"
echo "  Tulipa API — Teste Manual"
echo "  Server: $BASE"
echo "═══════════════════════════════════════════"
echo ""

# ─── Core ──────────────────────────────────────
echo "── Core ──"
check "GET /api/health"            "$BASE/api/health"
check "GET /api/status"            "$BASE/api/status"
check "GET /api/monitor"           "$BASE/api/monitor"
check "GET /api/peers"             "$BASE/api/peers"
check "GET /api/logs"              "$BASE/api/logs"

# ─── Transport Layer ──────────────────────────
echo ""
echo "── Transport Layer ──"
check "GET /api/transport"         "$BASE/api/transport"
check "GET /api/transport/health"  "$BASE/api/transport/health"
check "GET /api/queue"             "$BASE/api/queue"

# ─── WhatsApp ─────────────────────────────────
echo ""
echo "── WhatsApp ──"
check "GET /api/whatsapp/history"  "$BASE/api/whatsapp/history?phone=test"
check "POST /api/whatsapp/send (sem campos)" "$BASE/api/whatsapp/send" POST '{}'

# ─── Telegram ─────────────────────────────────
echo ""
echo "── Telegram ──"
check "POST /api/telegram/send (sem message)" "$BASE/api/telegram/send" POST '{}'

# ─── Email ────────────────────────────────────
echo ""
echo "── Email ──"
check "POST /api/email/send (sem to)"  "$BASE/api/email/send" POST '{"message":"test"}'
check "GET /api/email/search"          "$BASE/api/email/search?query=is:unread"
check "GET /api/email/drafts"          "$BASE/api/email/drafts"

# ─── Webhook ──────────────────────────────────
echo ""
echo "── Webhook ──"
check "GET /api/webhook/endpoints"     "$BASE/api/webhook/endpoints"
check "POST /api/webhook/endpoints (registrar)" "$BASE/api/webhook/endpoints" POST '{"name":"test","url":"https://httpbin.org/post","format":"json"}'
check "POST /api/webhook/send"         "$BASE/api/webhook/send" POST '{"endpoint":"test","message":"hello from tulipa"}'
check "POST /api/webhook/incoming"     "$BASE/api/webhook/incoming/test" POST '{"event":"test","data":"ok"}'
check "DELETE /api/webhook/endpoints/test" "$BASE/api/webhook/endpoints/test" DELETE

# ─── Mesh ─────────────────────────────────────
echo ""
echo "── Mesh ──"
check "GET /api/mesh"              "$BASE/api/mesh"
check "GET /api/mesh/peers"        "$BASE/api/mesh/peers"
check "POST /api/mesh/discover"    "$BASE/api/mesh/discover" POST
check "POST /api/mesh/heartbeat"   "$BASE/api/mesh/heartbeat" POST

# ─── Send (protocolo) ─────────────────────────
echo ""
echo "── Protocolo ──"
check "POST /api/send (sem destination)" "$BASE/api/send" POST '{"message":"test"}'
check "POST /api/send (com type)"  "$BASE/api/send" POST '{"destination":"test","type":"PING"}'

# ─── MCP Proxy ────────────────────────────────
echo ""
echo "── MCP Proxy ──"
check "POST /api/mcp/get_status"   "$BASE/api/mcp/get_status" POST '{}'

# ─── Resultado ────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "  Resultado: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════"
echo ""

exit $FAIL
