#!/usr/bin/env bash
# PreToolUse hook: block writes to generated/immutable paths.
file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
case "$file" in
  *pnpm-lock.yaml|*/dist/*|*/.next/*|*/migrations/meta/*)
    echo "BLOCKED: $file is generated. Regenerate it with the proper tool instead of editing." >&2
    exit 2 ;;
esac
exit 0
