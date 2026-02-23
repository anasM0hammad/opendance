# OpenDance — Code Review

**Date:** 2026-02-24
**Scope:** Full codebase review (app + worker)
**Reviewer:** Claude Code (automated)

---

## Review Summary

| Severity | Count | Key Theme |
|----------|-------|-----------|
| Critical | 4 | Stale closures, infinite polling, no cancel |
| High | 4 | Broken continuity chain, no persistence, playback bugs |
| Medium | 4 | Memory, security, API compatibility |
| Low | 5 | Polish and cleanup |

---

## Critical Issues — Workflow-Breaking

### Issue 1: Stale `clips.length` in `startGeneration` closure

- **File:** `app/app/index.tsx` — `startGeneration` callback
- **Symptom:** After generating a clip, "Play the new clip" sets the wrong playback index.
- **RCA:** `startGeneration` captures `clips.length` from the render cycle when the callback was created via `useCallback`. Inside the same function, `addClip()` appends a new clip to the Zustand store. But by the time `setCurrentPlayingIndex(clips.length)` runs, the `clips` variable in the closure still reflects the count *before* `addClip` was called — it is a stale snapshot from the last render, not the latest Zustand state.
- **Impact:** `currentPlayingIndex` is off-by-one. On the first clip it happens to be correct (0), but on subsequent clips the index diverges, especially if any clips have `failed` status mixed in.
- **Fix:** Read the latest clip count from the Zustand store directly via `useClipStore.getState().clips` after the update, or compute the correct index from the updated store after `updateClip`.

---

### Issue 2: `addClip` calls `getContextPrompt` but the result is never used

- **File:** `app/store/useClipStore.ts` — `addClip` method
- **RCA:** Inside `addClip`, the line `const fullPrompt = get().getContextPrompt(prompt)` executes but the return value `fullPrompt` is never stored anywhere. The clip's `.prompt` field is set to the raw `prompt` parameter. Meanwhile in `index.tsx`, the caller *also* calls `getContextPrompt(prompt.trim())` separately and passes that enriched prompt to the API. So the store call is dead code.
- **Impact:** No functional bug today, but this dead code makes intent unclear. It signals confusion about where prompt enrichment is supposed to live. A future developer might assume `addClip` handles context enrichment and skip doing it at the call site, causing the context prompt to be lost.
- **Fix:** Remove the dead `getContextPrompt` call from `addClip`, or move prompt enrichment entirely into the store and store the full prompt on the clip.

---

### Issue 3: No timeout on polling — infinite loop risk

- **File:** `app/services/api.ts` — `pollUntilDone` function
- **RCA:** `pollUntilDone` uses a `while(true)` loop with no maximum attempt count, no total elapsed time check, and no AbortController/cancellation mechanism. If the Kling API gets stuck in `processing` state (which can happen with API issues, rate limits, or backend problems), the polling will spin indefinitely. The delay grows via exponential backoff but caps at 10 seconds, so it will keep retrying forever.
- **Impact:** The user sees "Generating video..." forever with no way to cancel or go back. The only recourse is to force-kill the app, which loses all in-memory state (all clips gone, since there is no persistence — see Issue 6).
- **Fix:** Add a maximum timeout (e.g., 5 minutes) or maximum attempt count. Accept an `AbortSignal` parameter so the UI can offer a cancel button.

---

### Issue 4: No way to cancel or go back during generation

- **File:** `app/app/index.tsx` — generating phase render block
- **RCA:** The generating phase renders only a spinner, status text, and a hint. There is no back button, cancel button, or any interactive element. The user is trapped on this screen for the entire duration of generation.
- **Impact:** If generation takes unexpectedly long, if the network drops, or if the API silently hangs (see Issue 3), the user has no escape. Combined with no persistence (Issue 6), force-killing the app means total data loss.
- **Fix:** Add a "Cancel" button that aborts the polling, reverts the clip status to `failed`, and returns to the prompt phase.

---

## High Severity Issues — Significant Workflow Problems

### Issue 5: `getLastClip` returns last clip by array position, not last *done* clip

