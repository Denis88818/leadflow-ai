import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const ORIGIN = 'https://leadflow.example.com';
const env = {
  N8N_WEBHOOK_URL: 'https://n8n.example.com/webhook/lead-intake',
  N8N_ALLOWED_HOSTS: 'n8n.example.com',
  N8N_ALLOWED_PATHS: '/webhook/lead-intake',
  N8N_WEBHOOK_KEY: 'test-key',
  ASSETS: { fetch: async () => new Response('static asset') },
};

const lead = {
  name: 'Marie Laurent',
  email: 'marie@demo-company.fr',
  company: 'Demo Company',
  message: 'We need an n8n workflow that sends website leads to HubSpot. Budget 3000 EUR, start next month.',
  consent: true,
};

function post(body, headers = {}) {
  return new Request(`${ORIGIN}/api/lead`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

let realFetch;
let upstreamCalls;

beforeEach(() => {
  realFetch = globalThis.fetch;
  upstreamCalls = [];
  globalThis.fetch = async (url, init) => {
    upstreamCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({ status: 'accepted' }), { status: 202 });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('health check responds ok', async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/health`), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok', service: 'leadflow-api' });
});

test('valid lead is forwarded to n8n with the secret header and a request id', async () => {
  const res = await worker.fetch(post(lead), env);
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.status, 'accepted');
  assert.ok(body.request_id);

  assert.equal(upstreamCalls.length, 1);
  const { url, init } = upstreamCalls[0];
  assert.equal(url, env.N8N_WEBHOOK_URL);
  assert.equal(init.headers['X-API-Key'], 'test-key');
  assert.equal(init.headers['X-Request-ID'], body.request_id);
});

test('the secret is never returned to the browser', async () => {
  const res = await worker.fetch(post(lead), env);
  assert.ok(!(await res.text()).includes('test-key'));
});

test('cross-origin requests are rejected', async () => {
  const res = await worker.fetch(post(lead, { Origin: 'https://evil.example' }), env);
  assert.equal(res.status, 403);
  assert.equal(upstreamCalls.length, 0);
});

test('non-JSON bodies are rejected', async () => {
  const req = new Request(`${ORIGIN}/api/lead`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Origin: ORIGIN },
    body: 'hello',
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 415);
});

test('malformed JSON is rejected', async () => {
  const res = await worker.fetch(post('{not json'), env);
  assert.equal(res.status, 400);
});

test('oversized payloads are rejected', async () => {
  const res = await worker.fetch(post({ ...lead, message: 'x'.repeat(40 * 1024) }), env);
  assert.equal(res.status, 413);
  assert.equal(upstreamCalls.length, 0);
});

test('a webhook URL outside the allowlist is never called', async () => {
  const res = await worker.fetch(post(lead), { ...env, N8N_WEBHOOK_URL: 'https://attacker.example/webhook/lead-intake' });
  assert.equal(res.status, 500);
  assert.equal(upstreamCalls.length, 0);
});

test('missing configuration fails closed', async () => {
  const res = await worker.fetch(post(lead), { ...env, N8N_WEBHOOK_KEY: '' });
  assert.equal(res.status, 500);
  assert.equal(upstreamCalls.length, 0);
});

test('GET on the lead endpoint is not allowed', async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/lead`, { headers: { Origin: ORIGIN } }), env);
  assert.equal(res.status, 405);
});

test('n8n errors are passed through as a sanitized error', async () => {
  globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
  const res = await worker.fetch(post(lead), env);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'n8n_rejected_request');
});

test('static pages are served from assets', async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/`), env);
  assert.equal(await res.text(), 'static asset');
});
