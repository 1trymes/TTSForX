import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const target = process.argv[2] ?? 'chrome';
const outputDirectory =
  target === 'firefox'
    ? path.resolve('.output/firefox-mv2')
    : path.resolve('.output/chrome-mv3');

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesBelow(absolutePath)));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

function invariant(condition, message) {
  if (!condition) {
    throw new Error(`Production build verification failed: ${message}`);
  }
}

const [manifestText, packageText, outputFiles] = await Promise.all([
  readFile(path.join(outputDirectory, 'manifest.json'), 'utf8'),
  readFile(path.resolve('package.json'), 'utf8'),
  filesBelow(outputDirectory),
]);
const firstPartySourceFiles = (await filesBelow(path.resolve('src'))).filter(
  (file) => /\.(?:ts|tsx|js|mjs)$/u.test(file),
);
const firstPartySources = await Promise.all(
  firstPartySourceFiles.map(async (file) => ({
    file,
    source: await readFile(file, 'utf8'),
  })),
);

const manifest = JSON.parse(manifestText);
const packageJson = JSON.parse(packageText);
const extensionCsp =
  typeof manifest.content_security_policy === 'string'
    ? manifest.content_security_policy
    : manifest.content_security_policy?.extension_pages;

invariant(
  manifest.version === packageJson.version,
  `manifest version ${manifest.version} does not match package ${packageJson.version}`,
);
invariant(
  typeof extensionCsp === 'string',
  'extension Content Security Policy is missing',
);
invariant(
  /(?:^|;)\s*script-src\s+[^;]*'self'[^;]*'wasm-unsafe-eval'(?:\s|;|$)/.test(
    extensionCsp,
  ),
  "script-src must include both 'self' and 'wasm-unsafe-eval'",
);
invariant(
  !/(?:^|\s)'unsafe-eval'(?:\s|;|$)/.test(extensionCsp),
  "general 'unsafe-eval' must never be enabled",
);
const warningSources = firstPartySources
  .filter(({ source }) => /\bconsole\.warn\s*\(/u.test(source))
  .map(({ file }) => path.relative(path.resolve('.'), file));
invariant(
  warningSources.length === 0,
  `handled failures must not pollute Chromium's extension-error database (${warningSources.join(', ')})`,
);

const lifecycleSourcePaths = [
  path.resolve('src/entrypoints/content.ts'),
  path.resolve('src/tts/prefetch.ts'),
  path.resolve('src/x/observer.ts'),
];
const lifecycleSources = firstPartySources.filter(({ file }) =>
  lifecycleSourcePaths.includes(file),
);
const unmanagedAsyncSources = lifecycleSources
  .filter(({ source }) =>
    /(?<![\w.])(?:setTimeout|setInterval|requestIdleCallback)\s*\(/u.test(
      source,
    ),
  )
  .map(({ file }) => path.relative(path.resolve('.'), file));
invariant(
  unmanagedAsyncSources.length === 0,
  `content lifecycle work must use WXT context helpers (${unmanagedAsyncSources.join(', ')})`,
);
const contentEntrypointSource = lifecycleSources.find(
  ({ file }) => file === path.resolve('src/entrypoints/content.ts'),
)?.source;
invariant(
  contentEntrypointSource?.includes('async main(ctx)') &&
    contentEntrypointSource.includes('ctx.onInvalidated(') &&
    contentEntrypointSource.includes('engine.dispose()') &&
    contentEntrypointSource.includes('disposeSettings()') &&
    contentEntrypointSource.includes('closePopover()'),
  'the content script must dispose engine, storage, and UI resources through WXT context invalidation',
);

const workerFiles = outputFiles.filter((file) =>
  /^worker-.*\.js$/u.test(path.basename(file)),
);
invariant(workerFiles.length === 1, 'exactly one packaged TTS worker is required');

const workerSource = await readFile(workerFiles[0], 'utf8');
const providerMatches = [
  ...workerSource.matchAll(
    /executionProviders\s*:\s*\[\s*([`'"])webgpu\1\s*\]/gu,
  ),
];
invariant(
  providerMatches.length === 1,
  'the packaged worker must configure exactly one WebGPU-only session factory',
);
invariant(
  !/requestAdapter\(\{powerPreference:/u.test(workerSource),
  'ONNX Runtime must omit undefined requestAdapter option keys',
);
invariant(
  !/navigator\.gpu\.requestAdapter\([$\w]+\)/u.test(workerSource),
  'ONNX WebGPU glue must sanitize its adapter options before requesting',
);
const transformersFiles = outputFiles.filter((file) =>
  /^transformers\.web-.*\.js$/u.test(path.basename(file)),
);
invariant(
  transformersFiles.length === 1,
  'exactly one packaged Transformers.js browser runtime is required',
);
const transformersSource = await readFile(transformersFiles[0], 'utf8');
invariant(
  !/webgpu\.powerPreference\s*=\s*[`'"]high-performance[`'"]/u.test(
    transformersSource,
  ),
  'Transformers.js must not request the ignored Windows power preference',
);

if (target === 'chrome') {
  invariant(manifest.manifest_version === 3, 'Chrome output must use Manifest V3');
  invariant(
    manifest.permissions?.includes('offscreen'),
    'Chrome output must include the offscreen permission',
  );
  for (const size of [16, 32, 48, 128]) {
    const relativeIcon = `icons/ttsforx-${size}.png`;
    invariant(
      manifest.icons?.[size] === relativeIcon,
      `manifest icon ${size}px must use ${relativeIcon}`,
    );
    invariant(
      outputFiles.includes(path.join(outputDirectory, relativeIcon)),
      `packaged icon ${relativeIcon} is missing`,
    );
  }
  invariant(
    manifest.action?.default_icon?.[16] === 'icons/ttsforx-16.png' &&
      manifest.action?.default_icon?.[32] === 'icons/ttsforx-32.png',
    'the toolbar action must use the branded 16px and 32px icons',
  );

  const wasmFiles = outputFiles.filter((file) => file.endsWith('.wasm'));
  invariant(
    wasmFiles.length === 1,
    'Chrome output must contain exactly one ONNX Runtime WebGPU core',
  );
  invariant(
    /^ort-wasm-simd-threaded.*\.wasm$/u.test(path.basename(wasmFiles[0])),
    'the packaged WebAssembly file is not the expected ONNX Runtime core',
  );
  invariant(
    (await stat(wasmFiles[0])).size > 20_000_000,
    'the packaged ONNX Runtime WebGPU core is unexpectedly small',
  );
}

console.log(
  `Verified ${target} production build: CSP, WebGPU-only provider, and runtime assets are valid.`,
);
