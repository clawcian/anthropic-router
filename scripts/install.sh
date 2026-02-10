#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Building Anthropic Router plugin..."
cd "$PROJECT_DIR"
npm run build

echo "==> Installing plugin into OpenClaw..."
openclaw plugins install "$PROJECT_DIR"

echo "==> Verifying installation..."
if openclaw plugins list 2>/dev/null | grep -q "anthropic-router"; then
  echo "    Plugin installed successfully."
else
  echo "    Warning: Could not verify plugin in 'openclaw plugins list'."
  echo "    The plugin may still work — try '/model anthropic-router/auto'."
fi

echo ""
echo "==> Done! Usage:"
echo ""
echo "  /model anthropic-router/auto   Select the smart router"
echo "  /router stats                  View routing statistics"
echo "  /router test \"your prompt\"     Dry-run a routing decision"
echo ""
echo "  The router automatically picks the cheapest capable model"
echo "  (haiku / sonnet / opus) for each request."
