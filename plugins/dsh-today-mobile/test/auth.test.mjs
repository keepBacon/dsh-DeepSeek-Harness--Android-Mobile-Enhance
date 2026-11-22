import test from 'node:test';
import assert from 'node:assert/strict';
import { TodaySession, SESSION_REF, validatePhone, validateOtp,
  sessionFromHeaders, verifyOtp } from '../lib/auth.js';
import { registerTodayAuthRpc } from '../lib/auth-rpc.js';
import { Readable } from 'node:stream';

test('phone and OTP are validated before upstream requests', () => {
  assert.equal(validatePhone('+8613800000000'), '+8613800000000');
  assert.throws(() => validatePhone('13800000000'));
  assert.throws(() => validatePhone('+86\n13800000000'));
  assert.equal(validateOtp('123456'), '123456');
  assert.throws(() => validateOtp('xx1234'));
});
test('only expected auth cookie is extracted', () => {
  const headers = new Headers();
  headers.append('set-cookie', 'other=evil; Path=/');
  headers.append('set-cookie', '__Secure-better-auth.session_token=abc.def; HttpOnly; Secure; Path=/');
  assert.equal(sessionFromHeaders(headers), 'abc.def');
  assert.equal(sessionFromHeaders(new Headers({ 'set-cookie': 'other=secret; Path=/' })), null);
});
function setup() {
  const values = new Map();
  const credentials = {
    async resolve(ref) { return { value: values.get(ref) }; },
    async set(ref, value) { values.set(ref, value); },
    async unset(ref) { values.delete(ref); },
  };
  const requests = [];
  const fetchImpl = async (url, opts) => {
    requests.push({ url, opts });
    if (url.endsWith('/send-otp')) return new Response('{}', { status: 200 });
    if (url.endsWith('/verify')) return new Response('{}', {
      status: 200,
      headers: { 'set-cookie': '__Secure-better-auth.session_token=session.secret; HttpOnly; Secure' },
    });
    if (url.endsWith('/api/token')) return new Response('{"token":"test-only-jwt"}',
      { status: 200, headers: { 'content-type': 'application/json' } });
    throw Error('unexpected URL ' + url);
  };
  return { credentials, values, requests, fetchImpl };
}
test('OTP -> verified session -> persisted credentials -> logout', async () => {
  const t = setup();
  const session = new TodaySession(t.credentials, { fetchImpl: t.fetchImpl });
  await session.init();
  assert.equal(session.status().loggedIn, false);
  const sent = await session.send('+8613800000000');
  assert.equal(sent.sent, true);
  await assert.rejects(session.send('+8613800000000'), /60 秒/);
  const result = await session.verify('+8613800000000', '123456');
  assert.deepEqual(result, { loggedIn: true, phone: '' });
  assert.equal(t.values.get(SESSION_REF), 'session.secret');
  assert.equal(t.requests[2].opts.headers.cookie,
    '__Secure-better-auth.session_token=session.secret');
  const loaded = new TodaySession(t.credentials, { fetchImpl: t.fetchImpl });
  await loaded.init();
  assert.equal(loaded.status().loggedIn, true);
  await loaded.logout();
  assert.equal(t.values.has(SESSION_REF), false);
  assert.equal(loaded.status().loggedIn, false);
});
test('verification refuses missing cookie and no credentials are saved', async () => {
  const fetchImpl = async () => new Response('{}', { status: 200 });
  await assert.rejects(verifyOtp('+8613800000000', '123456', { fetchImpl }),
    /会话 Cookie/);
});
test('RPC refuses unauthorized requests before reading their body', async () => {
  let handler;
  const ctx = {
    get: () => ({ requestRejection: () => 403 }),
    webServer: { register: route => { handler = route.handler; return () => {}; } },
  };
  registerTodayAuthRpc(ctx, { status: () => ({ loggedIn: false }) });
  let payload = '';
  const req = Readable.from([Buffer.from(JSON.stringify({
    type: 'client-request', rpcId: 'x', method: 'status', payload: { args: {} },
  }))]);
  req.url = '/dsh-today-mobile-rpc/status';
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  const res = { statusCode: 200, end: x => { payload = x ?? ''; },
    setHeader() {} };
  await handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(payload, 'forbidden');
});
