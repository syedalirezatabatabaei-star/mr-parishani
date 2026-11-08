# Shared by the CI scripts. Source it; do not run it.
# Scanners run as Docker images pinned by digest, never as CI-vendor actions, so the same
# scripts work in GitHub Actions, a future GitLab CI and on a developer machine.
set -eu

GITLEAKS_IMAGE=zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f
OSV_SCANNER_IMAGE=ghcr.io/google/osv-scanner:v2.6.0@sha256:afd838850ac1a0fcc15ff4a041dc9ba11123c3f0d2666217a5f0fcf9222b55fa
TRIVY_IMAGE=aquasec/trivy:0.58.1@sha256:ab70a02200597efa04748f210f793936eb647cbcdb0ea69cc30b226d6f5a22c7
SEMGREP_IMAGE=semgrep/semgrep:1.177.0@sha256:acaac22ffc7b7cc5926de0751b223bce0b2491c33d18422fa72f632c78d81198

cd "$(dirname "$0")/../.."

# Git Bash on Windows rewrites /paths in arguments and reports /c/... paths that Docker
# cannot mount; `pwd -W` gives the Windows form there and fails elsewhere.
export MSYS_NO_PATHCONV=1
REPO_ROOT=$(pwd -W 2>/dev/null || pwd)

# Runs a scanner image with the repository mounted read-only at /src.
run_scanner() {
  image=$1
  shift
  docker run --rm -v "$REPO_ROOT:/src:ro" -w /src "$image" "$@"
}
