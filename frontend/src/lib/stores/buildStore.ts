import { writable } from 'svelte/store';

interface BuildStatus {
  buildNumber: number;
  lastBuildTime: number;
  status: 'building' | 'ready' | 'error';
  isWatching: boolean;
}

// Build status store
export const buildStatus = writable<BuildStatus>({
  buildNumber: 0,
  lastBuildTime: Date.now(),
  status: 'ready',
  isWatching: false
});

let checkInterval: number | undefined;

// Check for server.js changes by monitoring its modification time
export function startBuildWatcher() {
  let lastModTime = 0;

  buildStatus.update(status => ({ ...status, isWatching: true }));

  checkInterval = setInterval(async () => {
    try {
      // Fetch server.js head to get last-modified header
      const response = await fetch('/server.js', { method: 'HEAD' });
      const lastModified = response.headers.get('last-modified');

      if (lastModified) {
        const modTime = new Date(lastModified).getTime();

        if (lastModTime === 0) {
          // Initial load
          lastModTime = modTime;
        } else if (modTime > lastModTime) {
          // File was updated!
          lastModTime = modTime;
          buildStatus.update(status => ({
            ...status,
            buildNumber: status.buildNumber + 1,
            lastBuildTime: modTime,
            status: 'ready'
          }));

          console.log('🔄 Build updated! New server.js detected');
        }
      }
    } catch (error) {
      console.warn('Build watcher error:', error);
    }
  }, 1000); // Check every second
}

export function stopBuildWatcher() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = undefined;
  }

  buildStatus.update(status => ({ ...status, isWatching: false }));
}

// Auto-start watcher when store is imported
if (typeof window !== 'undefined') {
  startBuildWatcher();
}