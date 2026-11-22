/**
 * Today phone OTP and session verification.
 * Never return a credential (cookie/JWT/OTP) to the DSH browser or logs.
 * Endpoints follow the 2026-11-18 Today web protocol; upstream changes may
 * require adjustments and must be verified with a real account.
 */
export const SESSION_REF = 'TODAY_AI_SESSION_COOKIE';
export const WEB_ORIGIN = 'https://todayai.cn';
export const SESSION_NAME = '__Secure-better-auth.session_token';

export function validatePhone(raw) {
  const phone = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) {
    throw new Error('请输入带国际区号的手机号，例如 +8613800000000');
  }
  return phone;
}
export function validateOtp(raw) {
  const otp = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[0-9]{4,8}$/.test(otp)) throw new Error('验证码格式不正确');
  return otp;
}
export function sessionFromHeaders(headers) {
  const values = typeof headers?.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers?.get?.('set-cookie')].filter(Boolean);
  for (const line of values) {
    // Do not parse another site's or unrelated cookie as an auth session.
    const m = /^__Secure-better-auth\.session_token=([^;\r\n]+)/i.exec(line);
    if (m && m[1] && m[1] !== 'deleted') return m[1];
  }
  return null;
}
async function post(url, body, { fetchImpl = fetch, cookie } = {}) {
  const headers = { 'content-type': 'application/json', origin: WEB_ORIGIN };
  if (cookie) headers.cookie = SESSION_NAME + '=' + cookie;
  const response = await fetchImpl(url, {
    method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
    redirect: 'manual',
  });
  if (!response.ok) {
    // Do not reflect arbitrary upstream JSON bodies: they could contain secrets.
    const code = response.status;
    if (code === 429) throw new Error('Today 操作过于频繁，请稍后再试（429）');
    if (code === 401 || code === 403) throw new Error('Today 登录验证失败（' + code + '）');
    throw new Error('Today 请求失败，HTTP ' + code);
  }
  return response;
}
export async function sendOtp(phone, opts = {}) {
  const p = validatePhone(phone);
  await post(WEB_ORIGIN + '/api/auth/phone-number/send-otp',
    { phoneNumber: p, type: 'sign-in' }, opts);
  return { sent: true };
}
export async function validateSession(cookie, opts = {}) {
  if (typeof cookie !== 'string' || cookie.length < 8 || cookie.length > 8192 ||
      /[\r\n;]/.test(cookie)) throw new Error('会话凭据格式无效');
  const response = await post(WEB_ORIGIN + '/api/token',
    { audience: 'https://api.todayai.cn', expiresIn: 3600 },
    { ...opts, cookie });
  const json = await response.json().catch(() => ({}));
  if (typeof json.token !== 'string' || !json.token) {
    throw new Error('Today 会话未返回有效访问令牌');
  }
  // JWT remains in server memory only inside the existing model adapter.
  return true;
}
export async function verifyOtp(phone, otp, opts = {}) {
  const response = await post(WEB_ORIGIN + '/api/auth/phone-number/verify',
    { phoneNumber: validatePhone(phone), otp: validateOtp(otp) }, opts);
  const cookie = sessionFromHeaders(response.headers);
  if (!cookie) throw new Error('Today 未在登录响应中返回会话 Cookie；需要调整上游登录协议');
  await validateSession(cookie, opts);
  return cookie;
}

export class TodaySession {
  constructor(credentials, { fetchImpl = fetch } = {}) {
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
    this.cookie = '';
    this.lastSentPhone = '';
    this.lastSentAt = 0;
    this.failedVerifications = 0;
  }
  async init() {
    const current = await this.credentials.resolve(SESSION_REF);
    this.cookie = typeof current?.value === 'string' ? current.value : '';
    // Do not fail startup just because a saved upstream cookie has expired.
  }
  status() {
    return { loggedIn: this.cookie.length > 0, phone: this.lastSentPhone
      ? this.lastSentPhone.slice(0, 3) + '***' + this.lastSentPhone.slice(-3) : '' };
  }
  async send(phone) {
    const p = validatePhone(phone);
    const now = Date.now();
    if (now - this.lastSentAt < 60000) throw new Error('请至少间隔 60 秒再发送验证码');
    this.lastSentAt = now; // Count even unsuccessful requests to avoid hammering OTP.
    await sendOtp(p, { fetchImpl: this.fetchImpl });
    this.lastSentPhone = p;
    this.failedVerifications = 0;
    return { sent: true };
  }
  async verify(phone, otp) {
    const p = validatePhone(phone);
    if (!this.lastSentPhone || p !== this.lastSentPhone) {
      throw new Error('请先为同一手机号获取验证码');
    }
    if (this.failedVerifications >= 5) throw new Error('验证码尝试次数已达上限，请重新获取');
    this.failedVerifications++;
    const cookie = await verifyOtp(p, otp, { fetchImpl: this.fetchImpl });
    // Persist first; do not report a successful login if it will be lost.
    await this.credentials.set(SESSION_REF, cookie);
    this.cookie = cookie;
    this.lastSentPhone = '';
    this.failedVerifications = 0;
    return this.status();
  }
  async logout() {
    await this.credentials.unset(SESSION_REF);
    this.cookie = '';
    this.lastSentPhone = '';
    return this.status();
  }
}
