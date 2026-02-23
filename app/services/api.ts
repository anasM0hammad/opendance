import { File, Paths } from 'expo-file-system';

// Point this to your Cloudflare Worker URL
const WORKER_URL = __DEV__
  ? 'http://10.0.2.2:8787' // Android emulator -> host machine
  : 'https://opendance-worker.YOUR_SUBDOMAIN.workers.dev'; // Replace after deploy

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function generateVideo(
  imageUri: string,
  prompt: string,
): Promise<{ taskId: string }> {
  // Read image as base64
  const file = new File(imageUri);
  const bytes = await file.bytes();
  const base64 = uint8ArrayToBase64(bytes);

  const response = await fetch(`${WORKER_URL}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: base64, prompt }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Generation failed: ${text}`);
  }

  return response.json();
}

export async function checkStatus(
  taskId: string,
): Promise<{ status: string; videoUrl?: string }> {
  const response = await fetch(`${WORKER_URL}/status/${taskId}`);

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

// Poll until video is ready, returns the Kling video URL
export async function pollUntilDone(
  taskId: string,
  onStatusUpdate?: (status: string) => void,
): Promise<string> {
  let delay = 3000; // Start at 3s
  const maxDelay = 10000; // Cap at 10s

  while (true) {
    await new Promise((r) => setTimeout(r, delay));

    const result = await checkStatus(taskId);
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
