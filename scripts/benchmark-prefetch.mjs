// Repeat the same fake-clock workload against the original source, current
// source, and an extension-disabled baseline. No GPU/FPS claims are made.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const revision = process.argv[2] ?? '4755bc2';
const before = execFileSync('git', ['show', `${revision}:src/tts/prefetch.ts`], { encoding: 'utf8' })
  .replaceAll("from './", "from '../../src/tts/")
  .replaceAll("from '../ui/", "from '../../src/ui/")
  .replaceAll("from '../diagnostics'", "from '../../src/diagnostics'");
mkdirSync('.output/research', { recursive: true });
writeFileSync('.output/research/prefetch-before.ts', before);
const results = [];
for (const variant of ['disabled', 'before', 'after']) {
  const output = execFileSync(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'run', 'tests/prefetch.test.ts',
    '--testNamePattern=reports a repeatable', '--reporter=dot',
  ], {
    encoding: 'utf8',
    env: { ...process.env, TTSX_PREFETCH_BASELINE: variant === 'before' ? '1' : '', TTSX_PREFETCH_DISABLED: variant === 'disabled' ? '1' : '' },
  });
  const line = output.split('\n').find(line => line.startsWith('{"workload"'));
  if (!line) throw new Error(`Missing benchmark output: ${variant}\n${output}`);
  const result = JSON.parse(line);
  results.push(result);
  console.log(JSON.stringify(result));
}
const destination = resolve('.output/research/prefetch-benchmark.json');
writeFileSync(destination, JSON.stringify({ baselineRevision: revision, results }, null, 2) + '\n');
console.log(`Saved ${destination}`);
