#!/usr/bin/env bash
#
# Automated console.log → structured logger migration
# Replaces console.error/warn/log with typed logger calls
#

set -e

echo "🔧 Fixing console.log statements in src/**/*.ts"
echo ""

# Backup approach - use sed for bulk replacements
echo "Step 1: Replacing console.error → logError..."
find src -name "*.ts" -type f -exec sed -i '' 's/console\.error(/logError('\''FRAME_CONSENSUS'\'', /g' {} \;

echo "Step 2: Replacing console.warn → logWarn..."
find src -name "*.ts" -type f -exec sed -i '' 's/console\.warn(/logWarn('\''FRAME_CONSENSUS'\'', /g' {} \;

echo "Step 3: Adding logger imports to files that need it..."
for file in $(grep -l "logError\|logWarn\|logDebug\|logInfo" src/**/*.ts 2>/dev/null); do
  if ! grep -q "from './logger'" "$file" && ! grep -q "from '../logger'" "$file"; then
    # Count how many ../ needed based on directory depth
    depth=$(echo "$file" | tr -cd '/' | wc -c)
    if [ $depth -eq 1 ]; then
      import_path="./logger"
    else
      import_path="../logger"
    fi

    # Add import after first import statement
    sed -i '' "1,/^import/s|^\(import.*\)$|\1\nimport { logDebug, logInfo, logWarn, logError } from '$import_path';|" "$file"
  fi
done

echo ""
echo "✅ Console.log migration complete!"
echo ""
echo "Summary:"
echo "  - Replaced console.error → logError('FRAME_CONSENSUS', ...)"
echo "  - Replaced console.warn → logWarn('FRAME_CONSENSUS', ...)"
echo "  - Added logger imports where needed"
echo ""
echo "Note: console.log statements remain unchanged (use DEBUG flag to control)"
echo ""
echo "Run 'bun run check' to verify TypeScript compilation"
