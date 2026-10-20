import { afterAll, beforeAll, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { serverInstructions } from '../src/main/mcp/instructions.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
beforeAll(async () => { dir = await makeTempDir('clf-worker-roles-'); initConfigPath(dir); });
afterAll(async () => { await removeTempDir(dir); });

// The agents schema carries no role names (ChatGPT may cache it), so the Core instructions say
// which ones are saved; with none saved they add nothing.
it('names the saved sub-agent roles in the Core instructions only when there are some', async () => {
  const ctx = { caps: { ...DEFAULT_CAPABILITIES }, readOnly: false, sessionTools: false, agentTools: true, roots: [] } as any;
  const config = defaultConfig();
  await saveConfig(config);
  const without = serverInstructions(ctx, 'core', 'linux');
  expect(without).not.toMatch(/worker roles/i);
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent,
    roles: [{ name: 'Reviewer', model: 'placeholder-model', reasoning: 'high' }, { name: 'Scout', model: '', reasoning: '' }] } });
  const workers = serverInstructions(ctx, 'core', 'linux').split('# Workers')[1]!;
  expect(workers).toContain("Saved worker roles: Reviewer, Scout. A role sets a worker's model and reasoning the same way, when the user names it.");
  expect(workers).not.toContain('placeholder-model');
});
