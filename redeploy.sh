#!/usr/bin/env bash
set -euo pipefail

# Prevent overlapping deploy runs when pushes arrive close together.
exec 9>/tmp/ovo-deploy.lock
flock -n 9 || exit 0

cd /root/OvO
chmod +x /root/OvO/redeploy.sh

# Stop existing bot screen session if it exists.
screen -S ovo -X quit >/dev/null 2>&1 || true

git pull --ff-only origin main
screen -dmS ovo bash -lc 'cd /root/OvO && pnpm run dev'
