const crypto = require('crypto');

const SESSION_COOKIE = '__Host-sokcho_admin';
const SESSION_SECONDS = 8 * 60 * 60;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  return String(header || '').split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index < 0) return cookies;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return cookies;
  }, {});
}

function signSession(expiresAt, secret) {
  const signature = crypto.createHmac('sha256', secret).update(String(expiresAt)).digest('hex');
  return `${expiresAt}.${signature}`;
}

function verifySession(token, secret) {
  const [expiresAt, signature] = String(token || '').split('.');
  if (!expiresAt || !signature || !/^\d+$/.test(expiresAt)) return false;
  if (Number(expiresAt) <= Date.now()) return false;
  const expected = crypto.createHmac('sha256', secret).update(expiresAt).digest('hex');
  return safeEqual(signature, expected);
}

async function redisCommand(command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('상담목록 저장소 환경변수가 없습니다.');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || `Redis ${response.status}`);
  return payload.result;
}

async function readLeads() {
  const ids = await redisCommand(['ZREVRANGE', 'sokcho:leads', '0', '499']);
  if (!Array.isArray(ids) || !ids.length) return [];
  const values = await redisCommand(['MGET', ...ids.map((id) => `sokcho:lead:${id}`)]);
  return (Array.isArray(values) ? values : []).map((value) => {
    try { return typeof value === 'string' ? JSON.parse(value) : value; } catch (_) { return null; }
  }).filter(Boolean);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const adminPassword = process.env.ADMIN_PASSWORD;
  const sessionSecret = process.env.ADMIN_SESSION_SECRET;
  if (!adminPassword || !sessionSecret) {
    return res.status(500).json({ error: '관리자 환경설정이 필요합니다.' });
  }

  if (req.method === 'GET') {
    const cookies = parseCookies(req.headers.cookie);
    if (!verifySession(cookies[SESSION_COOKIE], sessionSecret)) {
      return res.status(401).json({ error: '로그인이 필요합니다.' });
    }
    try {
      const leads = await readLeads();
      return res.status(200).json({ ok: true, leads });
    } catch (err) {
      console.error('Admin lead list failed', err && err.message ? err.message : err);
      return res.status(500).json({ error: '상담 목록을 불러오지 못했습니다.' });
    }
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (body.action === 'logout') {
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
      return res.status(200).json({ ok: true });
    }

    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const clientKey = crypto.createHash('sha256').update(forwarded || 'unknown').digest('hex').slice(0, 24);
    const attemptsKey = `sokcho:admin-attempts:${clientKey}`;
    try {
      const attempts = Number(await redisCommand(['GET', attemptsKey]) || 0);
      if (attempts >= 5) {
        return res.status(429).json({ error: '로그인 시도가 많습니다. 10분 후 다시 시도해주세요.' });
      }
      if (!safeEqual(body.password, adminPassword)) {
        const nextAttempts = Number(await redisCommand(['INCR', attemptsKey]) || 1);
        if (nextAttempts === 1) await redisCommand(['EXPIRE', attemptsKey, '600']);
        return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
      }
      await redisCommand(['DEL', attemptsKey]);
      const expiresAt = Date.now() + SESSION_SECONDS * 1000;
      const session = signSession(expiresAt, sessionSecret);
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${session}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Admin login failed', err && err.message ? err.message : err);
      return res.status(500).json({ error: '관리자 로그인 중 오류가 발생했습니다.' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: '지원하지 않는 요청입니다.' });
};
