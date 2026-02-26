interface Env {
  KLING_ACCESS_KEY?: string;
  KLING_SECRET_KEY?: string;
  // Issue 10: Optional API key for client authentication.
  // Set via: wrangler secret put APP_API_KEY
  // If not set, auth is skipped (for local dev convenience).
  APP_API_KEY?: string;
}

// ---------------------------------------------------------------------------
// Dummy / real mode detection
// ---------------------------------------------------------------------------
// If Kling credentials are not configured, the worker automatically runs in
// dummy mode — it simulates generation with a short delay and returns a
// public sample video. No external API calls are made.
//
// To switch to real Kling integration, just set the secrets:
//   wrangler secret put KLING_ACCESS_KEY
//   wrangler secret put KLING_SECRET_KEY
// ---------------------------------------------------------------------------

function isDummyMode(env: Env): boolean {
  return !env.KLING_ACCESS_KEY || !env.KLING_SECRET_KEY;
}

// Publicly hosted sample video (Big Buck Bunny, Google CDN, ~2 MB)
const DUMMY_VIDEO_URL =
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';

// How long the dummy "generation" takes before returning completed (ms)
const DUMMY_DELAY_MS = 8_000;

// ---------------------------------------------------------------------------
// Dummy mode handlers
// ---------------------------------------------------------------------------
// The trick: encode the completion timestamp inside the taskId itself, so
// the worker is fully stateless (no Map, no KV, no D1). Works correctly
// even on Cloudflare's edge where each request may hit a different isolate.
// ---------------------------------------------------------------------------

async function handleGenerateDummy(request: Request): Promise<Response> {
  const body = (await request.json()) as { image: string; prompt: string };

  if (!body.image || !body.prompt) {
    return Response.json(
      { error: 'image and prompt required' },
      { status: 400 },
    );
  }

  const readyAt = Date.now() + DUMMY_DELAY_MS;
  const taskId = `dummy_${readyAt}`;

  console.log(
    `[DUMMY] Generate requested — prompt="${body.prompt.slice(0, 60)}…" → taskId=${taskId}`,
  );

  return Response.json({ taskId });
}

