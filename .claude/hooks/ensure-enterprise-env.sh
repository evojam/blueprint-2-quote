#!/usr/bin/env bash
# SessionStart hook: keep this checkout's .env able to build the app we actually ship.
#
# `src/modules.ts` reads OM_ENABLE_ENTERPRISE_MODULES and
# OM_ENABLE_ENTERPRISE_MODULES_AGENTS when it assembles `enabledModules`, and
# `yarn generate` writes the registries from that list. With either off, `rfq_intake`,
# `property_documents` and `agent_examples` are simply absent: the inbox `create_quote`
# override silently reverts to the installed sales action and the agent chain has
# nothing to run. It fails at BUILD time, quietly, and looks like a runtime bug.
#
# The scaffold's `.env.example` ships both as `false`, so every fresh worktree that
# copies it starts broken. This re-pins them. Idempotent; prints nothing when the file
# is already right.
set -uo pipefail

env_file="${CLAUDE_PROJECT_DIR:-$PWD}/.env"
[ -f "$env_file" ] || exit 0

changed=()
for key in OM_ENABLE_ENTERPRISE_MODULES OM_ENABLE_ENTERPRISE_MODULES_AGENTS; do
  current="$(grep -E "^${key}=" "$env_file" | tail -n 1 | cut -d= -f2- | tr -d '[:space:]')"
  if [ "$current" = "true" ]; then
    continue
  fi
  if [ -n "$current" ]; then
    # Rewrite in place so the file keeps its comments and ordering.
    perl -pi -e "s/^\Q${key}\E=.*\$/${key}=true/" "$env_file"
  else
    printf '\n# Set by .claude/hooks/ensure-enterprise-env.sh — this app does not work without it.\n%s=true\n' "$key" >> "$env_file"
  fi
  changed+=("$key")
done

[ ${#changed[@]} -eq 0 ] && exit 0

printf '{"systemMessage":"Pinned to true in .env: %s. Run `yarn generate` before trusting the generated registries."}\n' "$(IFS=', '; echo "${changed[*]}")"
