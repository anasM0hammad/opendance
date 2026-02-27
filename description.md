# OpenDance — Project Description

## Overview

OpenDance is a mobile application (Android) that lets users create AI-generated video clips from photos and chain them together into a continuous sequence. Users take or pick a photo, describe the motion they want, and the app generates a 5-second video using the Kling AI API. The last frame of each generated clip is automatically extracted and offered as the starting image for the next clip, enabling storytelling with visual continuity across multiple clips.

## Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Mobile App | React Native + Expo | SDK 54 |
| Language | TypeScript | 5.9 |
| Navigation | expo-router | 6.x |
| State Management | Zustand | 5.x |
| Camera | expo-camera | 17.x |
| Image Picker | expo-image-picker | 17.x |
| Video Player | expo-av | 16.x |
| Thumbnails | expo-video-thumbnails | 10.x |
| File System | expo-file-system (new class API) | 19.x |
| Media Saving | expo-media-library | 18.x |
| Backend Proxy | Cloudflare Workers | Wrangler 4.x |
| Video Generation AI | Kling API v2-6 | image2video |

## Architecture

```
┌──────────────────────────────────┐
│         Mobile App               │
│     (React Native / Expo)        │
│                                  │
│  ┌────────────┐  ┌────────────┐  │
│  │  UI Layer  │  │  Zustand   │  │
│  │ (index.tsx)│◄─│   Store    │  │
│  │            │─►│(useClipStore)│ │
│  └─────┬──────┘  └────────────┘  │
│        │                         │
│  ┌─────▼──────┐                  │
│  │  Services  │                  │
│  │  (api.ts)  │                  │
│  └─────┬──────┘                  │
└────────┼─────────────────────────┘
         │ HTTP (JSON)
         ▼
┌──────────────────────────────────┐
│      Cloudflare Worker           │
│     (Stateless Proxy)            │
│                                  │
│  - JWT generation (HS256)        │
│  - POST /generate                │
│  - GET  /status/:taskId          │
│  - CORS headers                  │
└────────┬─────────────────────────┘
         │ HTTPS (JWT Auth)
         ▼
┌──────────────────────────────────┐
│         Kling API                │
│                                  │
│  - Model: kling-v2-6             │
│  - Endpoint: image2video         │
│  - 5-second clips, std mode      │
│  - Async: submit → poll → fetch  │
└──────────────────────────────────┘
```

### Design Decisions

- **No backend storage**: Everything lives on-device. The Zustand store holds clip metadata in-memory. Video files are cached locally. This keeps the architecture simple and avoids server costs beyond the worker proxy.
- **Worker as proxy**: The Cloudflare Worker exists solely to keep Kling API credentials off the client. It generates short-lived JWT tokens server-side and proxies requests. It stores no state.
- **Last-frame continuity**: Each 5-second clip's frame at 4900ms is extracted using `expo-video-thumbnails`. This frame is offered as the input image for the next clip, creating visual continuity in a chain of clips.
- **Context prompts**: The last 2 clip prompts are prepended to the current prompt to help the AI maintain narrative and motion continuity.

## Project Structure

```
opendance/
├── .gitignore                  # Root gitignore (secrets, node_modules, caches)
├── description.md              # This file
├── review.md                   # Code review with issues and RCA
│
├── app/                        # Expo React Native mobile app
│   ├── app/                    # expo-router pages
│   │   ├── _layout.tsx         # Root layout (Stack navigator, dark theme)
│   │   └── index.tsx           # Main screen (all 4 phases)
│   ├── services/
│   │   └── api.ts              # Worker API client (generate, poll, download)
│   ├── store/
│   │   └── useClipStore.ts     # Zustand state (clips, phase, image selection)
│   ├── assets/                 # App icons and splash screen
│   ├── app.json                # Expo configuration
│   ├── package.json            # App dependencies
│   ├── tsconfig.json           # TypeScript config
│   └── .gitignore              # App-specific ignores
│
└── worker/                     # Cloudflare Worker (API proxy)
    ├── src/
    │   └── index.ts            # Worker entry (JWT auth, route handlers)
    ├── wrangler.toml           # Wrangler configuration
    ├── package.json            # Worker dependencies
    └── tsconfig.json           # TypeScript config
```

