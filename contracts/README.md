# Soroban Smart Contracts

This directory contains the Soroban smart contracts for the decentralized freelance payment platform.

## Workspace Layout

| Directory | Crate | Purpose |
|-----------|-------|---------|
| `interface/` | `freelance-interface` | Shared types, data structures, errors (`EscrowError`), and `#[contractclient]` traits. Plain `rlib` without exported ABI symbols. |
| `escrow/` | `freelance-escrow` | Core milestone-based escrow state machine, deposits, partial/full releases, expiry refunds, and dispute timeouts. |
| `dispute/` | `freelance-dispute` | Multi-arbitrator panel (M-of-N approvals), dispute resolution, and callback execution into the escrow contract. |
| `reputation/` | `freelance-reputation` | On-chain 1–5 star ratings, amount-weighted aggregates, and per-pair anti-farming controls. |

## Prerequisites

- **Rust & Cargo**: stable ≥ 1.80 (configured in `contracts/rust-toolchain.toml`).
- **Target**: `wasm32v1-none` (installed automatically by rustup on first build).
- **Stellar CLI**: ≥ 25.2.0 (v28 recommended) for `stellar contract build`.

## Building Contracts

```bash
cd contracts
stellar contract build
```

The compiled WASM artifacts land in `target/wasm32v1-none/release/*.wasm`.

Soroban enforces a **64 KB (65,536 bytes) compressed** contract bytecode limit on testnet and mainnet. CI verifies that every compiled contract binary stays within this limit:

```bash
for wasm in target/wasm32v1-none/release/*.wasm; do
  gzip -c "$wasm" | wc -c
done
```

## Testing

```bash
cd contracts
cargo test
cargo test -p escrow
cargo test -p dispute --test full_flow
```

### Windows Developers: PE/COFF Linker Limitation

When building or executing `cargo test` natively on Windows (using GNU/MinGW or MSVC toolchains), the linker will fail with:

```text
ld: error: export ordinal too large: 73648
```

#### Why This Happens
The Windows Portable Executable (PE/COFF) format enforces a strict 16-bit integer limit on exported symbol table ordinals (maximum 65,535 exports). The Soroban test environment (`soroban-sdk` test fixtures and host mock runtime) pulls in thousands of host functions and type descriptors, which exceeds the Windows PE export ordinal ceiling. Linux ELF binaries do not have this limitation.

#### How to Run Tests on Windows

Windows contributors have two turnkey options:

1. **Docker Container Runner (Recommended)**:
   Run the tests inside an official `rust:1.80` Linux container where the ELF linker runs natively:
   
   Using bash / Git Bash:
   ```bash
   ./scripts/test_contracts_docker.sh
   # Or pass cargo test flags:
   ./scripts/test_contracts_docker.sh -p escrow
   ```

   Using Command Prompt / PowerShell:
   ```cmd
   scripts\test_contracts_docker.bat
   ```

2. **Windows Subsystem for Linux (WSL2)**:
   Open your WSL2 terminal (Ubuntu/Debian) and run tests directly:
   ```bash
   cd contracts
   cargo test
   ```

## Formatting & Linting

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
```
