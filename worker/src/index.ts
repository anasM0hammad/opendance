interface Env {
  KLING_ACCESS_KEY: string;
  KLING_SECRET_KEY: string;
  // Issue 10: Optional API key for client authentication.
  // Set via: wrangler secret put APP_API_KEY
  // If not set, auth is skipped (for local dev convenience).
  APP_API_KEY?: string;
}

const KLING_BASE = 'https://api.klingai.com';

// --- JWT Generation (HS256) for Kling API ---

function base64url(data: ArrayBuffer | string): string {
  const str =
    typeof data === 'string'
      ? btoa(data)
      : btoa(String.fromCharCode(...new Uint8Array(data)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateJWT(accessKey: string, secretKey: string): Promise<string> {
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

// --- Issue 10: API Key Validation ---
// Validates X-API-Key header against APP_API_KEY secret.
// If APP_API_KEY is not configured, auth is skipped (local dev).
// NOTE: This is a basic speed bump. For production, also add rate limiting
// via Cloudflare's built-in rate limiting or Durable Objects.

function validateApiKey(request: Request, env: Env): Response | null {
  if (!env.APP_API_KEY) return null; // Auth not configured — skip
  const key = request.headers.get('X-API-Key');
  if (key !== env.APP_API_KEY) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null; // Auth passed
}

// --- Issue 11: Detect image MIME type and ensure data URI prefix ---

function ensureDataUri(base64Image: string): string {
  // Already has data URI prefix — return as-is
  if (base64Image.startsWith('data:')) {
    return base64Image;
  }

  // Detect format from base64-decoded first bytes
  // JPEG starts with /9j/ in base64 (0xFF 0xD8), PNG starts with iVBOR (0x89 0x50)
  let mimeType = 'image/jpeg'; // Default to JPEG
  if (base64Image.startsWith('iVBOR')) {
    mimeType = 'image/png';
  } else if (base64Image.startsWith('R0lGOD')) {
    mimeType = 'image/gif';
  } else if (base64Image.startsWith('UklGR')) {
    mimeType = 'image/webp';
  }

  return `data:${mimeType};base64,${base64Image}`;
}

// --- Route Handlers ---

async function handleGenerate(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { image: string; prompt: string };

  if (!body.image || !body.prompt) {
    return Response.json({ error: 'image and prompt required' }, { status: 400 });
  }

  const token = await generateJWT(env.KLING_ACCESS_KEY, env.KLING_SECRET_KEY);

  // Issue 11 fix: Ensure the image has a data URI prefix for Kling API compatibility
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

async function handleStatus(taskId: string, env: Env): Promise<Response> {
  const token = await generateJWT(env.KLING_ACCESS_KEY, env.KLING_SECRET_KEY);

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

  // Map Kling statuses to our simple ones
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

// --- Worker Entry ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS headers — kept permissive because the primary client is a native
    // mobile app (CORS is a browser-only concept). The X-API-Key header is
    // the actual access control mechanism.
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    let response: Response;

    try {
      // Issue 10: Validate API key before processing any route
      const authError = validateApiKey(request, env);
      if (authError) {
        response = authError;
      } else if (url.pathname === '/generate' && request.method === 'POST') {
        response = await handleGenerate(request, env);
      } else if (url.pathname.startsWith('/status/')) {
        const taskId = url.pathname.split('/status/')[1];
        if (!taskId) {
          response = Response.json({ error: 'taskId required' }, { status: 400 });
        } else {
          response = await handleStatus(taskId, env);
        }
      } else {
        response = Response.json({ status: 'opendance worker running' });
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
