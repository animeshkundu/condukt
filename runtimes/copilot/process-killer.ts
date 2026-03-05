import * as cp from 'child_process';

/**
 * Check if a process with the given PID is alive.
 * Uses `process.kill(pid, 0)` which sends signal 0 (no-op) to probe existence.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process and its entire tree.
 * On Windows, uses `taskkill /T /F /PID <pid>`.
 * On other platforms, uses `kill -9 <pid>`.
 * Does not throw if the process does not exist.
 */
export async function killProcessTree(pid: number): Promise<void> {
  try {
    if (process.platform === 'win32') {
      cp.spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        stdio: 'ignore',
        timeout: 10_000,
      });
    } else {
      cp.spawnSync('kill', ['-9', String(pid)], {
        stdio: 'ignore',
        timeout: 10_000,
      });
    }
  } catch {
    // Process may already be dead -- silently ignore
  }
}
