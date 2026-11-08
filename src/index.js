const ALLOWED_METHODS = ['POST', 'OPTIONS'];
const MAX_BODY_BYTES = 32 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;
// The Worker only forwards to an n8n host and webhook path you explicitly allow.
// Configure both in wrangler.jsonc (or the Cloudflare dashboard).
function allowedHosts(env) {
  return new Set(
    String(env.N8N_ALLOWED_HOSTS || '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

function allowedPaths(env) {
  return new Set(
    String(env.N8N_ALLOWED_PATHS || '/webhook/lead-intake')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  );
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};

  const requestOrigin = new URL(request.url).origin;
  if (origin !== requestOrigin) return null;

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': ALLOWED_METHODS.join(', '),
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function requestId() {
  return crypto.randomUUID();
}

async function readJsonRequest(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return { error: json({ error: 'content_type_must_be_application_json' }, 415) };
  }

  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return { error: json({ error: 'payload_too_large' }, 413) };
  }

  const bodyText = await request.text();
  if (new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) {
    return { error: json({ error: 'payload_too_large' }, 413) };
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return { error: json({ error: 'invalid_json' }, 400) };
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: json({ error: 'invalid_payload' }, 400) };
  }

  return { bodyText, payload };
}

async function handleLead(request, env) {
  const cors = getCorsHeaders(request);
  if (cors === null) return json({ error: 'origin_not_allowed' }, 403);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors || {} });
  }

  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405, {
      Allow: ALLOWED_METHODS.join(', '),
      ...(cors || {}),
    });
  }

  const parsed = await readJsonRequest(request);
  if (parsed.error) {
    return json(await parsed.error.json(), parsed.error.status, {
      ...(cors || {}),
    });
  }

  const { bodyText } = parsed;

  // The route is configured at deploy time; the secret never enters frontend code.
  if (!env.N8N_WEBHOOK_URL || !env.N8N_WEBHOOK_KEY) {
    return json({ error: 'api_not_configured' }, 500, cors || {});
  }

  let n8nUrl;
  try {
    n8nUrl = new URL(env.N8N_WEBHOOK_URL);
  } catch {
    return json({ error: 'invalid_n8n_webhook_url_config' }, 500, cors || {});
  }

  if (
    n8nUrl.protocol !== 'https:' ||
    !allowedHosts(env).has(n8nUrl.hostname.toLowerCase()) ||
    !allowedPaths(env).has(n8nUrl.pathname)
  ) {
    return json({ error: 'invalid_n8n_webhook_url_config' }, 500, cors || {});
  }

  const id = requestId();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(n8nUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.N8N_WEBHOOK_KEY,
        'X-Request-ID': id,
      },
      body: bodyText,
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return json({
      error: timedOut ? 'upstream_timeout' : 'upstream_unreachable',
      request_id: id,
    }, 504, cors || {});
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await upstream.text();
  let upstreamBody = null;
  try {
    upstreamBody = responseText ? JSON.parse(responseText) : null;
  } catch {
    upstreamBody = responseText ? { text: responseText.slice(0, 1000) } : null;
  }

  if (!upstream.ok) {
    return json({
      error: 'n8n_rejected_request',
      upstream_status: upstream.status,
      request_id: id,
      details: upstreamBody,
    }, upstream.status, cors || {});
  }

  return json({
    status: 'accepted',
    processing: 'async',
    request_id: id,
  }, 202, cors || {});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return json({ status: 'ok', service: 'leadflow-api' });
    }

    if (url.pathname === '/api/lead') {
      return handleLead(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
