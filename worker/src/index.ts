interface Env {
  KLING_ACCESS_KEY: string;
  KLING_SECRET_KEY: string;
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

// --- Route Handlers ---

async function handleGenerate(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { image: string; prompt: string };

  if (!body.image || !body.prompt) {
    return Response.json({ error: 'image and prompt required' }, { status: 400 });
  }

  const token = await generateJWT(env.KLING_ACCESS_KEY, env.KLING_SECRET_KEY);

  const klingResponse = await fetch(`${KLING_BASE}/v1/videos/image2video`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model_name: 'kling-v2-6',
      image: body.image, // base64 string
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
    // CORS headers for dev
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    let response: Response;

    try {
      if (url.pathname === '/generate' && request.method === 'POST') {
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
