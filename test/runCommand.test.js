import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runCommand } = require('../main/runCommand.js');

// Uses the running node binary as a portable, always-present child. These are
// real spawns (thin I/O wrapper), kept fast and deterministic.
const node = process.execPath;

describe('runCommand', () => {
  it('resolves ok:true with stdout for a successful command', async () => {
    const res = await runCommand(node, ['-e', 'process.stdout.write("hi")']);
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('hi');
  });

  it('resolves ok:false (never throws) for a missing binary', async () => {
    const res = await runCommand('w17-definitely-not-a-real-binary', []);
    expect(res.ok).toBe(false);
    expect(res.stderr.length).toBeGreaterThan(0);
  });

  it('resolves ok:false with a timeout reason when a command overruns (audit N4 path)', async () => {
    const res = await runCommand(node, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 });
    expect(res.ok).toBe(false);
    expect(res.code).toBeNull();
    expect(res.stderr).toContain('timeout');
  });

  it('merges env additively without dropping process.env', async () => {
    const res = await runCommand(
      node,
      ['-e', 'process.stdout.write(process.env.W17_TEST_MARKER || "none")'],
      { env: { W17_TEST_MARKER: 'yes' } },
    );
    expect(res.stdout).toContain('yes');
  });
});
