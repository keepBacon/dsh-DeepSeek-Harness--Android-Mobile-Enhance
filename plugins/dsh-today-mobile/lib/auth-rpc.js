/** Authenticated DSH Connection RPC; credentials never leave the host. */
const CHANNEL = '/dsh-today-mobile-rpc';
const METHODS = new Set(['status', 'sendOtp', 'verifyOtp', 'logout']);
const MAX_BODY = 4096;
function respond(res, code, payload) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}
function envelope(rpcId, result) {
  return { type: 'server-response', rpcId, result };
}
async function readBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      req.off('data', data); req.off('end', end); req.off('error', fail);
      req.off('aborted', fail);
      if (error) reject(error); else resolve(value);
    };
    const data = (part) => {
      size += part.length;
      if (size > MAX_BODY) { req.resume(); finish(new Error('request too large')); }
      else chunks.push(part);
    };
    const end = () => finish(null, Buffer.concat(chunks).toString('utf8'));
    const fail = () => finish(new Error('connection interrupted'));
    req.on('data', data); req.on('end', end); req.on('error', fail); req.on('aborted', fail);
  });
}
export function registerTodayAuthRpc(ctx, session, onChange) {
  const connection = ctx.get('connection');
  if (!connection || typeof connection.requestRejection !== 'function') {
    throw new Error('Today Mobile requires the official authenticated DSH Connection service');
  }
  return ctx.webServer.register({
    kind: 'prefix', path: CHANNEL,
    handler: async (req, res) => {
      // Do not expose login APIs on the public LAN or to foreign origins.
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) {
        res.statusCode = rejection;
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }
      const pathname = new URL(req.url || '/', 'http://localhost').pathname;
      const method = pathname.startsWith(CHANNEL + '/') ? pathname.slice(CHANNEL.length + 1) : '';
      if (!METHODS.has(method)) { res.statusCode = 404; res.end(); return; }
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
      if (!/^application\/json(?:;|$)/i.test(String(req.headers['content-type'] || ''))) {
        res.statusCode = 415; res.end(); return;
      }
      let msg;
      try {
        msg = JSON.parse(await readBody(req));
        if (!msg || msg.type !== 'client-request' || typeof msg.rpcId !== 'string'
            || msg.method !== method || !msg.payload || typeof msg.payload !== 'object') {
          throw new Error('invalid request');
        }
      } catch {
        res.statusCode = 400; res.end(); return;
      }
      const args = msg.payload.args || {};
      try {
        let value;
        if (method === 'status') value = session.status();
        else if (method === 'sendOtp') value = await session.send(args.phone);
        else if (method === 'verifyOtp') {
          value = await session.verify(args.phone, args.otp);
          onChange?.();
        } else if (method === 'logout') {
          value = await session.logout();
          onChange?.();
        }
        respond(res, 200, envelope(msg.rpcId, { ok: true, value }));
      } catch (error) {
        // Only messages created by our own auth code may reach the UI.
        respond(res, 200, envelope(msg.rpcId, {
          ok: false, error: { code: 'today-auth', message: error instanceof Error ? error.message : '登录失败' },
        }));
      }
    },
  });
}
