// Drives the HOST's real compatibility gate (evaluatePluginCompatibility from
// @deepseek-ai/dsh-app-boot, the exact function the Loader runs at boot) against
// this plugin's package.json. We declare a floor — ">=0.2.1-rc.2" — and never
// hard-code an upper bound, so future DSH releases keep loading the plugin.
//
// This is NOT a reimplementation: it imports the host code that actually decides
// admission, so a change in host semantics would surface here too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot';

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
);

// undefined return ⇒ every requirement is met ⇒ the plugin is admissible.
function isCompatible(runtimeVersion) {
  return evaluatePluginCompatibility(manifest, {}, runtimeVersion) === undefined;
}

// The declared floor. If the manifest's engines.dsh floor is bumped, this test's
// expectation should be updated in lockstep — it is the single source of truth.
const FLOOR = '0.2.1-rc.2';

test('engines.dsh declares a lower bound, not an exact pin', () => {
  const range = manifest.engines?.dsh;
  assert.ok(typeof range === 'string' && range.startsWith('>='), `engines.dsh must be a ">=…" range, got ${JSON.stringify(range)}`);
  // No dead "dsh.compatibility.dshReleases" hard-list remains.
  assert.equal(manifest.dsh?.compatibility, undefined, 'dsh.compatibility.dshReleases must be removed');
});

test('floor version is compatible', () => {
  assert.equal(isCompatible(FLOOR), true, `${FLOOR} must be compatible`);
});

test('versions below the floor are rejected', () => {
  for (const v of ['0.1.0', '0.2.0', '0.2.1-rc.0', '0.2.1-rc.1']) {
    assert.equal(isCompatible(v), false, `${v} should be rejected (below floor ${FLOOR})`);
  }
});

test('future versions above the floor are compatible (no hard upper bound)', () => {
  for (const v of ['0.2.1-rc.3', '0.2.1-rc.4', '0.2.1', '0.2.2', '0.3.0', '1.0.0']) {
    assert.equal(isCompatible(v), true, `${v} must remain compatible (forward-open)`);
  }
});

test('current host runtime resolves this plugin', () => {
  // The runtime that ships the engine under test must itself be admissible.
  assert.equal(isCompatible(getDshRuntimeVersion()), true);
});
