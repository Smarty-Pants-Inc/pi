#!/usr/bin/env bash
# Regression probes for smarty-dev#1246; no YAML parser or package dependencies.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
guard="$repo_root/scripts/ci/no-hosted-runners.sh"
fixture_dir="$(mktemp -d)"
trap 'rm -rf -- "$fixture_dir"' EXIT

bash "$guard" "$repo_root/.github/workflows"
echo "PASS: real workflows"

# Optional 4th/5th arguments: fixture file name and allowlist path.
write_fixture() {
  rm -f -- "$fixture_dir"/*.yml
  printf '%s\n' "$2" > "$fixture_dir/$1"
}

expect_rejected() {
  local name="$1" content="$2" diagnostic="$3" file="${4:-probe.yml}" output
  write_fixture "$file" "$content"
  if output="$(bash "$guard" "$fixture_dir" ${5:+"$5"} 2>&1)"; then
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

: > "$fixture_dir/empty.txt"
write_fixture probe.yml $'jobs:\n  check:\n    runs-on: smarty-linux-x64'
bash "$guard" "$fixture_dir" "$fixture_dir/empty.txt"
echo "PASS: smarty-linux-x64 fixture"

# Checked-in allowlist: two smoke platforms plus the approved npm trusted publisher.
smoke_job=$'jobs:\n  build:\n    runs-on: smarty-linux-x64\n  smoke-test-binaries:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        runner:\n          - smarty-linux-x64\n          - macos-latest\n          - windows-latest'
publish_job=$'\n  publish-npm:\n    runs-on: ubuntu-latest'
approved_jobs="$smoke_job$publish_job"
write_fixture build-binaries.yml "$approved_jobs"
bash "$guard" "$fixture_dir"
echo "PASS: all three allowlisted entries (smoke macos-latest/windows-latest; publish-npm ubuntu-latest)"

expect_rejected 'allowlisted smoke label in another job' "$approved_jobs"$'\n  stage:\n    runs-on: macos-latest' 'unapproved hosted runner' build-binaries.yml
expect_rejected 'allowlisted publisher label in another job' "$approved_jobs"$'\n  stage:\n    runs-on: ubuntu-latest' 'unapproved hosted runner' build-binaries.yml
expect_rejected 'allowlisted label in another file' "$approved_jobs" 'unapproved hosted runner' other.yml
expect_rejected 'third hosted label in allowlisted smoke job' "$smoke_job"$'\n          - ubuntu-latest'"$publish_job" 'unapproved hosted runner' build-binaries.yml
expect_rejected 'other hosted label next to allowlisted one' "$smoke_job"$'\n          - [macos-latest, ubuntu-24.04]'"$publish_job" 'unapproved hosted runner' build-binaries.yml
for label in ubuntu-24.04 ubuntu-22.04 ubuntu-24.04-arm macos-latest windows-latest; do
  expect_rejected "publish-npm on $label" "$smoke_job"$'\n  publish-npm:\n    runs-on: '"$label" 'unapproved hosted runner' build-binaries.yml
done
expect_rejected 'other hosted label next to approved publisher' "$smoke_job"$'\n  publish-npm:\n    runs-on: [ubuntu-latest, ubuntu-24.04]' 'unapproved hosted runner' build-binaries.yml
expect_rejected 'inline exception marker' "$approved_jobs"$'\n  stage:\n    runs-on: windows-latest # hosted-exception: approved' 'unapproved hosted runner' build-binaries.yml
expect_rejected 'hosted label outside jobs' $'env:\n  os: macos-latest\n'"$approved_jobs" 'unapproved hosted runner' build-binaries.yml
expect_rejected 'unused smoke allowlist entry' "${smoke_job%$'\n          - windows-latest'}$publish_job" 'unused hosted-runner allowlist entry' build-binaries.yml
expect_rejected 'unused publisher allowlist entry' "$smoke_job" 'unused hosted-runner allowlist entry' build-binaries.yml
printf '%s\n' 'build-binaries.yml smoke-test-binaries macos-latest' > "$fixture_dir/no-url.txt"
expect_rejected 'allowlist entry without approval URL' "$approved_jobs" 'malformed allowlist entry' build-binaries.yml "$fixture_dir/no-url.txt"
expect_rejected 'empty allowlist' "$approved_jobs" 'unapproved hosted runner' build-binaries.yml "$fixture_dir/empty.txt"
echo "All hosted-runner guard probes passed"