## User Workflow

### Phase 1: Camera (Image Capture)

The app launches in the camera phase. The user has two options:

1. **Take a photo** using the device camera (rear-facing)
2. **Pick from gallery** using the device image picker

Once an image is selected, the app transitions to the prompt phase.

For clips after the first one, a third option is available:
3. **Use last frame** — the last frame of the previous clip is auto-selected as the input image, enabling visual continuity.

### Phase 2: Prompt (Scene Description)

The user sees:
- A preview of the selected image
- Options to change the image (retake, gallery, use last frame)
- A context hint showing the previous clip's prompt (for clips 2+)
- A text input to describe the desired motion/action

The user types a scene description (e.g., "The dancer spins and raises their arms") and taps "Generate Video".

**Context enrichment**: For clips 2+, the app automatically prepends the last 1-2 clip prompts to the user's prompt with continuity instructions. This happens transparently — the user only types the current scene's description.

### Phase 3: Generating (AI Video Generation)

The app shows:
- The input image preview
- A loading spinner
- Status updates: "Starting generation..." → "Generating video..." → "Downloading video..."
- A hint that generation typically takes 30-90 seconds

**Internal flow during this phase:**

1. The image is read from the file system and base64-encoded
2. The base64 image + enriched prompt are sent to the Cloudflare Worker via `POST /generate`
3. The Worker mints a JWT using the Kling API credentials and forwards the request to Kling's `image2video` endpoint
4. Kling returns a `task_id`
5. The app polls `GET /status/:taskId` every 3-10 seconds (exponential backoff starting at 3s, capped at 10s)
6. The Worker proxies each poll to Kling's task status endpoint
7. When Kling reports `succeed`, the Worker returns the video URL
8. The app downloads the video to the device cache
9. A thumbnail is extracted at 4900ms (near the end of the 5-second clip) using `expo-video-thumbnails`
10. The clip record in the Zustand store is updated with the video URI, last frame URI, and status `done`

### Phase 4: Preview (Video Playback)

The user sees:
- A video player showing the generated clip (auto-plays)
- A thumbnail strip for navigating between clips (visible when 2+ clips exist)
- Action buttons:
  - **Play All**: Plays clips sequentially from the first one
  - **+ Next Clip**: Starts the flow for the next clip (auto-selects last frame)
  - **Save to Gallery**: Saves the current clip to the device media library
  - **Start Over**: Clears all clips and returns to camera (with confirmation dialog)

When the user taps **+ Next Clip**, the last frame of the most recent clip is automatically selected as the input image, and the app returns to the prompt phase. This creates the chaining loop that is the core experience.

### Complete Workflow Diagram

```
                    ┌──────────┐
                    │  Launch   │
                    │   App     │
                    └─────┬────┘
                          │
                          ▼
               ┌──────────────────┐
               │   CAMERA PHASE   │
               │                  │
          ┌────│ Take Photo   OR  │────┐
          │    │ Pick from Gallery │    │
          │    └──────────────────┘    │
          │              ▲             │
          │              │ Retake /    │
          │              │ Change      │
          ▼              │             ▼
     ┌────────────────────────────────────┐
     │          PROMPT PHASE              │
     │                                    │
     │  Image Preview                     │
     │  [Change image options]            │
     │  Context: "Previous: ..."          │
     │  [ Describe this scene...       ]  │
     │  [      Generate Video          ]  │
     └──────────────┬─────────────────────┘
                    │
                    ▼
     ┌────────────────────────────────────┐
     │        GENERATING PHASE            │
     │                                    │
     │  Image Preview                     │
     │  ◌ Loading...                      │
     │  "Generating video..."             │
     │  "30-90 seconds"                   │
     │                                    │
     │  Internal:                         │
     │  1. Base64 encode image            │
     │  2. POST to Worker /generate       │
     │  3. Worker → Kling API (JWT)       │
     │  4. Poll /status/:taskId           │
     │  5. Download video on completion   │
     │  6. Extract last frame at 4900ms   │
     └──────────────┬─────────────────────┘
                    │
                    ▼
     ┌────────────────────────────────────┐
     │         PREVIEW PHASE              │
     │                                    │
     │  ▶ Video Player (auto-play)        │
     │  [1] [2] [3] ... (thumbnail strip) │
     │                                    │
     │  [ Play All ] [ + Next Clip ]      │
     │  [ Save     ] [ Start Over  ]      │
     └───────────┬──────────┬─────────────┘
                 │          │
    + Next Clip  │          │  Start Over
    (auto-select │          │  (confirm →
     last frame) │          │   clear all)
                 │          │
                 ▼          ▼
          Back to       Back to
        PROMPT PHASE   CAMERA PHASE
```

