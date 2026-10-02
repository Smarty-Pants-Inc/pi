#!/usr/bin/env bash
# Regression probes for smarty-dev#1246; no YAML parser or package dependencies.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
guard="$repo_root/scripts/ci/no-hosted-runners.sh"
fixture_dir="$(mktemp -d)"
trap 'rm -rf -- "$fixture_dir"' EXIT

bash "$guard" "$repo_root/.github/workflows"
echo "PASS: real workflows"

expect_rejected() {
  local name="$1" content="$2" diagnostic="$3" output
  printf '%s\n' "$content" > "$fixture_dir/probe.yml"
  if output="$(bash "$guard" "$fixture_dir" 2>&1)"; then
    echo "FAIL: $name was accepted" >&2
    exit 1
  fi
  if [[ "$output" != *"$diagnostic"* ]]; then
    printf 'FAIL: %s failed without the expected diagnostic:\n%s\n' "$name" "$output" >&2
    exit 1
  fi
  echo "PASS: rejected $name"
}

expect_rejected 'bare exception marker' $'jobs:\n  check:\n    # hosted-exception:\n    runs-on: ubuntu-latest' 'unapproved hosted runner'
expect_rejected 'folded hosted runs-on' $'jobs:\n  check:\n    runs-on: >-\n      ubuntu-latest' 'block-scalar runner value is forbidden'
expect_rejected 'plain hosted runs-on' $'jobs:\n  check:\n    runs-on: ubuntu-latest' 'unapproved hosted runner'
expect_rejected 'inline hosted list' $'jobs:\n  check:\n    runs-on: [self-hosted, ubuntu-latest]' 'unapproved hosted runner'
expect_rejected 'hosted matrix list' $'jobs:\n  check:\n    strategy:\n      matrix:\n        runner:\n          - windows-latest' 'unapproved hosted runner'

# Cover all supported indicators, runner-related matrix keys, and list-form keys.
for key in runs-on runner os; do
  for indicator in '>' '>-' '>+' '|' '|-' '|+'; do
    for prefix in '        ' '        - '; do
      expect_rejected "$key $indicator (prefix '$prefix')" \
        "jobs:
  check:
    strategy:
      matrix:
${prefix}${key}: ${indicator} # no block scalar is allowed
            ubuntu-latest" 'block-scalar runner value is forbidden'
    done
  done
done

printf '%s\n' $'jobs:\n  check:\n    runs-on: smarty-linux-x64' > "$fixture_dir/probe.yml"
bash "$guard" "$fixture_dir"
echo "PASS: smarty-linux-x64 fixture"
echo "All hosted-runner guard probes passed"
