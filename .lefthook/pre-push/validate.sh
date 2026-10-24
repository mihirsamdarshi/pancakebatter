#!/usr/bin/env bash
# lefthook pre-push script (see .lefthook.toml). lefthook forwards git's
# pre-push stdin (one "<local ref> <local oid> <remote ref> <remote oid>" line
# per pushed ref) because the script sets use_stdin.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
exec mise exec -- bash scripts/validate-kubernetes.sh --pre-push