## Continuity System — How Clip Chaining Works

The defining feature of OpenDance is chaining AI-generated video clips with visual continuity. Here is how each piece contributes:

### 1. Last Frame Extraction
After each video is generated and downloaded, the app extracts a frame at 4900ms (100ms before the end of the 5-second clip) using `expo-video-thumbnails`. This frame is stored as `lastFrameUri` on the clip record.

### 2. Auto-Selection of Input Image
When the user taps "+ Next Clip", `handleAddNextClip` retrieves the last clip's `lastFrameUri` and sets it as the `selectedImageUri`. The user sees this image in the prompt phase with a "Last frame" badge, confirming continuity will be maintained.

### 3. Context Prompt Enrichment
The `getContextPrompt` function in the Zustand store prepends previous scene descriptions to the current prompt:

- **Clip 1**: User's prompt is sent as-is
- **Clip 2**: Format becomes:
  ```
  Previous scene: "[clip 1 prompt]"
  Current scene (continuing from the last frame): "[user prompt]"
  Maintain smooth visual and motion continuity.
  ```
- **Clip 3+**: Format becomes:
  ```
  Two scenes ago: "[clip N-2 prompt]"
  Previous scene: "[clip N-1 prompt]"
  Current scene (continuing from the last frame): "[user prompt]"
  Maintain smooth visual and motion continuity.
  ```

This gives the Kling AI model both visual context (via the last frame image) and narrative context (via the prompt history).

## State Management

The app uses a single Zustand store (`useClipStore`) with the following shape:

```typescript
{
  clips: Clip[];           // Array of all clip records
  phase: Phase;            // 'camera' | 'prompt' | 'generating' | 'preview'
  selectedImageUri: string | null;  // Currently selected input image

  // Actions
  setPhase(phase): void;
  setSelectedImage(uri): void;
  addClip(imageUri, prompt): string;    // Returns clip ID
  updateClip(id, updates): void;
  getLastClip(): Clip | null;
  getContextPrompt(prompt): string;     // Enriches prompt with history
  reset(): void;                        // Clears everything
}
```

Each clip record:
```typescript
{
  id: string;              // Unique ID (timestamp + random)
  imageUri: string;        // Input image URI
  prompt: string;          // User's raw prompt
  videoUri: string | null; // Downloaded video URI (null until done)
  lastFrameUri: string | null; // Extracted last frame (null until done)
  status: ClipStatus;      // 'pending' | 'generating' | 'done' | 'failed'
  klingTaskId: string | null;  // Kling API task ID for polling
}
```

## API Layer

### App → Worker Communication

| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| `/generate` | POST | `{ image: string, prompt: string }` | `{ taskId: string }` |
| `/status/:taskId` | GET | — | `{ status: string, videoUrl?: string }` |

### Worker → Kling API Communication

| Kling Endpoint | Method | Auth | Purpose |
|----------------|--------|------|---------|
| `/v1/videos/image2video` | POST | JWT Bearer | Submit generation job |
| `/v1/videos/image2video/:taskId` | GET | JWT Bearer | Check job status |

