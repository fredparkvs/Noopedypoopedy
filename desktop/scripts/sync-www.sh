#!/usr/bin/env bash
# Copies the app's interface (shared with the Android app) into the Mac app.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf www
cp -R ../android/app/src/main/assets/www www
