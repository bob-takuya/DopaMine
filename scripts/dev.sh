#!/usr/bin/env bash
# One-command local startup for the DopaMine backend.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Activate the project virtualenv if present.
if [ -f "${REPO_ROOT}/.venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/.venv/bin/activate"
fi

# Load backend/.env if present (export all defined vars).
if [ -f "${REPO_ROOT}/backend/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/backend/.env"
  set +a
fi

export DOPAMINE_SRS_ENGINE="${DOPAMINE_SRS_ENGINE:-fsrs}"

cd "${REPO_ROOT}/backend"
exec uvicorn app.main:app --reload --port 8000
