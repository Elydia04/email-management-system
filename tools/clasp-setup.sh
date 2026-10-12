#!/usr/bin/env bash
#
# tools/clasp-setup.sh — one-time deploy setup.
#
# Installs clasp, logs in, creates the Apps Script project (if needed), and
# pushes the sources. Run from anywhere:  bash tools/clasp-setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Install Node.js first: https://nodejs.org" >&2
  exit 1
fi

echo "==> 1/5 Installing clasp (local dev dependency)..."
npm install --no-audit --no-fund

echo "==> 2/5 The Apps Script API must be ON for your account:"
echo "        https://script.google.com/home/usersettings"
read -r -p "    Press Enter once it is enabled..." _ || true

echo "==> 3/5 Logging in (your browser will open)..."
npx clasp login

echo "==> 4/5 Ensuring the Apps Script project exists..."
if [ -f .clasp.json ]; then
  echo "    .clasp.json already present; reusing it."
else
  npx clasp create --type standalone --title "Invoice Tracker" --rootDir .
fi

echo "==> 5/5 Pushing files..."
npx clasp push --force

echo
echo "Done. Opening the editor — run setup() from there."
npx clasp open-container || true
