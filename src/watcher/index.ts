import chokidar from 'chokidar';
import { resolve } from 'path';
import { loadProject } from '../engine/project.js';

type Listener = (project: ReturnType<typeof loadProject>) => void;

let watcher: chokidar.FSWatcher | null = null;

export function startWatcher(root: string, onChange: Listener): chokidar.FSWatcher {
  const projectPath = resolve(root, 'project.json');

  watcher = chokidar.watch(projectPath, {
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on('change', () => {
    try {
      const project = loadProject(root);
      onChange(project);
    } catch (err) {
      console.error('[watcher] Failed to reload project.json:', (err as Error).message);
    }
  });

  console.log(`[watcher] Watching ${projectPath}`);
  return watcher;
}

export function stopWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
    console.log('[watcher] Stopped');
  }
}
