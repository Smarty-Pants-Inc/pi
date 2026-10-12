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
  if output="$(bash "$guard" "$fixture_dir" "${5:-$fixture_dir/empty.txt}" "${6:-$fixture_dir/empty.txt}" 2>&1)"; then
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

# smarty-dev#1246 / #3644: anchors and aliases are rejected anywhere, not
# resolved, so none can hide a hosted label. Keep approved entries used so the
# alias is the only failure; a self-hosted alias is rejected too.
alias_diagnostic='YAML anchor/alias is not allowed (smarty-dev#1246)'
hosted_anchor=$'env:\n  HOSTED_IMAGE: &image "ubuntu-latest"\n'
for selection in '*image' '[self-hosted, *image]' $'\n      - self-hosted\n      - *image' '{group: fleet, labels: [*image]}'; do
  expect_rejected "hosted alias in runs-on $selection" "$hosted_anchor$approved_jobs"$'\n  check:\n    runs-on: '"$selection" "$alias_diagnostic" build-binaries.yml "$allowlist"
done
expect_rejected 'anchored hosted runs-on' "$approved_jobs"$'\n  check:\n    runs-on: &image ubuntu-latest' "$alias_diagnostic" build-binaries.yml "$allowlist"
expect_rejected 'alias hiding smarty-linux-x64' $'env:\n  FORGE_IMAGE: &image smarty-linux-x64\n'"$approved_jobs"$'\n  check:\n    runs-on: [self-hosted, *image]' "$alias_diagnostic" build-binaries.yml "$allowlist"
expect_rejected 'matrix value alias' "$hosted_anchor$approved_jobs"$'\n  check:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        runner: [*image]' "$alias_diagnostic" build-binaries.yml "$allowlist"
expect_rejected 'matrix include alias' "$hosted_anchor$approved_jobs"$'\n  check:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        include:\n          - runner: *image' "$alias_diagnostic" build-binaries.yml "$allowlist"
expect_rejected 'whole matrix alias' $'env:\n  MATRIX: &matrix {runner: ["ubuntu-latest"]}\n'"$approved_jobs"$'\n  check:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix: *matrix' "$alias_diagnostic" build-binaries.yml "$allowlist"
expect_rejected 'whole job alias' $'env:\n  JOB: &job {runs-on: "ubuntu-latest"}\n'"$approved_jobs"$'\n  check: *job' "$alias_diagnostic" build-binaries.yml "$allowlist"
expect_rejected 'undefined YAML alias' $'jobs:\n  check:\n    runs-on: [*missing]' "$alias_diagnostic"

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

# pi#138 / smarty-dev#3644: Core Schema values must not collapse to YAML
# 1.1 values, arbitrary-case booleans, or their quoted string spellings.
# Exercise both exclusion and inclusion through the actual guard. The approved
# jobs stay in use so a scalar mismatch must expose the unapproved hosted row.
for pair in \
  '010|8' 'tRuE|true' 'fAlSe|false' 'True|tRuE' 'TRUE|tRuE' \
  '0o10|"0o10"' '0x10|"16"' '1_000|1000' '.inf|".inf"' '~|"~"' \
  'on|true' 'yes|true' '1_0|10' '1:00|60' '0b10|2' '+0x10|16' \
  '1e3|"1e3"' 'null|"null"'; do
  IFS='|' read -r value other <<< "$pair"
  expect_rejected "Core Schema matrix exclusion $value/$other" "$approved_jobs
  check:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        runner: [smarty-linux-x64, ubuntu-latest]
        feature: [$value]
        exclude:
          - runner: ubuntu-latest
            feature: $other" 'unapproved hosted runner' build-binaries.yml "$allowlist"
  expect_rejected "Core Schema matrix inclusion $value/$other" "$approved_jobs
  check:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        feature: [$value]
        include:
          - feature: $other
            runner: ubuntu-latest
          - feature: $value
            runner: smarty-linux-x64" 'unapproved hosted runner' build-binaries.yml "$allowlist"
done