function handleStatusDummy(taskId: string, workerOrigin: string): Response {
  if (!taskId.startsWith('dummy_')) {
    return Response.json({ error: 'Unknown task' }, { status: 404 });
  }

  const readyAt = parseInt(taskId.split('dummy_')[1], 10);

  if (isNaN(readyAt)) {
    return Response.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  if (Date.now() < readyAt) {
    console.log(
      `[DUMMY] Status check — ${Math.ceil((readyAt - Date.now()) / 1000)}s remaining`,
    );
    return Response.json({ status: 'processing' });
  }

  console.log('[DUMMY] Status check — completed, returning video URL');
  return Response.json({
    status: 'completed',
    // Serve through the worker's own /dummy-video endpoint to avoid any
    // potential download issues with external URLs on certain networks.
    videoUrl: `${workerOrigin}/dummy-video`,
  });
}

// Proxy the sample video through the worker so the app always downloads
// from the same origin. Cloudflare streams the body — no buffering.
async function handleDummyVideo(): Promise<Response> {
  const upstream = await fetch(DUMMY_VIDEO_URL);

  if (!upstream.ok) {
    return Response.json(
      { error: 'Failed to fetch sample video' },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

// ---------------------------------------------------------------------------
// Real Kling API handlers
// ---------------------------------------------------------------------------

const KLING_BASE = 'https://api.klingai.com';

function base64url(data: ArrayBuffer | string): string {
  const str =
    typeof data === 'string'
      ? btoa(data)
      : btoa(String.fromCharCode(...new Uint8Array(data)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateJWT(
  accessKey: string,
  secretKey: string,
): Promise<string> {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({ iss: accessKey, exp: now + 1800, iat: now - 5 }),
  );

  const signingInput = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64url(sig)}`;
}

function ensureDataUri(base64Image: string): string {
  if (base64Image.startsWith('data:')) {
    return base64Image;
  }

  let mimeType = 'image/jpeg';
  if (base64Image.startsWith('iVBOR')) {
    mimeType = 'image/png';
  } else if (base64Image.startsWith('R0lGOD')) {
    mimeType = 'image/gif';
  } else if (base64Image.startsWith('UklGR')) {
    mimeType = 'image/webp';
  }

  return `data:${mimeType};base64,${base64Image}`;
}

async function handleGenerateReal(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = (await request.json()) as { image: string; prompt: string };

  if (!body.image || !body.prompt) {
    return Response.json(
      { error: 'image and prompt required' },
      { status: 400 },
    );
  }

  const token = await generateJWT(env.KLING_ACCESS_KEY!, env.KLING_SECRET_KEY!);
  const imageData = ensureDataUri(body.image);

  const klingResponse = await fetch(`${KLING_BASE}/v1/videos/image2video`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model_name: 'kling-v2-6',
      image: imageData,
      prompt: body.prompt,
      duration: '5',
      mode: 'std',
      cfg_scale: 0.5,
    }),
  });

  if (!klingResponse.ok) {
    const err = await klingResponse.text();
    return Response.json(
      { error: 'Kling API error', details: err },
      { status: klingResponse.status },
    );
  }

  const result = (await klingResponse.json()) as {
    data?: { task_id: string };
    code?: number;
    message?: string;
  };

  if (!result.data?.task_id) {
    return Response.json(
      { error: 'No task_id returned', details: result },
      { status: 500 },
    );
  }

  return Response.json({ taskId: result.data.task_id });
}

async function handleStatusReal(
  taskId: string,
  env: Env,
): Promise<Response> {
  const token = await generateJWT(env.KLING_ACCESS_KEY!, env.KLING_SECRET_KEY!);

  const klingResponse = await fetch(
    `${KLING_BASE}/v1/videos/image2video/${taskId}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!klingResponse.ok) {
    const err = await klingResponse.text();
    return Response.json({ error: err }, { status: klingResponse.status });
  }

  const result = (await klingResponse.json()) as {
    data?: {
      task_status: string;
      task_result?: { videos?: { url: string }[] };
    };
  };

  const status = result.data?.task_status ?? 'unknown';
  const videoUrl = result.data?.task_result?.videos?.[0]?.url;

  let simpleStatus: string;
  switch (status) {
    case 'succeed':
      simpleStatus = 'completed';
      break;
    case 'failed':
      simpleStatus = 'failed';
      break;
    default:
      simpleStatus = 'processing';
  }

  return Response.json({
    status: simpleStatus,
    videoUrl: simpleStatus === 'completed' ? videoUrl : undefined,
  });
}

// ---------------------------------------------------------------------------
// API Key Validation
// ---------------------------------------------------------------------------

function validateApiKey(request: Request, env: Env): Response | null {
  if (!env.APP_API_KEY) return null;
  const key = request.headers.get('X-API-Key');
  if (key !== env.APP_API_KEY) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Worker Entry
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const dummy = isDummyMode(env);
    const workerOrigin = url.origin;

    let response: Response;

    try {
      const authError = validateApiKey(request, env);

      if (authError) {
        response = authError;
      } else if (url.pathname === '/generate' && request.method === 'POST') {
        response = dummy
          ? await handleGenerateDummy(request)
          : await handleGenerateReal(request, env);
      } else if (url.pathname.startsWith('/status/')) {
        const taskId = url.pathname.split('/status/')[1];
        if (!taskId) {
          response = Response.json(
            { error: 'taskId required' },
            { status: 400 },
          );
        } else {
          response = dummy
            ? handleStatusDummy(taskId, workerOrigin)
            : await handleStatusReal(taskId, env);
        }
      } else if (url.pathname === '/dummy-video' && dummy) {
        response = await handleDummyVideo();
      } else {
        response = Response.json({
          status: 'opendance worker running',
          mode: dummy ? 'dummy' : 'live',
        });
      }
    } catch (err) {
      response = Response.json(
        { error: 'Internal error', details: String(err) },
        { status: 500 },
      );
    }

    // Attach CORS headers to every response
    const newHeaders = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders)) {
      newHeaders.set(k, v);
    }
    return new Response(response.body, {
      status: response.status,
      headers: newHeaders,
    });
  },
};
