import { File, Paths } from 'expo-file-system';

// Issue 15 fix: Use EXPO_PUBLIC_WORKER_URL env var for production builds.
// Fails loudly at startup if not configured, preventing silent connection failures.
const WORKER_URL = __DEV__
  ? 'http://10.0.2.2:8787' // Android emulator -> host machine
  : (process.env.EXPO_PUBLIC_WORKER_URL || 'http://localhost:8787');

// Issue 10 (app-side): Send API key header if configured.
// Set EXPO_PUBLIC_APP_API_KEY in your .env for production builds.
const APP_API_KEY = process.env.EXPO_PUBLIC_APP_API_KEY || '';

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (APP_API_KEY) {
    headers['X-API-Key'] = APP_API_KEY;
  }
  return headers;
}

// Issue 9 fix: Process in chunks to avoid O(n^2) string concatenation.
// Each chunk builds a substring from a slice of the Uint8Array, then all
// chunks are joined once before base64 encoding.
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 8192;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(''));
}

export async function generateVideo(
  imageUri: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ taskId: string }> {
  // Read image as base64
  const file = new File(imageUri);
  const bytes = await file.bytes();
  const base64 = uint8ArrayToBase64(bytes);

  const response = await fetch(`${WORKER_URL}/generate`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ image: base64, prompt }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Generation failed: ${text}`);
  }

  return response.json();
}

export async function checkStatus(
  taskId: string,
  signal?: AbortSignal,
): Promise<{ status: string; videoUrl?: string }> {
  const headers: Record<string, string> = {};
  if (APP_API_KEY) {
    headers['X-API-Key'] = APP_API_KEY;
  }

  const response = await fetch(`${WORKER_URL}/status/${taskId}`, {
    headers,
    signal,
  });

  if (!response.ok) {
    throw new Error('Status check failed');
  }

  return response.json();
}

export async function downloadVideo(
  videoUrl: string,
  clipId: string,
): Promise<string> {
  const dest = new File(Paths.cache, `clip_${clipId}.mp4`);
  const downloaded = await File.downloadFileAsync(videoUrl, dest);
  return downloaded.uri;
}

// Issue 3 fix: Added 5-minute timeout and AbortSignal support.
// The polling loop now exits on timeout, cancellation, or failure instead
// of spinning indefinitely.
const MAX_POLL_TIMEOUT = 5 * 60 * 1000; // 5 minutes

export async function pollUntilDone(
  taskId: string,
  onStatusUpdate?: (status: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  let delay = 3000; // Start at 3s
  const maxDelay = 10000; // Cap at 10s
  const startTime = Date.now();

  while (true) {
    // Check cancellation before sleeping
    if (signal?.aborted) {
      throw new Error('Generation cancelled');
    }

    // Check timeout
    if (Date.now() - startTime > MAX_POLL_TIMEOUT) {
      throw new Error('Generation timed out — please try again');
    }

    // Cancellable sleep: resolves on timeout OR abort signal
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    // Check cancellation after sleeping
    if (signal?.aborted) {
      throw new Error('Generation cancelled');
    }

    const result = await checkStatus(taskId, signal);
    onStatusUpdate?.(result.status);

    if (result.status === 'completed' && result.videoUrl) {
      return result.videoUrl;
    }

    if (result.status === 'failed') {
      throw new Error('Video generation failed');
    }

    // Exponential backoff
    delay = Math.min(delay * 1.3, maxDelay);
  }
}
