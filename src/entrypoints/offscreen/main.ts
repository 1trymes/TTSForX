/** Chromium offscreen document — persistent extension-origin WebGPU host. */
import { TtsWorkerHost } from '../../tts/workerHost';
import { acknowledgeDisconnectError } from '../../runtime/disconnect';

const port = browser.runtime.connect({ name: 'ttsx-offscreen' });

const host = new TtsWorkerHost((message) => port.postMessage(message));
port.onMessage.addListener((message) => host.handleMessage(message));
port.onDisconnect.addListener(() => {
  acknowledgeDisconnectError();
  host.dispose();
});
// A live port means the document is ready to receive requests. The worker
// starts on load/generate, not merely because this document was created.
port.postMessage({ type: 'offscreen-ready' });
