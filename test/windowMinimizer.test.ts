import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { minimizeSpotifyWindow } from '../src/device/windowMinimizer.ts';

const SCRIPT_PATH = join(import.meta.dirname, '..', 'scripts', 'minimize_spotify_window.py');

function fakeScript(exitCode: number): string {
  const directory = mkdtempSync(join(tmpdir(), 'minimizer-test-'));
  const path = join(directory, 'fake.py');
  writeFileSync(path, `import sys\nprint("fake output")\nsys.exit(${exitCode})\n`);
  return path;
}

describe('minimizeSpotifyWindow', () => {
  it('maps exit codes to outcomes', async () => {
    assert.equal((await minimizeSpotifyWindow(fakeScript(0))).outcome, 'minimized');
    assert.equal((await minimizeSpotifyWindow(fakeScript(2))).outcome, 'notFound');
    assert.equal((await minimizeSpotifyWindow(fakeScript(3))).outcome, 'noDisplay');
    assert.equal((await minimizeSpotifyWindow(fakeScript(7))).outcome, 'unavailable');
  });

  it('reports a missing interpreter instead of throwing', async () => {
    const result = await minimizeSpotifyWindow(SCRIPT_PATH, '/nonexistent/python3');
    assert.equal(result.outcome, 'unavailable');
    assert.match(result.detail, /ENOENT/);
  });
});

describe('minimize_spotify_window.py', () => {
  it('exits with 3 when there is no X display', () => {
    const result = spawnSync('python3', ['-I', SCRIPT_PATH], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /No X display/);
  });
});
