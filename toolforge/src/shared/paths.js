import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where ToolForge keeps hub state, agent config and CLI credentials.
 * Override with TOOLFORGE_HOME.
 * @returns {string}
 */
export function defaultDataDir() {
  return process.env.TOOLFORGE_HOME ?? join(homedir(), '.toolforge');
}
