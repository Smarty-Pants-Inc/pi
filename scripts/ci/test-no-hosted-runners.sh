#!/usr/bin/env bash
# Exercise the workflow-routing trust boundary through the real guard CLI.
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
guard="$repo_root/scripts/ci/no-hosted-runners.sh"
fixture_dir="$(mktemp -d)"
trap 'rm -rf -- "$fixture_dir"' EXIT
probe() {
  local expected="$1" name="$2" content="$3" status=0
  printf '%s\n' "$content" > "$fixture_dir/probe.yml"
  bash "$guard" "$fixture_dir" > "$fixture_dir/output" 2>&1 || status=$?
  if { [ "$expected" = accept ] && [ "$status" -ne 0 ]; } || { [ "$expected" = reject ] && [ "$status" -eq 0 ]; }; then
    printf 'FAIL: %s (exit %s)\n' "$name" "$status" >&2
    cat "$fixture_dir/output" >&2
    exit 1
  fi
}
probe accept 'standard literal' $'jobs:\n  check:\n    runs-on: ubuntu-latest'
probe accept 'pinned Ubuntu' $'jobs:\n  check:\n    runs-on: ubuntu-24.04'
probe accept 'platform matrix' $'jobs:\n  check:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest, macos-latest]'
probe reject 'fleet literal' $'jobs:\n  check:\n    runs-on: smarty-linux-x64'
probe reject 'self-hosted list' $'jobs:\n  check:\n    runs-on: [self-hosted, linux, x64]'
probe reject 'mixed hosted list' $'jobs:\n  check:\n    runs-on: [self-hosted, ubuntu-latest]'
probe reject 'larger runner' $'jobs:\n  check:\n    runs-on: ubuntu-24.04-16core'
probe reject 'group-only' $'jobs:\n  check:\n    runs-on: {group: fleet}'
probe reject 'group with hosted label' $'jobs:\n  check:\n    runs-on: {group: fleet, labels: ubuntu-latest}'
probe reject 'self-hosted matrix leg' $'jobs:\n  check:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, smarty-priority]'
probe reject 'unresolved variable' $'jobs:\n  check:\n    runs-on: ${{ vars.RUNNER }}'
probe reject 'invalid YAML' $'jobs:\n  check:\n    runs-on: ['
echo 'All standard-hosted runner guard probes passed'
