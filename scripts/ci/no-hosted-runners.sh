#!/usr/bin/env bash
# Per-repo smarty-dev#1246 guard: the fleet scan covers private repositories only.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$script_dir/no-hosted-runners.py" "${1:-.github/workflows}" "${2:-$script_dir/hosted-runner-allowlist.txt}"