- **File:** `app/store/useClipStore.ts` — `getLastClip` method
- **RCA:** `getLastClip` returns `clips[clips.length - 1]` regardless of the clip's status. If the most recent clip has status `'failed'` or `'generating'`, its `lastFrameUri` will be `null`. When `handleAddNextClip` (in `index.tsx`) checks `last?.lastFrameUri`, the null check fails and the user falls through to the camera phase instead of being offered the last *successful* clip's frame.
- **Impact:** If a generation fails, pressing "+ Next Clip" sends the user back to camera instead of offering the last successful clip's frame. The continuity chain — the core feature of the app — breaks after any failure.
- **Fix:** Change `getLastClip` to return the last clip with `status === 'done'`, or add a separate `getLastDoneClip` method for continuity purposes.

---

### Issue 6: All clips lost on app restart — no persistence

- **File:** `app/store/useClipStore.ts` — Zustand store
- **RCA:** The Zustand store is purely in-memory with no persistence middleware. Zustand's `persist` middleware (available via `zustand/middleware`) supports `AsyncStorage` or MMKV for React Native, but it is not configured. Downloaded video files exist in the cache directory but the clip metadata (URIs, prompts, ordering, state) is entirely in RAM.
- **Impact:** The user loses all work if:
  - The app is backgrounded and killed by the OS (very common on Android)
  - The app crashes
  - The device restarts
  - The user accidentally navigates away in a way that reloads the JS bundle
- **Fix:** Add `persist` middleware to Zustand with `AsyncStorage` (from `@react-native-async-storage/async-storage`). Persist at minimum the `clips` array. Consider also storing videos in a permanent directory (not cache) since the OS can evict cache at any time.

---

### Issue 7: "Play All" button is a no-op when already on clip 1

- **File:** `app/app/index.tsx` — `playAll` callback
- **RCA:** `playAll()` calls `setCurrentPlayingIndex(0)`. If the user is already at index 0, this is a no-op — React does not re-render or re-trigger effects when state is set to the same value. The `Video` component keeps its current playback position and does not restart.
- **Impact:** The "Play All" button does nothing if the user is already viewing clip 1. They have to manually tap clip 2+, then tap "Play All" for it to work, which defeats the purpose.
- **Fix:** Either:
  - Call `videoRef.current?.replayAsync()` after setting the index, or
  - Use a separate counter/key state that forces a Video remount, or
  - Set index to `-1` first then `0` in a microtask to force a state change.

---

### Issue 8: Sequential playback doesn't reliably restart video on index change

- **File:** `app/app/index.tsx` — video playback logic
- **RCA:** When `currentPlayingIndex` changes (either from `onVideoEnd` or thumbnail tap), the `Video` component receives a new `source` URI. However, there is no explicit call to `videoRef.current.replayAsync()` or a `key` prop on the `Video` component to force a remount. Whether `expo-av`'s `Video` component auto-plays from the beginning on source change depends on internal player state, platform behavior, and timing.
- **Impact:** Unpredictable behavior when clicking thumbnails or when clips auto-advance. The video may resume from a previous position, show a black frame, or not play at all.
- **Fix:** Add a `key={currentClip?.id}` prop to the `Video` component so React unmounts and remounts it on clip change, ensuring fresh playback.

---

## Medium Severity Issues

### Issue 9: Base64 encoding is memory-intensive — OOM risk

- **File:** `app/services/api.ts` — `uint8ArrayToBase64` function
- **RCA:** The function uses string concatenation in a loop (`binary += String.fromCharCode(bytes[i])`). For a high-resolution photo (several MB as JPEG, larger as raw bytes), this creates thousands of intermediate string objects due to JavaScript's immutable strings. Additionally, the entire image is:
  1. Loaded into memory as a `Uint8Array`
  2. Doubled in memory as a base64 string (~33% larger than binary)
  3. Embedded in a JSON body string
  This means a 3MB photo could use 10-12MB+ of heap.
- **Impact:** Potential out-of-memory crashes on low-end Android devices. Even on mid-range devices, this causes GC pressure and UI jank during upload.
- **Fix:** Process in chunks, or better yet, use multipart form upload to avoid base64 entirely. Alternatively, upload the image to a temporary URL and pass the URL to Kling's API.

---

### Issue 10: Worker has no authentication — open proxy

- **File:** `worker/src/index.ts` — CORS is `*`, no API key or auth check
- **RCA:** The worker accepts requests from any origin with no authentication. Anyone who discovers the Worker URL (via network inspection, code leak, or brute force) can make unlimited Kling API calls charged to the owner's account.
- **Impact:** Financial exposure — Kling API calls are billed per generation. An attacker could automate thousands of requests and run up significant costs.
- **Fix:** Add at minimum:
  - A shared secret/API key header that the app sends and the worker validates
  - Rate limiting (Cloudflare Workers supports Durable Objects or simple in-memory rate limiting)
  - Restrict CORS to the app's origin in production

