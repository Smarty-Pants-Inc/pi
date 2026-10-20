#!/usr/bin/env bash
# Historical entrypoint retained; public repositories require standard hosted runners.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 "$script_dir/no-hosted-runners.py" "${1:-.github/workflows}"
