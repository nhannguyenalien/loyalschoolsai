#!/bin/sh
# Gom file tĩnh vào dist/ để chỉ những file này được public (không kèm .dev.vars, node_modules, src, test).
set -e
cd "$(dirname "$0")/.."
rm -rf dist && mkdir dist
cp *.html _headers dist/
cp -r assets dist/assets
