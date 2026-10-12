#!/usr/bin/env bash
# Per-repo smarty-dev#1246 guard: the fleet scan covers private repositories only.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
base_dir="$(mktemp -d)"
trap 'rm -rf -- "$base_dir"' EXIT

# pi#138: on a pull request, read each approval list from the trusted base
# (BASE_SHA), so a change cannot approve a hosted label or runner group and use
# it at once. A missing base commit or file means an empty list. Without
# BASE_SHA (push to main) the checked-out file is already the reviewed one.
trusted_list() {
  local name="$1"
  if [[ -z "${BASE_SHA:-}" ]]; then
    printf '%s\n' "$script_dir/$name"
    return
  fi
  if ! git -C "$script_dir" show "$BASE_SHA:scripts/ci/$name" > "$base_dir/$name" 2>/dev/null; then
    echo "note: no scripts/ci/$name at base $BASE_SHA; using an empty list" >&2
    : > "$base_dir/$name"
  fi
  printf '%s\n' "$base_dir/$name"
}

allowlist="${2:-$(trusted_list hosted-runner-allowlist.txt)}"
groups="${3:-$(trusted_list self-hosted-runner-groups.txt)}"
python3 "$script_dir/no-hosted-runners.py" "${1:-.github/workflows}" "$allowlist" "$groups"
