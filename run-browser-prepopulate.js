// Run this in the browser console to execute prepopulate

(async () => {
  try {
    console.log('🚀 Running prepopulate from browser...');

    if (!window.XLN) {
      console.error('XLN not available. Make sure the page is loaded.');
      return;
    }

    // Import prepopulate module
    const prepopulateModule = await import('/src/prepopulate.ts');
    const serverModule = await import('/src/server.ts');

    // Get the current environment
    const env = window.XLN.getEnv();

    console.log('📊 Before prepopulate:');
    console.log(`  • Height: ${env.height}`);
    console.log(`  • Snapshots: ${env.history.length}`);
    console.log(`  • Replicas: ${env.replicas.size}`);

    // Run prepopulate
    await prepopulateModule.prepopulate(env, serverModule.processUntilEmpty);

    console.log('\n📊 After prepopulate:');
    console.log(`  • Height: ${env.height}`);
    console.log(`  • Snapshots: ${env.history.length}`);
    console.log(`  • Replicas: ${env.replicas.size}`);

    // Count entities
    const entities = new Set();
    for (const key of env.replicas.keys()) {
      const [entityId] = key.split(':');
      entities.add(entityId);
    }
    console.log(`  • Unique entities: ${entities.size}`);

    console.log('\n✅ Prepopulate completed successfully!');
    console.log('Check the UI - you should see:');
    console.log('  1. Height should equal snapshot count');
    console.log('  2. Multiple entities (3 hubs + 7 users)');
    console.log('  3. Routing should show multi-hop paths through hubs');

  } catch (error) {
    console.error('❌ Prepopulate failed:', error);
  }
})();