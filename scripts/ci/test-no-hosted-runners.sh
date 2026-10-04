#!/usr/bin/env bash
# Regression probes for smarty-dev#1246 and #3644 through the actual guard.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
guard="$repo_root/scripts/ci/no-hosted-runners.sh"
fixture_dir="$(mktemp -d)"
trap 'rm -rf -- "$fixture_dir"' EXIT

bash "$guard" "$repo_root/.github/workflows"
echo 'PASS: real workflows'
: > "$fixture_dir/empty.txt"

write_fixture() {
  rm -f -- "$fixture_dir"/*.yml
  printf '%s\n' "$2" > "$fixture_dir/$1"
}

expect_rejected() {
  local name="$1" content="$2" diagnostic="$3" file="${4:-probe.yml}" output
  write_fixture "$file" "$content"
  if output="$(bash "$guard" "$fixture_dir" "${5:-$fixture_dir/empty.txt}" 2>&1)"; then
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
expect_rejected 'hosted matrix list' $'jobs:\n  check:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        runner:\n          - windows-latest' 'unapproved hosted runner'

# Valid runner-related matrix dimensions and include entries, all block styles.
for key in runs-on runner os; do
  for indicator in '>' '>-' '>+' '|' '|-' '|+'; do
    for form in axis include; do
      if [[ "$form" == axis ]]; then
        dimension="        $key:
          - $indicator
            ubuntu-latest"
      else
        dimension="        include:
          - $key: $indicator
              ubuntu-latest"
      fi
      expect_rejected "$key $indicator ($form)" \
        "jobs:
  check:
    runs-on: \${{ matrix.$key }}
    strategy:
      matrix:
$dimension" 'block-scalar runner value is forbidden'
    done
  done
done

write_fixture probe.yml $'jobs:\n  check:\n    runs-on: smarty-linux-x64'
bash "$guard" "$fixture_dir" "$fixture_dir/empty.txt"
echo 'PASS: literal smarty-linux-x64 fixture'

# All three checked-in exceptions must be exercised, not just present as text.
allowlist="$repo_root/scripts/ci/hosted-runner-allowlist.txt"
smoke_job=$'jobs:\n  build:\n    runs-on: smarty-linux-x64\n  smoke-test-binaries:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        runner:\n          - smarty-linux-x64\n          - macos-latest\n          - windows-latest'
publish_job=$'\n  publish-npm:\n    runs-on: ubuntu-latest'
approved_jobs="$smoke_job$publish_job"
write_fixture build-binaries.yml "$approved_jobs"
bash "$guard" "$fixture_dir" "$allowlist"
echo 'PASS: all three allowlisted entries (smoke macos-latest/windows-latest; publish-npm ubuntu-latest)'

# smarty-dev#3644: quoted anchors hid hosted labels from the textual guard.
# Keep approved entries used, so the rejection is specifically the alias target.
hosted_anchor=$'env:\n  HOSTED_IMAGE: &image "ubuntu-latest"\n'
for selection in '*image' '[self-hosted, *image]' $'\n      - self-hosted\n      - *image'; do
  expect_rejected "hosted scalar/list/sequence alias $selection" "$hosted_anchor$approved_jobs"$'\n  check:\n    runs-on: '"$selection" 'unapproved hosted runner' build-binaries.yml "$allowlist"
done
expect_rejected 'anchored hosted runs-on' "$approved_jobs"$'\n  check:\n    runs-on: &image ubuntu-latest' 'unapproved hosted runner' build-binaries.yml "$allowlist"
expect_rejected 'matrix value alias' "$hosted_anchor$approved_jobs"$'\n  check:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        runner: [*image]' 'unapproved hosted runner' build-binaries.yml "$allowlist"
expect_rejected 'matrix include alias' "$hosted_anchor$approved_jobs"$'\n  check:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        include:\n          - runner: *image' 'unapproved hosted runner' build-binaries.yml "$allowlist"
expect_rejected 'whole sequence alias' $'env:\n  LABELS: &labels [self-hosted, "ubuntu-latest"]\n'"$approved_jobs"$'\n  check:\n    runs-on: *labels' 'unapproved hosted runner' build-binaries.yml "$allowlist"
expect_rejected 'whole matrix alias' $'env:\n  MATRIX: &matrix {runner: ["ubuntu-latest"]}\n'"$approved_jobs"$'\n  check:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix: *matrix' 'unapproved hosted runner' build-binaries.yml "$allowlist"
expect_rejected 'whole job alias' $'env:\n  JOB: &job {runs-on: "ubuntu-latest"}\n'"$approved_jobs"$'\n  check: *job' 'unapproved hosted runner' build-binaries.yml "$allowlist"

write_fixture build-binaries.yml $'env:\n  FORGE_IMAGE: &image smarty-linux-x64\n'"$approved_jobs"$'\n  check:\n    runs-on: [self-hosted, *image]'
bash "$guard" "$fixture_dir" "$allowlist"
echo 'PASS: safe self-hosted alias'

# smarty-dev#3644: approval belongs to the resolved file/job/label, not syntax.
write_fixture build-binaries.yml $'env:\n  MAC: &mac macos-latest\n  WINDOWS: &windows windows-latest\n  UBUNTU: &ubuntu ubuntu-latest\njobs:\n  smoke-test-binaries:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        runner: [*mac, *windows]\n  publish-npm:\n    runs-on: *ubuntu'
bash "$guard" "$fixture_dir" "$allowlist"
echo 'PASS: all three approvals through aliases'
expect_rejected 'hosted alias in group labels' "$hosted_anchor$approved_jobs"$'\n  check:\n    runs-on: {group: fleet, labels: [*image]}' 'unapproved hosted runner' build-binaries.yml "$allowlist"

expect_rejected 'allowlisted smoke label in another job' "$approved_jobs"$'\n  stage:\n    runs-on: macos-latest' 'unapproved hosted runner' build-binaries.yml "$allowlist"
expect_rejected 'allowlisted publisher label in another job' "$approved_jobs"$'\n  stage:\n    runs-on: ubuntu-latest' 'unapproved hosted runner' build-binaries.yml "$allowlist"
expect_rejected 'allowlisted label in another file' "$approved_jobs" 'unapproved hosted runner' other.yml "$allowlist"
expect_rejected 'third hosted label in allowlisted smoke job' "$smoke_job"$'\n          - ubuntu-latest'"$publish_job" 'unapproved hosted runner' build-binaries.yml "$allowlist"
expect_rejected 'other hosted label next to allowlisted one' "$smoke_job"$'\n          - [macos-latest, ubuntu-24.04]'"$publish_job" 'unapproved hosted runner' build-binaries.yml "$allowlist"
for label in ubuntu-24.04 ubuntu-22.04 ubuntu-24.04-arm macos-latest windows-latest; do
  expect_rejected "publish-npm on $label" "$smoke_job"$'\n  publish-npm:\n    runs-on: '"$label" 'unapproved hosted runner' build-binaries.yml "$allowlist"
done
expect_rejected 'other hosted label next to approved publisher' "$smoke_job"$'\n  publish-npm:\n    runs-on: [ubuntu-latest, ubuntu-24.04]' 'unapproved hosted runner' build-binaries.yml "$allowlist"
expect_rejected 'inline exception marker' "$approved_jobs"$'\n  stage:\n    runs-on: windows-latest # hosted-exception: approved' 'unapproved hosted runner' build-binaries.yml "$allowlist"
# Non-runner data does not select a machine or consume approval entries.
write_fixture build-binaries.yml $'env:\n  os: macos-latest\n'"$approved_jobs"
bash "$guard" "$fixture_dir" "$allowlist"
echo 'PASS: unused hosted label outside jobs'
expect_rejected 'unused smoke allowlist entry' "${smoke_job%$'\n          - windows-latest'}$publish_job" 'unused hosted-runner allowlist entry' build-binaries.yml "$allowlist"
expect_rejected 'unused publisher allowlist entry' "$smoke_job" 'unused hosted-runner allowlist entry' build-binaries.yml "$allowlist"
printf '%s\n' 'build-binaries.yml smoke-test-binaries macos-latest' > "$fixture_dir/no-url.txt"
expect_rejected 'allowlist entry without approval URL' "$approved_jobs" 'malformed allowlist entry' build-binaries.yml "$fixture_dir/no-url.txt"
expect_rejected 'empty allowlist' "$approved_jobs" 'unapproved hosted runner' build-binaries.yml

# smarty-dev#3644: dynamic or malformed runner selection must fail closed.
for expression in '${{ inputs.runner }}' '${{ needs.setup.outputs.runner }}' '${{ matrix.missing }}' '${{ matrix.runner || "smarty-linux-x64" }}'; do
  expect_rejected "unresolved $expression" "jobs:
  check:
    runs-on: $expression" 'unsupported/unresolved'
done
expect_rejected 'dynamic matrix' $'jobs:\n  check:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix: ${{ fromJSON(inputs.matrix) }}' 'unsupported/unresolved matrix'
expect_rejected 'duplicate runs-on key' $'jobs:\n  check:\n    runs-on: ubuntu-latest\n    runs-on: smarty-linux-x64' 'duplicate YAML key'
expect_rejected 'undefined YAML alias' $'jobs:\n  check:\n    runs-on: [*missing]' 'undefined alias'
expect_rejected 'recursive YAML alias' $'jobs:\n  check:\n    runs-on: &labels [*labels]' 'unsupported/unresolved'
expect_rejected 'runner mapping without labels or group' $'jobs:\n  check:\n    runs-on: {runner: smarty-linux-x64}' 'unsupported/unresolved'
expect_rejected 'null runner' $'jobs:\n  check:\n    runs-on: null' 'unsupported/unresolved'
expect_rejected 'empty runner sequence' $'jobs:\n  check:\n    runs-on: []' 'unsupported/unresolved'
expect_rejected 'reusable workflow with unknown runners' $'jobs:\n  check:\n    uses: org/repo/.github/workflows/check.yml@main' 'unsupported/unresolved'
expect_rejected 'case variant hosted label' $'jobs:\n  check:\n    runs-on: Ubuntu-Latest' 'unapproved hosted runner'

write_fixture probe.yml $'jobs:\n  check:\n    runs-on: ${{ matrix.target.runner }}\n    strategy:\n      matrix:\n        target:\n          - {runner: smarty-linux-x64}\n        version: [22, 24]\n        include:\n          - version: 22\n            extra: true'
bash "$guard" "$fixture_dir" "$fixture_dir/empty.txt"
echo 'PASS: object matrix and partial include expansion'
write_fixture probe.yml $'jobs:\n  check:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        runner: [smarty-linux-x64, ubuntu-latest]\n        exclude:\n          - runner: ubuntu-latest'
bash "$guard" "$fixture_dir" "$fixture_dir/empty.txt"
echo 'PASS: excluded hosted matrix entry is not selected'
# pi#138 / smarty-dev#3644: YAML 1.1 booleans must not hide hosted rows.
expect_rejected 'reviewer on/yes exclusion counterexample' 'on: workflow_dispatch
jobs:
  check:
    runs-on: ${{ matrix.runner }}
    strategy:
      matrix:
        runner: [smarty-linux-x64, ubuntu-latest]
        feature: [on]
        exclude:
          - runner: ubuntu-latest
            feature: yes
    steps:
      - run: echo probe' 'unapproved hosted runner'

for pair in 'on yes' 'yes on' 'off no' 'no off' 'ON YES' 'On Yes' 'OFF NO' 'Off No'; do
  read -r value other <<< "$pair"
  expect_rejected "distinct string matrix exclusion $value/$other" "jobs:
  check:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        runner: [smarty-linux-x64, ubuntu-latest]
        feature: [$value]
        exclude:
          - runner: ubuntu-latest
            feature: $other" 'unapproved hosted runner'
  # If these strings collapse to one boolean, the second include overwrites
  # the hosted runner instead of leaving it in an additional matrix row.
  expect_rejected "distinct string matrix inclusion $value/$other" "jobs:
  check:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        feature: [$value]
        include:
          - feature: $other
            runner: ubuntu-latest
          - feature: $value
            runner: smarty-linux-x64" 'unapproved hosted runner'
done

# Actual booleans must still match across case variants in both operations.
for value in true True TRUE tRuE false False FALSE fAlSe; do
  write_fixture probe.yml "jobs:
  check:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        runner: [smarty-linux-x64, ubuntu-latest]
        feature: [$value]
        exclude:
          - runner: ubuntu-latest
            feature: ${value,,}"
  bash "$guard" "$fixture_dir" "$fixture_dir/empty.txt"
  echo "PASS: boolean matrix exclusion $value/${value,,}"
  write_fixture probe.yml "jobs:
  check:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        feature: [$value]
        include:
          - feature: ${value,,}
            runner: ubuntu-latest
          - feature: $value
            runner: smarty-linux-x64"
  bash "$guard" "$fixture_dir" "$fixture_dir/empty.txt"
  echo "PASS: boolean matrix inclusion $value/${value,,}"
done

write_fixture probe.yml $'env:\n  LABELS: &labels [self-hosted, smarty-linux-x64]\njobs:\n  check:\n    runs-on: {group: fleet, labels: *labels}'
bash "$guard" "$fixture_dir" "$fixture_dir/empty.txt"
echo 'PASS: literal runner group with resolved labels'
echo 'All hosted-runner guard probes passed'