---

### Issue 11: Raw base64 sent to Kling without data URI prefix

- **File:** `worker/src/index.ts` — `handleGenerate`, the `image` field in the Kling API request body
- **RCA:** The app sends raw base64-encoded image data. The worker forwards it directly as the `image` field. Kling's API documentation may expect a data URI format (`data:image/jpeg;base64,...`) or a URL. Sending raw base64 without the prefix relies on Kling's parser being lenient.
- **Impact:** Could silently fail, produce degraded results, or break if Kling tightens their input validation. This is fragile and undocumented.
- **Fix:** Prepend the appropriate data URI prefix (e.g., `data:image/jpeg;base64,`) before the base64 string, or detect the image format from the first bytes and add the correct MIME type.

---

### Issue 12: `ResizeMode` import may be deprecated in Expo SDK 54

- **File:** `app/app/index.tsx` — `import { Video, ResizeMode } from 'expo-av'`
- **RCA:** In recent versions of `expo-av` bundled with Expo SDK 54, the `ResizeMode` enum may have been moved, renamed, or deprecated in favor of string literals. The exact availability depends on the `expo-av` version resolved.
- **Impact:** Potential TypeScript compilation error or runtime warning. May work today but break on next Expo update.
- **Fix:** Verify the import against the installed `expo-av` version. Consider using the string literal `"contain"` directly if `ResizeMode` is unavailable.

---

## Low Severity Issues

### Issue 13: No error boundary

- **RCA:** The app has no React error boundary component wrapping the main screen or the root layout.
- **Impact:** Any unhandled JavaScript error in the component tree shows a red screen (dev) or white screen (production) with no recovery option.
- **Fix:** Add an error boundary component in `_layout.tsx` that catches errors and shows a "Something went wrong" screen with a retry/reset button.

### Issue 14: No loading state for camera initialization

- **RCA:** The `CameraView` component takes time to initialize. During this period, the user sees a black screen with no indication that the camera is loading.
- **Impact:** Poor UX — user may think the app is broken.
- **Fix:** Show a loading indicator until the camera stream is active.

### Issue 15: Production Worker URL is a placeholder

- **File:** `app/services/api.ts` — `WORKER_URL` constant
- **RCA:** The production URL is set to `'https://opendance-worker.YOUR_SUBDOMAIN.workers.dev'` with a comment to replace after deploy. This is easy to forget.
- **Impact:** Production build will fail to connect to the worker.
- **Fix:** Use an environment variable for the worker URL. Fail loudly at startup if it is not set.

### Issue 16: Image quality may still be too high for base64 path

- **RCA:** `quality: 0.7` on the image picker still produces images that can be 1-3MB as JPEG. Combined with base64 encoding overhead (Issue 9), this is substantial.
- **Impact:** Slow uploads, high memory usage.
- **Fix:** Consider reducing to 0.5 or adding image resizing before upload.

### Issue 17: No video cache cleanup

- **RCA:** Downloaded videos are stored in the cache directory but never cleaned up. Each clip is a 5-second video file (typically 2-5MB).
- **Impact:** Cache directory grows indefinitely across sessions. Over time this consumes significant device storage.
- **Fix:** Clean up old cached videos on app start or when "Start Over" is pressed. Alternatively, implement a maximum cache size policy.

---

## Recommendations — Priority Order

1. **Add cancel button + polling timeout** (Issues 3, 4) — Highest UX impact, prevents users from being stuck.
2. **Fix `getLastClip` to return last done clip** (Issue 5) — Core feature (continuity chaining) is broken after any failure.
3. **Fix stale closure in `startGeneration`** (Issue 1) — Causes wrong clip to play after generation.
4. **Add `key` prop to Video component** (Issue 8) — Fixes unpredictable playback behavior.
5. **Fix "Play All" no-op** (Issue 7) — Button currently broken in common scenario.
6. **Add persistence to Zustand** (Issue 6) — Prevents total data loss on app kill.
7. **Add worker authentication** (Issue 10) — Prevents cost abuse.
8. **Remove dead code in `addClip`** (Issue 2) — Quick cleanup, prevents future confusion.
9. **Optimize base64 encoding** (Issue 9) — Prevents OOM on low-end devices.
10. **Add data URI prefix for Kling** (Issue 11) — Ensures API compatibility.