### JWT Authentication
The Worker generates JWTs with:
- Algorithm: HS256
- Issuer (`iss`): Kling Access Key
- Expiry (`exp`): 30 minutes from now
- Issued At (`iat`): 5 seconds before now (clock skew buffer)

Kling credentials are stored as Cloudflare Worker secrets (set via `wrangler secret put`), never in code.

## Development Setup

### Prerequisites
- Node.js
- Expo CLI (`npx expo`)
- Wrangler CLI (`npx wrangler`)
- Android emulator or device
- Kling API credentials (Access Key + Secret Key)

### App
```bash
cd app
npm install --legacy-peer-deps    # Required due to React 19.1 vs 19.2 peer conflict
npx expo start --android
```

### Worker
```bash
cd worker
npm install
wrangler secret put KLING_ACCESS_KEY
wrangler secret put KLING_SECRET_KEY
npx wrangler dev                  # Local dev on port 8787
```

### Dev Network Setup
The app connects to the worker at `http://10.0.2.2:8787` in development (Android emulator's alias for the host machine's localhost). In production, this should be replaced with the deployed worker URL.

## Expo SDK 54 Notes

This project uses Expo SDK 54, which introduces a **new class-based API for `expo-file-system`**:

- `new File(uri)` — wraps a file path
- `file.bytes()` — reads file as `Uint8Array`
- `File.downloadFileAsync(url, destFile)` — downloads a URL to a file
- `new File(Paths.cache, filename)` — creates a file reference in the cache directory

The legacy API (`FileSystem.readAsStringAsync`, `FileSystem.cacheDirectory`, etc.) is still available at `expo-file-system/legacy` but is not used in this project.

## Local Build & Install (Production Release APK)

Build a standalone release APK that runs independently on your device — no Metro bundler needed.

### One-liner (build + install)
```bash
cd app/android && ./gradlew assembleRelease && adb install -r app/build/outputs/apk/release/app-release.apk
```

### Step by step

**1. Generate the native android project (if not already done or after adding new native modules):**
```bash
cd app
npx expo prebuild --platform android
```

**2. Build the release APK:**
```bash
cd app/android
./gradlew assembleRelease
```
The JS bundle is automatically bundled inside the APK. No Metro required at runtime.

The APK will be at: `app/android/app/build/outputs/apk/release/app-release.apk`

**3. Install on device via ADB:**
```bash
adb install -r app/android/app/build/outputs/apk/release/app-release.apk
```
The `-r` flag replaces an existing install, keeping app data.

> **Note:** If install fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (signing key mismatch), uninstall first:
> ```bash
> adb uninstall com.anonymous.app
> ```
> Then run the install command again.

**4. Launch the app:**
```bash
adb shell am start -n com.anonymous.app/.MainActivity
```

### Useful commands

| Command | Purpose |
|---------|---------|
| `./gradlew assembleRelease` | Build release APK (JS bundled in, no Metro needed) |
| `./gradlew assembleDebug` | Build debug APK (needs Metro running) |
| `./gradlew clean` | Clean build artifacts before a fresh build |
| `adb devices` | List connected devices/emulators |
| `adb logcat -s ReactNativeJS:V` | View React Native JS logs |
| `adb uninstall com.anonymous.app` | Fully uninstall the app |

### Notes
- The release build uses the default debug signing key — fine for local testing, not for Play Store.
- Run `npx expo prebuild --platform android` again after adding/removing any Expo native module.
- Make sure `ANDROID_HOME` is set and `adb` / `gradle` are on your `PATH`.
- For a clean rebuild: `cd app/android && ./gradlew clean && ./gradlew assembleRelease`
- For opening Android studio directly `open -a "Android Studio"`

## Switch to Kling API
`npx wrangler secret put KLING_ACCESS_KEY`
`npx wrangler secret put KLING_SECRET_KEY`
`npx wrangler deploy`

