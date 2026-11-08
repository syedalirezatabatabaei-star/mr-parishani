# Semgrep rules (vendored)

`rules/` is a copy of selected rule directories from
[semgrep/semgrep-rules](https://github.com/semgrep/semgrep-rules): `javascript`, `typescript`,
`dockerfile` and `yaml/github-actions`. CI reads only this copy and never downloads rules,
so the scan works without access to the Semgrep registry (ADR-008).

- Upstream commit and date: `rules/UPSTREAM_COMMIT`.
- Licence: `rules/LICENSE` (Semgrep Rules License v1.0). It allows internal use only and
  does not allow redistribution. The licence file must stay with the copy, and this copy
  must not be published if the repository is ever made public.

## Updating

The rules do not update themselves. Refresh them by hand periodically:

```sh
sh scripts/ci/update-semgrep-rules.sh <upstream-commit-sha>
pnpm run ci:sast
```

Review the diff, fix or triage any new findings, and commit the rules and fixes together.
