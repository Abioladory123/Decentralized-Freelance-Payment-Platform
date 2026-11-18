@echo off
REM SPDX-License-Identifier: MIT
REM
REM scripts\test_contracts_docker.bat
REM
REM Windows batch script to run Soroban contract tests inside an official Linux Rust container.
REM
REM Why this exists (issue #283):
REM Native cargo test on Windows fails with PE/COFF linker export limit:
REM ld: error: export ordinal too large: 73648
REM
REM Usage:
REM   scripts\test_contracts_docker.bat [cargo test arguments...]

setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "REPO_ROOT=%%~fI"

where docker >nul 2>nul
if %ERRORLEVEL% neq 0 (
  echo Error: Docker is required to run contract tests in a containerized environment.
  echo Please install Docker Desktop or run cargo test inside WSL2.
  exit /b 1
)

echo ==^> Running contract tests inside rust:1.80 Linux container...
echo ==^> Repository root: %REPO_ROOT%

docker run --rm -v "%REPO_ROOT%/contracts:/app/contracts" -w /app/contracts rust:1.80 cargo test %*
if %ERRORLEVEL% neq 0 (
  exit /b %ERRORLEVEL%
)

endlocal
