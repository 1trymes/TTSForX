# Scroll-aware TTS background work

## Conclusion

The extension had measurable scheduling and cancellation defects. The new
scheduler eliminates speculative synthesis starts during sustained interaction
in both the deterministic test and the observed live test. It also fixes a
same-post playback race with cancelled prefetch.

**This does not establish TTSForX as the cause of the user's intermittent
Helium scrolling problem.** Foreground X frame-time distributions were similar
before and after. No live extension-disabled A/B comparison was performed.

## Environment and evidence scope

The preceding investigation identified Helium 0.18.3.1 / Chromium
154.0.8037.97, an RTX 5090, and a primary 3840x2160 240 Hz display, with
144 Hz and 60 Hz secondary displays. Its simple animation fixture sustained
240 FPS. Those observations establish rendering capability, not X scrolling
performance or causality. No browser, driver, or system settings were changed
in this work.

The unpacked extension is `kphgbkmdnkehialmjfkfnnpeokcnmgjb`, loaded from
`.output/chrome-mv3`. Baseline source revision: `4755bc2`.

## Verified code findings

- `armPrefetch()` unconditionally started model loading, including while
  scrolling or hidden. Intersection callbacks scheduled a fixed 400 ms timer;
  ongoing input did not reset it.
- Visibility and playback checks prevented some new jobs but did not cancel
  an already-running warm request. A candidate list could outlive its viewport.
- Each pump could warm two posts consecutively. Geometry was read during
  mounting, repeatedly inside sorting comparisons, and again in follow-up
  scans. These reads were removed from the interaction path.
- The shared offscreen host allowed equal-priority speculative requests from
  different tabs to evict each other. Foreground generation already had higher
  priority; that existing guarantee is retained.
- Clicking the same post as an active warm request could join its cancelled
  promise before rejection cleanup completed. A new regression exposed this
  after request cancellation was extended.
- The current hardware budget already returns `fullPosts: 0` at every tier.
  The initial suspicion of powerful GPUs enabling whole-feed synthesis was
  not supported by the current implementation.
- The DOM observer already coalesces updates and scans incrementally. It was
  reviewed but not broadly rewritten without evidence of a separate defect.

## Changes

1. Wait at least 1,500 ms after scroll, wheel, touch, key, or pointer activity.
   Run only in a visible, focused, playback-idle tab. Use a cancellable idle
   callback without a forcing timeout when the browser supports it.
2. Warm one chunk per scheduler turn, with 5 seconds between completed or
   interrupted work units. Back off 30 seconds after a failure or another
   session's priority rejection. Preserve the existing nearest-post budget.
3. Start model loading only as part of eligible work. Cancel the current warm
   request when interaction resumes, the tab hides or loses focus, playback
   takes priority, the candidate leaves the viewport, or the context expires.
4. Carry an AbortSignal through settings loading, queueing, backend startup,
   and active synthesis. Scope host cancellation by session **and request ID**
   so a late abort cannot cancel a newer foreground request.
5. Reject competing background requests instead of repeatedly cancelling the
   current warm chunk. User playback still supersedes speculative generation.
6. Yield for cancellation between alignment stages; dispose an already-running
   GPU result instead of doing further timestamp extraction after cancellation.
7. Clear cancelled inflight entries synchronously and guard promise cleanup
   by identity, preventing same-post clicks from joining cancelled work.

Voice, quality iterations, generated chunk boundaries, PCM cache isolation,
acoustic word alignment, and the earlier Unicode karaoke fix are preserved.

## Deterministic comparison

Run `node scripts/benchmark-prefetch.mjs` from the repository root. The runner
materializes the original prefetch module from Git into ignored `.output`
storage and runs the same Vitest workload against old, new, and disabled
variants. It does not edit the working source or operate the installed extension.

Workload: 30 seconds of scroll events every 100 ms; five new nearby posts each
second; 8 seconds of rest. Synthesis is mocked at 250 ms. The real prefetch
module, scheduler, candidate selection, and cache checks execute under a fake
clock. This measures scheduling behavior, **not GPU load or FPS**.

