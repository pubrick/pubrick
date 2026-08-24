#!/usr/bin/env bash
# PostToolUse hook: format the edited file with Biome. Never blocks.
file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
if [ -n "$file" ] && [ -f "$file" ]; then
  pnpm exec biome check --write "$file" >/dev/null 2>&1 || true
fi
exit 0
