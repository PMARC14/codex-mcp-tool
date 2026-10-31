#!/usr/bin/env bash
set -euo pipefail

source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
target_root="${1:-$source_root/../antigravity-mcp-server}"
if [[ ! -f "$target_root/package.json" || ! -d "$target_root/src" ]]; then
  echo "Expected sibling repository at $target_root" >&2
  exit 1
fi
mkdir -p -- "$target_root/src/jobs"
cp -f -- "$source_root"/src/jobs/*.ts "$target_root/src/jobs/"
echo "Copied the canonical jobs module to $target_root/src/jobs"