| Metric | Disabled fixture | Before | After |
| --- | ---: | ---: | ---: |
| Synthesis starts during scroll | 0 | 60 | 0 |
| Prefetch geometry reads during scroll | 0 | 1,110 | 0 |
| Unconditional preload calls | 0 | 1 | 0 |
| Total synthesis starts including rest | 0 | 60 | 2 |
| First synthesis start, ms from workload start | none | 400 | 31,400 |
| New warm jobs after scroll, ms | none | none | 31,400; 36,650 |

The last input is at 29,900 ms. The new first warm job starts exactly 1,500 ms
later. Its mocked completion is at 31,650 ms; the second starts 5 seconds later.
The old module had already cached its last viewport before the rest period.
The disabled fixture is a control for extension-origin work, not a live browser
baseline.

## Live browser observations

Used the supported connected browser and page-scoped CDP on the existing
`https://x.com/home` tab. A temporary requestAnimationFrame sampler scrolled
between y=960 and y=3960 and back, twice over 8 seconds. It recorded frame
intervals and Long Tasks and restored the original scroll position. No
accessibility snapshot was collected during each timed run. All temporary
listeners and the synthesis-count wrapper were removed after measurement.

The user manually reloaded the extension and refreshed X. Reading the loaded
content-script source confirmed the new `quietUntil` scheduler was running.

| Foreground sample | Before | After |
| --- | ---: | ---: |
| Frame intervals | 1,879 | 1,847 |
| Mean interval | 4.258 ms | 4.332 ms |
| Approximate average FPS | 234.9 | 230.8 |
| Median interval | 4.2 ms | 4.2 ms |
| p95 interval | 4.3 ms | 4.3 ms |
| Intervals >10 ms | 10 | 12 |
| Intervals >25 ms | 0 | 1 |
| Long Tasks observed | 0 | 0 |
| Background synthesis starts | not instrumented | 0 |

These single runs are not evidence of an FPS improvement or regression:
X's feed/media and caches changed on refresh, and no disabled baseline or
controlled GPU-duration trace was captured. They confirm high-refresh
foreground scrolling and the new interaction gate for this workload.

An initial post-reload sample measured a 41.7 ms median, and a stationary sample
then measured roughly 1,004 ms between callbacks, despite the page reporting
visible/focused. Bringing Helium to the front restored 4.2 ms immediately
(961 intervals in 4 seconds, 4.3 ms p95). Those samples are excluded from the
comparison because foreground/window visibility affected the measurement.
This observation is consistent with background/occlusion throttling, but does
not establish the cause of the user's original foreground scrolling complaint.

A real click on the first post reached `loading` in 5.2 ms and `playing` in
30.6 ms, then returned to idle normally after about 3.52 seconds. Two cached
posts were present before the click, so this is a **cached playback** latency,
not cold model startup or uncached synthesis latency.

Raw numeric results are in `2026-10-06-scroll-measurements.json`.

## Tradeoffs and remaining limits

- A post passed while scrolling may no longer be cached when clicked. The
  explicit click bypasses the background quiet period and cooldown, but must
  synthesize normally when there is no cache hit. Cold startup latency was not
  measured live in this session.
- Deferred first model loading may expose download/compilation latency on an
  early first click. Existing shared compiled models remain resident on abort.
- Already-submitted GPU graphs, synchronous resampling, and shared cold-model
  download/compilation are not forcibly terminated. Cancellation prevents later
  stages and chunks at cooperative boundaries. It is not instantaneous GPU
  preemption. Alignment checkpoints add five event-loop yields per chunk.
- Actual wheel/touch input, multiple monitors, hidden-tab resource usage, and
  concurrent X tabs were not exhaustively profiled live. Automated tests cover
  the scheduler events, visibility/focus changes, shared-host arbitration, and
  playback priority separately.

## Validation

- 77 tests passed, including sustained input, rapid viewport turnover, hidden
  and unfocused tabs, active/queued/startup cancellation, multi-session priority,
  same-post playback, cache reuse, retry backoff, and alignment tensor cleanup.
- `npm run typecheck`: passed.
- `npm run build`: passed with the production CSP/provider/assets verification.
- `git diff --check`: passed.
- The updated unpacked build was manually reloaded and verified in the live
  X tab. The user-owned untracked video was left untouched.
