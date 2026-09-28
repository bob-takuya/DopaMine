#!/usr/bin/env bash
# Usage: ask_codex.sh <out_file> <sandbox: read-only|workspace-write> "prompt"
OUT="$1"; SB="$2"; shift 2; PROMPT="$*"
codex exec --skip-git-repo-check --sandbox "$SB" -m gpt-5.6-sol \
  -C "$(cd "$(dirname "$0")/.." && pwd)" \
  -o "$OUT" "$PROMPT" 2>&1 | tail -8
echo "---- codex final message written to: $OUT ----"
