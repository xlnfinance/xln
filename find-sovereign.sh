#!/bin/bash
# Find files with zero dependents (sovereign components)

echo "🔍 Finding sovereign components (zero dependents)..."
echo

for file in src/*.ts; do
    if [ -f "$file" ]; then
        basename=$(basename "$file" .ts)
        # Count how many files import this one
        count=$(grep -l "from ['\"]\./$basename['\"]" src/*.ts 2>/dev/null | wc -l | xargs)
        if [ "$count" = "0" ]; then
            echo "👑 $basename (SOVEREIGN - 0 dependents)"
        fi
    fi
done

echo
echo "🔍 Finding components with few dependents..."
echo

for file in src/*.ts; do
    if [ -f "$file" ]; then
        basename=$(basename "$file" .ts)
        count=$(grep -l "from ['\"]\./$basename['\"]" src/*.ts 2>/dev/null | wc -l | xargs)
        if [ "$count" != "0" ] && [ "$count" -le "2" ]; then
            echo "🔗 $basename ($count dependents)"
        fi
    fi
done