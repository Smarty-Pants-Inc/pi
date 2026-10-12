#!/usr/bin/env bash
# Per-repo smarty-dev#1246 guard: the fleet scan covers private repositories only.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
groups="${3:-}"
if [[ -z "$groups" ]]; then
  groups="$script_dir/self-hosted-runner-groups.txt"
  # pi#138: on a pull request, read the runner-group list from the trusted base
  # (BASE_SHA), so a change cannot list a group and use it at once. A missing
  # base commit or file means an empty list. Without BASE_SHA (push to main)
  # the checked-out file is already the reviewed one.
  if [[ -n "${BASE_SHA:-}" ]]; then
    base_groups="$(mktemp)"
    trap 'rm -f -- "$base_groups"' EXIT
    if ! git -C "$script_dir" show "$BASE_SHA:scripts/ci/self-hosted-runner-groups.txt" > "$base_groups" 2>/dev/null; then
      echo "note: no runner-group list at base $BASE_SHA; using an empty list" >&2
      : > "$base_groups"
    fi
    groups="$base_groups"
  fi
fi
python3 "$script_dir/no-hosted-runners.py" "${1:-.github/workflows}" "${2:-$script_dir/hosted-runner-allowlist.txt}" "$groups"
