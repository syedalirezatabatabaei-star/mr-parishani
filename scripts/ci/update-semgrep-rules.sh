#!/bin/sh
# Refreshes the vendored Semgrep rules in .semgrep/rules from the upstream rules repo.
# CI never downloads rules; run this by hand, review the diff, and commit it.
#
#   sh scripts/ci/update-semgrep-rules.sh <commit-sha>
#
# Needs git and network access. See .semgrep/README.md.
set -eu

UPSTREAM=https://github.com/semgrep/semgrep-rules.git
# Rule directories that apply to this repo's languages and files.
RULE_DIRS='javascript typescript dockerfile yaml/github-actions'

sha=${1:?usage: update-semgrep-rules.sh <commit-sha>}
root=$(cd "$(dirname "$0")/../.." && pwd)
dest=$root/.semgrep/rules
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git -C "$work" init -q
git -C "$work" fetch -q --depth 1 "$UPSTREAM" "$sha"
git -C "$work" checkout -q FETCH_HEAD

rm -rf "$dest"
mkdir -p "$dest"
cp "$work/LICENSE" "$dest/LICENSE"

# Copy rule files only: test fixtures sit next to the rules and have no `rules:` key.
for dir in $RULE_DIRS; do
  (cd "$work" && find "$dir" -type f \( -name '*.yaml' -o -name '*.yml' \) \
    ! -name '*.test.*' ! -name '*.fixed.*') | while read -r file; do
    if grep -q '^rules:' "$work/$file"; then
      mkdir -p "$dest/$(dirname "$file")"
      cp "$work/$file" "$dest/$file"
    fi
  done
done

printf '%s %s\n' "$(git -C "$work" rev-parse HEAD)" "$(git -C "$work" log -1 --format=%cs)" \
  >"$dest/UPSTREAM_COMMIT"
echo "Vendored $(find "$dest" -name '*.y*ml' | wc -l | tr -d ' ') rules from $sha"
