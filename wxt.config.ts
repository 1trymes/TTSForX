import { defineConfig } from 'wxt';

const TRANSFORMERS_POWER_PREFERENCE =
  "ONNX_ENV.webgpu.powerPreference = 'high-performance';";
const COMPILED_TRANSFORMERS_POWER_PREFERENCE =
  /\b[$\w]+\.webgpu\.powerPreference\s*=\s*[`'"]high-performance[`'"]/u;
const COMPILED_ORT_ADAPTER_REQUEST =
  /navigator\.gpu\.requestAdapter\(\{powerPreference:([$\w]+),forceFallbackAdapter:([$\w]+)\}\)/u;
const COMPILED_EMSCRIPTEN_ADAPTER_REQUEST =
  /navigator\.gpu\.requestAdapter\(([$\w]+)\)/u;

function omitDeprecatedAdapterPreference(code: string): string {
  let output = code.replace(
    COMPILED_ORT_ADAPTER_REQUEST,
    (_match, _powerPreference: string, forceFallbackAdapter: string) =>
      `navigator.gpu.requestAdapter(${forceFallbackAdapter}===void 0?void 0:{forceFallbackAdapter:${forceFallbackAdapter}})`,
  );
  output = output.replace(
    COMPILED_EMSCRIPTEN_ADAPTER_REQUEST,
    (_match, options: string) =>
      `navigator.gpu.requestAdapter((delete ${options}.powerPreference,${options}))`,
  );
  return output;
}

function webGpuAdapterPolicy() {
  return {
    name: 'ttsx-transformers-webgpu-adapter-policy',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const moduleId = id.replaceAll('\\', '/').split('?')[0];
      if (moduleId.includes('/onnxruntime-web/dist/ort.webgpu')) {
        const output = omitDeprecatedAdapterPreference(code);
        if (output === code) {
          throw new Error(
            'Pinned ONNX Runtime WebGPU adapter initialization changed; review its request options before building.',
          );
        }
        return output;
      }
      if (
        moduleId.includes(
          '/onnxruntime-web/dist/ort-wasm-simd-threaded.',
        ) &&
        moduleId.endsWith('.mjs')
      ) {
        const output = omitDeprecatedAdapterPreference(code);
        if (output === code) {
          throw new Error(
            'Pinned ONNX WebGPU glue changed; review its adapter options before building.',
          );
        }
        return output;
      }
      if (
        !moduleId.endsWith(
          '/@huggingface/transformers/dist/transformers.web.js',
        )
      ) {
        return null;
      }
      if (!code.includes(TRANSFORMERS_POWER_PREFERENCE)) {
        throw new Error(
          'Pinned Transformers.js WebGPU initialization changed; review its adapter policy before building.',
        );
      }
      return code.replace(TRANSFORMERS_POWER_PREFERENCE, '');
    },
    renderChunk(code: string) {
      let output = code.replace(
        COMPILED_TRANSFORMERS_POWER_PREFERENCE,
        'void 0',
      );
      output = omitDeprecatedAdapterPreference(output);
      if (output === code) return null;
      return {
        code: output,
        map: null,
      };
    },
  };
}

export default defineConfig({
  srcDir: 'src',
  vite: () => ({
    // The extension acquires and supplies one adapter explicitly.
    // Transformers.js 3.8.1 otherwise overwrites the shared ONNX environment
    // with an ignored Windows-only adapter preference.
    plugins: [webGpuAdapterPolicy()],
    optimizeDeps: {
      exclude: ['onnxruntime-web'],
    },
    resolve: {
      // The aligner and TTS runtime share one ORT/WebGPU device.
      dedupe: ['onnxruntime-web', 'onnxruntime-common'],
      alias: [
        {
          find: /^onnxruntime-web$/,
          replacement: 'onnxruntime-web/webgpu',
        },
      ],
    },
    worker: {
      format: 'es',
      plugins: () => [webGpuAdapterPolicy()],
    },
  }),
  manifest: ({ browser }) => ({
    name: 'TTSForX',
    description: 'Read posts on X aloud with local speech and synchronized captions.',
    version: '0.2.0',
    minimum_chrome_version: browser === 'firefox' ? undefined : '113',
    icons: {
      16: 'icons/ttsforx-16.png',
      32: 'icons/ttsforx-32.png',
      48: 'icons/ttsforx-48.png',
      128: 'icons/ttsforx-128.png',
    },
    content_security_policy: {
      // ONNX Runtime's WebGPU execution provider uses its packaged JSEP
      // WebAssembly core for graph orchestration. This permission enables
      // WebAssembly compilation only; inference sessions still require WebGPU.
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    permissions:
      browser === 'firefox'
        ? ['storage', 'unlimitedStorage']
        : ['storage', 'unlimitedStorage', 'offscreen'],
    host_permissions: [
      'https://x.com/*',
      'https://twitter.com/*',
      'https://huggingface.co/*',
      'https://*.huggingface.co/*',
      // Hugging Face redirects Xet-backed model files to regional CDN hosts.
      'https://*.hf.co/*',
    ],
    action: {
      default_title: 'TTSForX settings',
      default_icon: {
        16: 'icons/ttsforx-16.png',
        32: 'icons/ttsforx-32.png',
      },
    },
    // Worker bundle is XHR'd by the content script (page CSP blocks fetch).
    web_accessible_resources: [
      {
        resources: ['assets/*'],
        matches: ['https://x.com/*', 'https://twitter.com/*'],
      },
    ],
    browser_specific_settings: {
      gecko: {
        id: 'ttsforx@local',
        strict_min_version: '115.0',
        data_collection_permissions: {
          required: ['none'],
        },
      },
    },
  }),
});
