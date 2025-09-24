#!/bin/bash

# Kill any existing processes
pkill -f "bun.*server" 2>/dev/null
pkill -f "npm run dev" 2>/dev/null
pkill -f vite 2>/dev/null
sleep 1

# Start backend with prepopulate
echo "🚀 Starting backend with prepopulate..."
cd /Users/egor/xln

# First, let's run prepopulate via XLN.prepopulate
cat > test-prep.ts << 'EOF'
import { runDemo } from './src/rundemo';

// Override the demo to use prepopulate
(async () => {
  const env = await (global as any).XLN.initEnv();

  console.log('📦 Running prepopulate...');
  const { prepopulate } = await import('./src/prepopulate');
  const { processUntilEmpty } = await import('./src/server');

  await prepopulate(env, processUntilEmpty);

  console.log('✅ Prepopulate complete!');
  console.log(`  • Height: ${env.height}`);
  console.log(`  • Snapshots: ${env.history.length}`);
  console.log(`  • Replicas: ${env.replicas.size}`);

  // Keep running
  await new Promise(() => {});
})();
EOF

NO_DEMO=1 bun run src/server.ts &
BACKEND_PID=$!

echo "Backend started with PID $BACKEND_PID"
echo "Waiting for backend to initialize..."
sleep 3

# Run prepopulate via API call or direct invocation
echo "Running prepopulate..."
curl -X POST http://localhost:8080/prepopulate 2>/dev/null || echo "Prepopulate endpoint not available"

echo "✅ Ready! Frontend should be available at http://localhost:8081"
echo "Press Ctrl+C to stop all processes"

# Wait for Ctrl+C
trap "kill $BACKEND_PID; pkill -f vite; exit" INT
wait $BACKEND_PID