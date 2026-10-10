#!/usr/bin/env bash
# Pin @sap/cds and all installed @sap-ai-sdk/* packages to given versions, without changing
# package.json or the lock file. Used by the CI compatibility matrix.
#
#   scripts/pin-versions.sh <dir> <cds-version|lockfile> <sdk-version|lockfile>
#
# All @sap-ai-sdk packages must have the same version: they share internal APIs.
set -euo pipefail
DIR=$1; CDS=$2; SDK=$3
cd "$DIR"
PKGS=()
if [ "$SDK" != "lockfile" ]; then
  for d in node_modules/@sap-ai-sdk/*; do
    PKGS+=("@sap-ai-sdk/$(basename "$d")@$SDK")
  done
fi
if [ "$CDS" != "lockfile" ]; then
  PKGS+=("@sap/cds@$CDS")
  # @cap-js/sqlite 3 needs CAP 10; CAP 9 apps use 2.x
  if [ -d node_modules/@cap-js/sqlite ] && [ "${CDS%%.*}" = "9" ]; then PKGS+=("@cap-js/sqlite@^2"); fi
fi
if [ ${#PKGS[@]} -gt 0 ]; then
  echo "pinning in $DIR: ${PKGS[*]}"
  npm install --no-save --no-audit --no-fund --legacy-peer-deps "${PKGS[@]}"
fi
echo "$DIR: node $(node --version), @sap/cds $(node -p "require('@sap/cds/package.json').version"), @sap-ai-sdk/orchestration $(grep -m1 '"version"' node_modules/@sap-ai-sdk/orchestration/package.json | cut -d'"' -f4)"
