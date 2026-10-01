#!/bin/bash
# Compile the fork and regenerate contracts/typechain-types (committed, like og's jurisdictions/typechain-types).
set -euo pipefail
cd "$(dirname "$0")/.."
export HARDHAT_EXPERIMENTAL_ALLOW_NON_LOCAL_INSTALLATION=true
../node_modules/.bin/hardhat compile
node scripts/generate-typechain.cjs