# pi#138: Actions parses hex through signed Int32, unlike Python integers.
# Fail closed outside the nonnegative Int32 range, before either exclude or
# include can hide a hosted row. Keep the reviewer's inclusion order verbatim.
for pair in '0x80000000|2147483648' '0xffffffff|4294967295' '0x100000000|4294967296'; do
  IFS='|' read -r hex decimal <<< "$pair"
  expect_rejected "unsupported hex matrix exclusion $hex/$decimal" "jobs:
  check:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        runner: [smarty-linux-x64, ubuntu-latest]
        feature: [$hex]
        exclude:
          - runner: ubuntu-latest
            feature: $decimal" 'unsupported hexadecimal integer'
  expect_rejected "unsupported hex matrix inclusion $decimal/$hex" "jobs:
  check:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        feature: [$decimal]
        include:
          - feature: $hex
            runner: ubuntu-latest
          - feature: $decimal
            runner: smarty-linux-x64" 'unsupported hexadecimal integer'
done

# Equal Core Schema values must still match, including decimal leading zeroes,
# octal/hex, exponent floats, nulls and strings previously coerced by YAML 1.1.
for pair in \
  '010|10' '+010|10' '-010|-10' '0o10|8' '0x10|16' '1e3|1000' \
  '0x0|0' '0x7fffffff|2147483647' \
  '1.0e3|1000' '.5|0.5' '1.|1.0' '.inf|.INF' '-.Inf|-.INF' \
  '~|null' 'Null|NULL' 'null|' '1_000|"1_000"' '1:00|"1:00"' \
  '2001-01-01|"2001-01-01"' 'tRuE|"tRuE"' 'on|"on"' 'yes|"yes"'; do
  IFS='|' read -r value other <<< "$pair"
  write_fixture probe.yml "jobs:
  check:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        runner: [smarty-linux-x64, ubuntu-latest]
        feature: [$value]
        exclude:
          - runner: ubuntu-latest
            feature: $other"
  bash "$guard" "$fixture_dir" "$fixture_dir/empty.txt"
  echo "PASS: Core Schema matching exclusion $value/$other"
  write_fixture probe.yml "jobs:
  check:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        feature: [$value]
        include:
          - feature: $other
            runner: ubuntu-latest
          - feature: $value
            runner: smarty-linux-x64"
  bash "$guard" "$fixture_dir" "$fixture_dir/empty.txt"
  echo "PASS: Core Schema matching inclusion $value/$other"
done

# Actual booleans must still match across the six YAML 1.2 spellings.
for value in true True TRUE false False FALSE; do
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

# pi#138: a runner group may be a GitHub-hosted larger-runner group. Refuse a
# group unless our self-hosted group list names it (empty by default),
# whatever labels it carries.
group_diagnostic='runner group not on the self-hosted group allowlist'
printf '%s\n' '# probe' fleet > "$fixture_dir/groups.txt"
expect_rejected 'group-only runs-on' $'jobs:\n  check:\n    runs-on: {group: larger-ubuntu}' "$group_diagnostic"
expect_rejected 'group-only runs-on with checked-in group list' $'jobs:\n  check:\n    runs-on:\n      group: larger-ubuntu' "$group_diagnostic" probe.yml "$fixture_dir/empty.txt" "$repo_root/scripts/ci/self-hosted-runner-groups.txt"
expect_rejected 'group with self-hosted labels only' $'jobs:\n  check:\n    runs-on: {group: larger-ubuntu, labels: [self-hosted, smarty-linux-x64]}' "$group_diagnostic"
expect_rejected 'unlisted group next to listed group' $'jobs:\n  check:\n    runs-on: {group: larger-ubuntu}' "$group_diagnostic" probe.yml "$fixture_dir/empty.txt" "$fixture_dir/groups.txt"
expect_rejected 'matrix-derived group-only runs-on' $'jobs:\n  check:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        runner:\n          - smarty-linux-x64\n          - {group: larger-ubuntu}' "$group_diagnostic"
printf '%s\n' 'two words' > "$fixture_dir/bad-groups.txt"
expect_rejected 'malformed group list entry' $'jobs:\n  check:\n    runs-on: smarty-linux-x64' 'malformed runner group entry' probe.yml "$fixture_dir/empty.txt" "$fixture_dir/bad-groups.txt"
write_fixture probe.yml $'jobs:\n  check:\n    runs-on: {group: fleet}'
bash "$guard" "$fixture_dir" "$fixture_dir/empty.txt" "$fixture_dir/groups.txt"
echo 'PASS: listed group-only runs-on'
write_fixture probe.yml $'jobs:\n  check:\n    runs-on: {group: fleet, labels: [self-hosted, smarty-linux-x64]}'
bash "$guard" "$fixture_dir" "$fixture_dir/empty.txt" "$fixture_dir/groups.txt"
echo 'PASS: listed group with literal labels'
expect_rejected 'unlisted group with an allowlisted hosted label' "$smoke_job"$'\n  publish-npm:\n    runs-on: {group: npm-publish, labels: [ubuntu-latest]}' "$group_diagnostic" build-binaries.yml "$allowlist"

