#!/usr/bin/env bash
set -euo pipefail

# Explicit CI-only build. No download, package install or lifecycle hook.
if [[ $# != 5 ]]; then
  printf '%s\n' 'usage: build.sh x64|arm64 glibc|musl ABS_NODE_HEADERS ABS_HEADER_SHA256SUMS ABS_OUTPUT_DIR' >&2
  exit 2
fi
arch=$1
libc=$2
headers=$3
header_sums=$4
out=$5
case "$arch/$libc" in x64/glibc|x64/musl|arm64/glibc|arm64/musl) ;; *) exit 2 ;; esac
for path in "$headers" "$header_sums" "$out"; do
  [[ "$path" == /* && "$path" != *'/../'* && "$path" != *'@'* ]] || exit 2
done
: "${CC:?Set CC to the admitted native compiler executable, not a shell command}"
[[ "$CC" == /* && -x "$CC" ]] || exit 2
src=$(cd -- "$(dirname -- "$0")" && pwd -P)
[[ $(wc -l < "$header_sums") -eq 4 ]] || exit 2
for file in node_api.h node_api_types.h js_native_api.h js_native_api_types.h; do
  [[ -f "$headers/$file" && ! -L "$headers/$file" ]] || exit 2
  grep -Eq "^[0-9a-f]{64}  ${file//./\\.}$" "$header_sums" || exit 2
done
(cd -- "$headers" && sha256sum --strict --check "$header_sums")
triple=$("$CC" -dumpmachine)
case "$arch:$triple" in x64:x86_64-*|arm64:aarch64-*) ;; *) exit 2 ;; esac
case "$libc:$triple" in glibc:*-linux-gnu*|musl:*-linux-musl*) ;; *) exit 2 ;; esac
mkdir -p -- "$out"
output="$out/owner-effects.node"
[[ ! -e "$output" ]] || { printf '%s\n' 'Refusing to replace an existing native candidate' >&2; exit 2; }
"$CC" -std=c11 -O2 -Wall -Wextra -Werror -fPIC -fvisibility=hidden \
  -fstack-protector-strong -fno-builtin -D_FORTIFY_SOURCE=2 \
  -DNAPI_VERSION=8 -DNODE_GYP_MODULE_NAME=owner_effects \
  -I "$headers" -shared -pthread -Wl,-z,relro,-z,now \
  "$src/owner-effects.c" -o "$output"
chmod 755 "$output"
(cd -- "$out" && sha256sum owner-effects.node > SHA256SUMS)
printf '%s\n' 'Candidate only: native tests, child disassembly, libc/ELF closure and Node/Bun qualification still required.'
