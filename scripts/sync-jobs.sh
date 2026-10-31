#!/usr/bin/env bash
# Copies the canonical src/jobs from the Codex fork into the agy fork.
# Identical in both repos; both are expected to be siblings in one parent directory.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
parent="$(dirname -- "$repo_root")"
source_root="$parent/codex-mcp-tool"
target_root="${1:-$parent/antigravity-mcp-server}"
if [[ ! -d "$source_root/src/jobs" ]]; then
  echo "Expected canonical jobs module at $source_root/src/jobs" >&2
  exit 1
fi
if [[ ! -f "$target_root/package.json" || ! -d "$target_root/src" ]]; then
  echo "Expected sibling repository at $target_root" >&2
  exit 1
fi
mkdir -p -- "$target_root/src/jobs"
cp -f -- "$source_root"/src/jobs/*.ts "$target_root/src/jobs/"
echo "Copied the canonical jobs module to $target_root/src/jobs"
