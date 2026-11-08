#!/bin/sh
# Static analysis with the rules vendored in .semgrep/rules; nothing is fetched from the
# Semgrep registry. Any finding fails the stage. Paths to skip are in .semgrepignore.
. "$(dirname "$0")/lib.sh"

# Rules that do not apply here (task 9-3, R14; reviewed: each of their findings was a false
# positive). Every other rule, every security rule among them, still runs; their false
# positives are marked line by line with `nosemgrep` and a reason.
# - jsx-label-not-i18n: i18next portability; the interface is Persian only, no i18n library.
# - no-replaceall: String.prototype.replaceAll missing in old runtimes; Node 24 has it.
# - react-props-spreading: style; conditional spreads are how exactOptionalPropertyTypes is met.
# - javascript-confirm: matches every `.confirm(` call (services' own methods), not window.confirm.
# - missing-template-string-indicator: reads `{{field}}`, `{id}` and SQL `$1` as forgotten
#   template literals.
# - no-stringify-keys: misreads `rows[0]` and plain reads as JSON.stringify of objects.
run_scanner "$SEMGREP_IMAGE" semgrep scan \
  --config /src/.semgrep/rules \
  --exclude-rule semgrep.rules.javascript.lang.correctness.no-replaceall \
  --exclude-rule semgrep.rules.typescript.react.portability.i18next.jsx-label-not-i18n \
  --exclude-rule semgrep.rules.typescript.react.best-practice.react-props-spreading \
  --exclude-rule semgrep.rules.javascript.lang.best-practice.javascript-confirm \
  --exclude-rule semgrep.rules.javascript.lang.correctness.missing-template-string-indicator \
  --exclude-rule semgrep.rules.javascript.lang.correctness.no-stringify-keys \
  --metrics=off \
  --disable-version-check \
  --error \
  /src
