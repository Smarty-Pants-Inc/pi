#!/usr/bin/env bash
# Per-repo smarty-dev#1246 guard: the fleet scan covers private repositories only.
set -euo pipefail

workflow_dir="${1:-.github/workflows}"
allowlist="${2:-$(dirname -- "${BASH_SOURCE[0]}")/hosted-runner-allowlist.txt}"
shopt -s nullglob
workflows=("$workflow_dir"/*.yml "$workflow_dir"/*.yaml)
if ((${#workflows[@]} == 0)); then
  echo "No workflows found in $workflow_dir" >&2
  exit 1
fi

# Hosted labels are accepted only for the exact <file> <job> <label> entries in
# the checked-in allowlist; in-file comments or markers never approve hosted use.
# Match hosted image scalar/list values, not check names or release asset names.
# Runner-related block scalars are never needed; reject rather than parse them.
awk '
  FILENAME == ARGV[1] {
    if ($0 ~ /^[[:space:]]*(#|$)/) next
    if (NF != 4 || $4 !~ /^https:\/\/github\.com\/[^[:space:]]+#issuecomment-[0-9]+$/) {
      printf "%s:%d: malformed allowlist entry: %s\n", FILENAME, FNR, $0 > "/dev/stderr"
      failed = 1
      next
    }
    allowed[$1 " " $2 " " $3] = 0
    next
  }
  FNR == 1 { file = FILENAME; sub(/.*\//, "", file); in_jobs = 0; job = ""; job_indent = -1 }
  /^[[:space:]]*#/ { next }
  {
    indent = match($0, /[^ ]/) - 1
    if (indent == 0) {
      in_jobs = ($0 ~ /^jobs:[[:space:]]*(#.*)?$/)
      job = ""
      job_indent = -1
    } else if (in_jobs && indent > 0 && $0 ~ /^ *[A-Za-z0-9_-]+:/) {
      if (job_indent < 0) job_indent = indent
      if (indent == job_indent) {
        job = $0
        sub(/^ */, "", job)
        sub(/:.*/, "", job)
      }
    }
    # Reject indirection rather than resolve YAML anchors and aliases.
    if ($0 ~ /runs-on:[[:space:]]*[&*]/) {
      printf "%s:%d: runs-on via YAML anchor/alias is not allowed (smarty-dev#1246); write the label literally\n", FILENAME, FNR > "/dev/stderr"
      failed = 1
    }
    if ($0 ~ /(^|[[:space:]-])(runs-on|os|runner):[[:space:]]*[>|][-+]?[[:space:]]*(#.*)?$/) {
      printf "%s:%d: block-scalar runner value is forbidden: %s\n", FILENAME, FNR, $0 > "/dev/stderr"
      failed = 1
    }
    if (($0 ~ /(^[[:space:]]*-[[:space:]]*|:[[:space:]]*|\[[[:space:]]*|,[[:space:]]*)["\047]?(ubuntu|windows|macos)-[[:alnum:]_.-]+["\047]?([[:space:]]*($|,|\]|#))/) ||
        ($0 ~ /(^|[[:space:]-])(runs-on|os|runner):/ &&
         $0 ~ /(^|[^[:alnum:]_-])(ubuntu|windows|macos)-[[:alnum:]_.-]+([^[:alnum:]_-]|$)/)) {
      rest = $0
      sub(/[[:space:]]#.*/, "", rest)
      ok = 0
      while (match(rest, /(ubuntu|windows|macos)-[[:alnum:]_.-]+/)) {
        label = substr(rest, RSTART, RLENGTH)
        before = RSTART > 1 ? substr(rest, RSTART - 1, 1) : ""
        rest = substr(rest, RSTART + RLENGTH)
        if (before ~ /[[:alnum:]_-]/) continue
        key = file " " job " " label
        if (job != "" && key in allowed) { allowed[key]++; ok = 1; continue }
        ok = 0
        break
      }
      if (!ok) {
        printf "%s:%d: unapproved hosted runner: %s\n", FILENAME, FNR, $0 > "/dev/stderr"
        failed = 1
      }
    }
  }
  END {
    for (key in allowed) {
      if (allowed[key] == 0) {
        printf "unused hosted-runner allowlist entry (remove it): %s\n", key > "/dev/stderr"
        failed = 1
      }
    }
    exit failed ? 1 : 0
  }
' "$allowlist" "${workflows[@]}"
