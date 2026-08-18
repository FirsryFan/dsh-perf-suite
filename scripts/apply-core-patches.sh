#!/bin/bash
# Apply the optional core source patches shipped with dsh-perf-suite.
#
# Usage:
#   bash scripts/apply-core-patches.sh [path-to-deepseek-harness]
#
# Patches:
#   0001-dsh-webui-perf.patch  → WebUI rendering/highlight/cache optimizations
#   0002-session-slim.patch    → sourceEventSeqs intervalization + client live pruning
#
# Each patch is applied with `git apply`; already-applied patches are skipped.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECKOUT="${1:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "apply-core-patches: cannot locate the dsh checkout" >&2
  exit 1
fi

cd "$CHECKOUT"
if [ ! -d .git ]; then
  echo "apply-core-patches: $CHECKOUT is not a git checkout" >&2
  exit 1
fi

for patch in "$ROOT"/patches/*.patch; do
  name="$(basename "$patch")"
  if git apply --check "$patch" 2>/dev/null; then
    git apply "$patch"
    echo "applied $name"
  elif git apply --reverse --check "$patch" 2>/dev/null; then
    echo "already applied: $name (skipped)"
  else
    echo "warning: $name does not apply cleanly; check for conflicts" >&2
    git apply --check "$patch" >&2 || true
    exit 1
  fi
done

echo "apply-core-patches: done"
