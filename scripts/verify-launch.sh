#!/bin/bash
set -euo pipefail
# Read-only verification: never kill Claude, discard crash logs, or mutate state.
exec bash "$(cd "$(dirname "$0")" && pwd)/diag.sh"
