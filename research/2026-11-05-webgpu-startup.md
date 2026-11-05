# WebGPU availability and automatic startup

Date: 2026-11-05. Baseline: `117d0cc`.

## Scope and evidence

The user's screenshot shows Chromium's native `No available adapters.` warning
in `offscreen.html`. The user subsequently reported wider Helium problems and
asked to focus on the extension error. No browser settings were changed, and
no scrolling-performance changes are included.

Chromium emits this warning when its WebGPU adapter request cannot return a
usable adapter. This is a browser/GPU availability failure, not evidence that
the extension caused the reported lag. Primary references:

- [Chromium adapter request implementation](https://chromium.googlesource.com/chromium/src/+/61fbaea613796a2f780434bf97f1712df289fdd9/gpu/command_buffer/service/webgpu_decoder_impl.cc),
  `WebGPUDecoderImpl::RequestAdapterImpl`.
- [Chrome WebGPU troubleshooting](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips).

The previous turn's native browser inspection stopped because the computer-use
tool could not confidently determine the browser URL. This change was verified
locally without further UI automation. Actual adapter availability and speech
playback in the user's Helium session remain unverified.

## Confirmed extension behavior before the change

1. The background entrypoint created an offscreen document on module startup,
   install, and browser startup. The offscreen entrypoint immediately preloaded
   the model worker. Firefox also preloaded as soon as its host was created.
   These paths could request a GPU without a user speech request.
2. Each X tab armed prefetch after 2.5 seconds. Prefetch did not require a
   resident model, so a quiet feed could initiate the first GPU request.
3. A failed background synthesis returned `retry`, scheduling another attempt
   after 30 seconds. Viewport activity could keep work wanted. A failed worker
   load was discarded, allowing the next attempt to request another adapter.
4. The content engine retained its old `modelReady` flag on unscoped worker
   load errors.
5. Read-aloud failures reset the speaker to its ordinary idle appearance and
   exposed their reason only through development diagnostics.

These are code and deterministic-test findings. They do not establish why
Helium lacked a GPU adapter at the time of the screenshot.

## Changes

- Create the offscreen/background host only when the content engine requests
  it. Host construction and offscreen readiness no longer preload the worker.
  A disconnected backend is recovered by the next explicit request rather
  than unsolicited background startup.
- Arm a tab's prefetch only after successful foreground playback. Require
  `engine.isModelReady()` before any candidate geometry or synthesis work.
  Opening an X tab therefore cannot cold-start the speech engine.
- Suspend prefetch after any non-cancellation synthesis failure. Scroll,
  viewport, settings, and idle callbacks cannot restart it. A later successful
  foreground play re-arms it; ordinary input cancellation retains its cooldown.
- Clear model readiness on unscoped load failures. A generation request in a
  later tab receives a session-scoped ready message when the shared host is
  already loaded, so that tab can still warm after its own successful speech.
- Handle both null and rejected adapter requests before model downloads.
  Preserve a rejected request's cause and return actionable restart/settings
  guidance. No automatic adapter retry or CPU fallback was added.
- Put playback failure guidance in the speaker's hover title and accessible
  label. Keep the button enabled for another click. Loading restores its
  regular label and title.

The first speech request now bears cold model loading/compilation costs. Model
cache behavior is unchanged, and the resident worker remains shared across
tabs. Warm-up after successful use keeps the existing interaction gate,
quality settings, and one-chunk budget.

This prevents unsolicited startup probes and repeated failed background probes;
it cannot manufacture a hardware adapter when Helium has disabled or lost GPU
access. Chromium may still record its native warning on an explicit speech
attempt while no adapter is available. It is not intercepted or hidden.

## Regression evidence

Before editing production source, ran:

```text
npm test -- tests/prefetch.test.ts tests/engineCancellation.test.ts tests/backgroundDisconnect.test.ts tests/offscreenStartup.test.ts
Test Files  4 failed (4)
Tests       6 failed | 13 passed (19)
```

The six failures demonstrated:

| Regression | Original observation | Corrected observation |
| --- | --- | --- |
| Browser/extension startup | Offscreen creation called once | Zero calls until a content request; explicit request still creates it |
| Offscreen module startup | `host.preload()` called once | No preload; generate messages still reach the host |
| Armed cold-tab warm-up | Synthesis called once despite `modelReady = false` | No synthesis, preload, or geometry reads during 60 seconds |
| Successful speech arms a tab | Warm-up did not start without the old automatic arm timer | Successful playback followed by idle warms one post |
| Failure followed by feed activity | Synthesis called twice after one injected GPU failure | One failed attempt across three simulated minutes; successful foreground speech permits warming again |
| Failed model readiness | Old ready flag remained true | Flag clears on failure; manual request and ready event restore it |

The same targeted command passed all 19 tests after the correction.

Additional checks cover unsupported WebGPU, a null adapter, a rejected adapter
request, manual adapter recovery, worker replacement after load failure,
resident-worker reuse in a later tab, and the retryable speaker error message.
The later-tab test initially failed because no ready event reached that tab;
the session-scoped ready notification fixes it.

Final local checks:

```text
npm test
Test Files  10 passed (10)
Tests       98 passed (98)

npm run typecheck
Exit code 0

npm run build
Verified chrome production build: CSP, WebGPU-only provider, and runtime assets are valid.

npm run build:firefox
Verified firefox production build: CSP, WebGPU-only provider, and runtime assets are valid.
```

The existing simulated scroll workload still reports zero synthesis starts,
geometry reads, preloads, or cancellations during sustained input. That
fixture assumes an already-ready engine; it is not a live FPS measurement.

## Applying the local build

The Chromium output is `.output/chrome-mv3`. Reload the installed unpacked
TTSForX extension, then refresh X tabs so they use the new content script.
Old entries in Chromium's Errors page are historical and are not removed by
rebuilding the extension. If an explicit read attempt still lacks GPU access,
the speaker now carries the recovery guidance and background retries stay
suspended.
