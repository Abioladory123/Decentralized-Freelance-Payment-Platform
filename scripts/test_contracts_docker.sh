#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# scripts/test_contracts_docker.sh
#
# Runs Soroban contract tests inside an official Linux Rust container.
#
# Why this exists (issue #283):
# Building and running `cargo test` in `contracts` directly on Windows (especially
# GNU/MinGW toolchains) fails due to Windows PE/COFF symbol table export limits
# (`ld: error: export ordinal too large: 73648`) caused by the Soroban test
# environment's host functions.
#
# This script mounts the workspace contracts directory into a Linux container
# where the ELF linker handles the large symbol table without issue.
#
# Usage:
#   ./scripts/test_contracts_docker.sh [cargo test arguments...]
#
# Examples:
#   ./scripts/test_contracts_docker.sh
#   ./scripts/test_contracts_docker.sh -p escrow
#   ./scripts/test_contracts_docker.sh -p dispute --test full_flow

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Check if docker is available
if ! command -v docker &> /dev/null; then
  echo "Error: Docker is required to run contract tests in a containerized Linux environment." >&2
  echo "Install Docker Desktop or use WSL2 (Ubuntu) to run: cd contracts && cargo test" >&2
  exit 1
fi

echo "==> Running contract tests inside rust:1.80 Linux container..."
echo "==> Working directory: ${REPO_ROOT}/contracts"

# Run cargo test inside the official rust:1.80 container.
# Mounts the contracts folder to /app/contracts and caches cargo registry/target to speed up repeat runs.
docker run --rm \
  -v "${REPO_ROOT}/contracts:/app/contracts" \
  -w /app/contracts \
  rust:1.80 \
  cargo test "$@"