# pi#138: on a pull request the group list comes from the trusted base
# (BASE_SHA), so a change cannot list a group and use it at once.
base_repo="$fixture_dir/repo"
mkdir -p "$base_repo/scripts/ci"
cp -- "$repo_root/scripts/ci/no-hosted-runners.sh" "$repo_root/scripts/ci/no-hosted-runners.py" "$base_repo/scripts/ci/"
repo_git() { git -C "$base_repo" -c user.name=probe -c user.email=probe@invalid -c commit.gpgsign=false "$@"; }
repo_git init -q
repo_git add scripts/ci
repo_git commit -q -m 'no group list'
no_list_sha="$(repo_git rev-parse HEAD)"
cp -- "$repo_root/scripts/ci/self-hosted-runner-groups.txt" "$base_repo/scripts/ci/"
repo_git add scripts/ci
repo_git commit -q -m 'empty group list'
base_sha="$(repo_git rev-parse HEAD)"
echo fleet >> "$base_repo/scripts/ci/self-hosted-runner-groups.txt"
repo_git commit -q -am 'PR lists fleet'
head_sha="$(repo_git rev-parse HEAD)"
base_guard="$base_repo/scripts/ci/no-hosted-runners.sh"
write_fixture probe.yml $'jobs:\n  check:\n    runs-on: {group: fleet}'
for case in "base $base_sha" "base-without-list $no_list_sha" "unknown-base 0000000000000000000000000000000000000000"; do
  read -r name sha <<< "$case"
  if output="$(BASE_SHA="$sha" bash "$base_guard" "$fixture_dir" "$fixture_dir/empty.txt" 2>&1)"; then
    echo "FAIL: group listed only by the PR head was accepted ($name)" >&2
    exit 1
  fi
  [[ "$output" == *"$group_diagnostic"* ]] || { printf 'FAIL: %s\n%s\n' "$name" "$output" >&2; exit 1; }
  echo "PASS: rejected group listed only by the PR head ($name)"
done
BASE_SHA="$head_sha" bash "$base_guard" "$fixture_dir" "$fixture_dir/empty.txt"
echo 'PASS: group listed at the base'
BASE_SHA= bash "$base_guard" "$fixture_dir" "$fixture_dir/empty.txt"
echo 'PASS: push to main reads the checked-out (reviewed) list'

# pi#138: the hosted-label allowlist also comes from the trusted base, so a PR
# cannot approve its own hosted label.
printf '%s\n' '# probe hosted allowlist' > "$base_repo/scripts/ci/hosted-runner-allowlist.txt"
repo_git add scripts/ci
repo_git commit -q -m 'empty hosted allowlist'
hosted_base_sha="$(repo_git rev-parse HEAD)"
echo 'probe.yml check ubuntu-latest https://github.com/Smarty-Pants-Inc/pi/pull/138#issuecomment-1' >> "$base_repo/scripts/ci/hosted-runner-allowlist.txt"
repo_git commit -q -am 'PR approves its own hosted label'
hosted_head_sha="$(repo_git rev-parse HEAD)"
write_fixture probe.yml $'jobs:\n  check:\n    runs-on: ubuntu-latest'
for case in "base $hosted_base_sha" "base-without-list $no_list_sha" "unknown-base 0000000000000000000000000000000000000000"; do
  read -r name sha <<< "$case"
  if output="$(BASE_SHA="$sha" bash "$base_guard" "$fixture_dir" 2>&1)"; then
    echo "FAIL: hosted label approved only by the PR head was accepted ($name)" >&2
    exit 1
  fi
  [[ "$output" == *'unapproved hosted runner'* ]] || { printf 'FAIL: %s\n%s\n' "$name" "$output" >&2; exit 1; }
  echo "PASS: rejected hosted label approved only by the PR head ($name)"
done
BASE_SHA="$hosted_head_sha" bash "$base_guard" "$fixture_dir"
echo 'PASS: hosted label approved at the base'
BASE_SHA= bash "$base_guard" "$fixture_dir"
echo 'PASS: push to main reads the checked-out (reviewed) hosted allowlist'
echo 'All hosted-runner guard probes passed'
