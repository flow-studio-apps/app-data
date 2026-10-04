#!/usr/bin/env node
// Validate every JSON file, re-hash packs, bump changed pack versions and
// rewrite manifests. Writes nothing if anything is invalid.
//   node tools/build.mjs          validate + write
//   node tools/build.mjs --check  validate only; exit 1 if a manifest is stale
import { build, repoRoot } from './lib.mjs';

const check = process.argv.includes('--check');
const { errors, changed } = build(repoRoot(), { check });

if (errors.length > 0) {
  console.error(`✗ ${errors.length} problem(s), nothing written:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
if (changed.length === 0) console.log('✓ All files valid; manifests up to date.');
else if (check) {
  console.error('✗ Valid, but these manifests are out of date (run without --check):');
  for (const f of changed) console.error(`  - ${f}`);
  process.exit(1);
} else {
  console.log('✓ All files valid. Updated:');
  for (const f of changed) console.log(`  - ${f}`);
}
