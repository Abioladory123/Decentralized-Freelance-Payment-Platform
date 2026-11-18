#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# scripts/test_contracts.sh
#
# Universal runner for Soroban contract tests.
# Detects OS environment; on Windows/MinGW environments with PE/COFF linker
# limitations, automatically delegates to the Docker Linux container runner.
# On Linux and macOS, executes `cargo test` natively in `contracts/`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OS="$(uname -s 2>/dev/null || echo "Windows")"

case "${OS}" in
  MINGW*|MSYS*|CYGWIN*|Windows*)
    echo "==> Windows environment detected (subject to PE/COFF linker ordinal limits)."
    echo "==> Delegating to Docker Linux container runner (scripts/test_contracts_docker.sh)..."
    exec "${SCRIPT_DIR}/test_contracts_docker.sh" "$@"
    ;;
  *)
    echo "==> Running native cargo test in ${REPO_ROOT}/contracts..."
    cd "${REPO_ROOT}/contracts"
    exec cargo test "$@"
    ;;
esac
