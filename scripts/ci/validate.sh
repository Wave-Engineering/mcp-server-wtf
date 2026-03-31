#!/usr/bin/env bash
set -euo pipefail
echo "=== WTF CI Validation ==="
scripts/ci/lint.sh
scripts/ci/test.sh
echo "=== Validation complete ==="
