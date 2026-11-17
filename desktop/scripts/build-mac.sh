#!/usr/bin/env bash
# Builds "Reef Light.app" for Apple Silicon and Intel Macs, zipped for download.
# Optional: ELECTRON_ZIP_DIR=folder holding electron-v<version>-darwin-*.zip to
# skip downloading them.
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/sync-www.sh
VERSION=$(node -p "require('./package.json').version")
rm -rf dist
for ARCH in arm64 x64; do
  npx --no-install electron-packager . "Reef Light" \
    --platform=darwin --arch="$ARCH" \
    --icon=assets/icon.icns \
    --app-bundle-id=dev.reeflight.mac \
    --app-version="$VERSION" --build-version="$VERSION" \
    --app-category-type=public.app-category.lifestyle \
    --app-copyright="Reef Light, an independent app for Noo-Psyche K7 lights" \
    --out=dist --overwrite --prune=true --asar \
    --ignore='^/test' --ignore='^/scripts' --ignore='^/dist' \
    --ignore='^/assets/.*\.svg$' --ignore='^/assets/icon-1024\.png$' \
    ${ELECTRON_ZIP_DIR:+--electron-zip-dir="$ELECTRON_ZIP_DIR"}
  # -y keeps the symlinks inside Electron's frameworks; without them the app will not start
  (cd "dist/Reef Light-darwin-$ARCH" && zip -qry "../ReefLight-$VERSION-mac-$ARCH.zip" "Reef Light.app")
done
ls -l dist/*.zip
