#!/usr/bin/env bash
# Installs everything the tests and the helper scripts need. Safe to run more than once.
cd "$(dirname "$0")/.." || exit 1
set -e
echo "== python packages"
python3 -m pip install --quiet --upgrade pip
python3 -m pip install --quiet -r requirements.txt
echo "== node packages"
npm install --no-audit --no-fund
echo "== done. Next:  python -m pytest -q    and    npm run deploy"
