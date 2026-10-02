#!/usr/bin/env bash
# Per-repo smarty-dev#1246 guard: the fleet scan covers private repositories only.
set -euo pipefail

workflow_dir="${1:-.github/workflows}"
shopt -s nullglob
workflows=("$workflow_dir"/*.yml "$workflow_dir"/*.yaml)
if ((${#workflows[@]} == 0)); then
  echo "No workflows found in $workflow_dir" >&2
  exit 1
fi

# The fleet exception list is empty: no in-file marker can approve hosted use.
# Match hosted image scalar/list values, not check names or release asset names.
# Runner-related block scalars are never needed; reject rather than parse them.
awk '
  /^[[:space:]]*#/ { next }
  {
    if ($0 ~ /(^|[[:space:]-])(runs-on|os|runner):[[:space:]]*[>|][-+]?[[:space:]]*(#.*)?$/) {
      printf "%s:%d: block-scalar runner value is forbidden: %s\n", FILENAME, FNR, $0 > "/dev/stderr"
      failed = 1
    }
    if (($0 ~ /(^[[:space:]]*-[[:space:]]*|:[[:space:]]*|\[[[:space:]]*|,[[:space:]]*)["\047]?(ubuntu|windows|macos)-[[:alnum:]_.-]+["\047]?([[:space:]]*($|,|\]|#))/) ||
        ($0 ~ /(^|[[:space:]-])(runs-on|os|runner):/ &&
         $0 ~ /(^|[^[:alnum:]_-])(ubuntu|windows|macos)-[[:alnum:]_.-]+([^[:alnum:]_-]|$)/)) {
      printf "%s:%d: unapproved hosted runner: %s\n", FILENAME, FNR, $0 > "/dev/stderr"
      failed = 1
    }
  }
  END { exit failed ? 1 : 0 }
' "${workflows[@]}"
