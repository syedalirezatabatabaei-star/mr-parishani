#!/bin/sh
# Task 4-7 acceptance (doc 13; doc 01): a credit purse is «کیف اعتبار», never the
# money-wallet phrase. Fails if that phrase appears in an app's sources or, once built, in
# its build output (.next/server and .next/static; the build cache is not checked).
#
#   sh scripts/ci/no-wallet-wording.sh apps/web            (from the repository root)
#
# Runs in the app's lint. Without a build only the sources are checked, and it says so.
set -eu
app="${1:?usage: no-wallet-wording.sh <app dir>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
dir="$root/$app"
# Built from its words, so this script never matches itself or ships the phrase.
phrase="$(printf '%s %s' 'کیف' 'پول')"
joined="$(printf '%s\342\200\214%s' 'کیف' 'پول')"

found=0
check() {
  if [ -e "$1" ] && grep -rIl -e "$phrase" -e "$joined" "$1" --exclude='*.test.*' >/dev/null 2>&1; then
    echo "The money-wallet phrase appears in $1:" >&2
    grep -rIl -e "$phrase" -e "$joined" "$1" --exclude='*.test.*' >&2 || true
    found=1
  fi
}

for part in app lib components; do check "$dir/$part"; done
if [ -d "$dir/.next/server" ] || [ -d "$dir/.next/static" ]; then
  check "$dir/.next/server"
  check "$dir/.next/static"
else
  echo "no build in $app/.next: sources checked only"
fi

if [ "$found" -ne 0 ]; then exit 1; fi
echo "No money-wallet phrase in $app."
