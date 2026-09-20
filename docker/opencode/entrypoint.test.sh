#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/config"

cat > "$tmp/bin/opencode" <<'EOF'
#!/usr/bin/env bash
cp "$OPENCODE_CONFIG_DIR/opencode.jsonc" "$TEST_CONFIG"
EOF
chmod +x "$tmp/bin/opencode"

PATH="$tmp/bin:$PATH" \
MCP_SERVER_API_KEY=test-key \
OPENCODE_CONFIG_DIR="$tmp/config" \
OPENCODE_MCP_TIMEOUT_MS=123456 \
OPENCODE_TOOL_OUTPUT_MAX_BYTES=234567 \
OPENCODE_TOOL_OUTPUT_MAX_LINES=3456 \
TEST_CONFIG="$tmp/config.json" \
bash "$root/docker/opencode/entrypoint.sh" >/dev/null

node -e '
const fs = require("fs");
const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (config.experimental?.mcp_timeout !== 123456) {
  throw new Error(`Expected experimental.mcp_timeout=123456, received ${config.experimental?.mcp_timeout}`);
}
if (config.tool_output?.max_bytes !== 234567 || config.tool_output?.max_lines !== 3456) {
  throw new Error(`Expected configured tool output limits, received ${JSON.stringify(config.tool_output)}`);
}
' "$tmp/config.json"
