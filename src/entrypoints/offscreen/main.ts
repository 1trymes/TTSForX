/** Chromium offscreen document — persistent extension-origin WebGPU host. */
import { TtsWorkerHost } from '../../tts/workerHost';

const port = browser.runtime.connect({ name: 'ttsx-offscreen' });

const host = new TtsWorkerHost((message) => port.postMessage(message));
port.onMessage.addListener((message) => host.handleMessage(message));
host.preload();

port.postMessage({ type: 'offscreen-ready' });
