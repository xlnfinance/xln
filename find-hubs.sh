#!/bin/bash
# Find most connected components (hubs)

echo "🔍 Finding architectural hubs (most imported components)..."
echo

for file in src/*.ts; do
    if [ -f "$file" ]; then
        basename=$(basename "$file" .ts)
        # Count how many files import this one
        count=$(grep -c "from ['\"]\./$basename['\"]" src/*.ts 2>/dev/null | awk '{sum+=$1} END {print sum}')
        if [ "$count" -gt "0" ]; then
            echo "$count $basename"
        fi
    fi
done | sort -rn | head -20