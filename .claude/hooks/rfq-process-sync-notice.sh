#!/usr/bin/env bash
# Reminds the session that a change to the RFQ process does not reach an already
# deployed tenant on its own. Advisory only: it never blocks the edit.
#
# `process_definitions` rows are per-organization database rows that nothing derives
# from the code, and the deploy entrypoint runs no seed. See the rfq-process-sync skill.
set -uo pipefail

payload="$(cat)"
file="$(printf '%s' "$payload" | jq -r '.tool_response.filePath // .tool_input.file_path // empty')"
[ -n "$file" ] || exit 0

case "$file" in
  *src/modules/rfq_intake/lib/processDefinition.ts)
    note="You changed the RFQ process definition. The row lives in \`process_definitions\` per organization and no deploy step reseeds it, so every existing tenant keeps the old name, description and triggers. Use the rfq-process-sync skill to reconcile them with \`mercato rfq_intake seed-process --force\`, or say explicitly that you are leaving deployed tenants stale."
    ;;
  *src/modules/rfq_intake/workflows.ts)
    note="You changed the RFQ workflow. The graph itself propagates on deploy through \`registerCodeWorkflows\` — nothing to sync. But if \`RFQ_ANALYSIS_WORKFLOW_ID\` changed, every existing \`process_definitions\` row still points at the old id and starts nothing; the rfq-process-sync skill covers the reconcile."
    ;;
  *)
    exit 0
    ;;
esac

jq -n --arg note "$note" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $note}}'
