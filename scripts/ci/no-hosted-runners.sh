#!/usr/bin/env bash
# Per-repo smarty-dev#1246 guard: the fleet scan covers private repositories only.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
base_dir="$(mktemp -d)"
trap 'rm -rf -- "$base_dir"' EXIT

# pi#138: read each approval list from a trusted base, so a change cannot
# approve a hosted label or runner group and use it at once:
# - pull request: BASE_SHA (the event's base.sha);
# - push to main itself: the checked-out file, already reviewed;
# - anything else (merge-queue push, local run): the merge base with origin/main.
# A base that cannot be found, or that lacks the file, means an empty list.
# Accepted limit smarty-dev#10420: this guard runs from the checkout it checks.
base="${BASE_SHA:-}"
if [[ -z "$base" && "${GITHUB_EVENT_NAME:-}" == push && "${GITHUB_REF:-}" == refs/heads/main ]]; then
  base=checkout
elif [[ -z "$base" ]]; then
  base="$(git -C "$script_dir" merge-base HEAD refs/remotes/origin/main 2>/dev/null || true)"
fi

trusted_list() {
  local name="$1"
  if [[ "$base" == checkout ]]; then
    printf '%s\n' "$script_dir/$name"
  elif [[ -n "$base" ]] && git -C "$script_dir" show "$base:scripts/ci/$name" > "$base_dir/$name" 2>/dev/null; then
    printf '%s\n' "$base_dir/$name"
  else
    echo "note: no scripts/ci/$name at trusted base '${base:-none}'; using an empty list" >&2
    : > "$base_dir/$name"
    printf '%s\n' "$base_dir/$name"
  fi
}

allowlist="${2:-$(trusted_list hosted-runner-allowlist.txt)}"
groups="${3:-$(trusted_list self-hosted-runner-groups.txt)}"
python3 "$script_dir/no-hosted-runners.py" "${1:-.github/workflows}" "$allowlist" "$groups"
