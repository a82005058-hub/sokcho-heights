const crypto = require('crypto');

const RETENTION_SECONDS = 7 * 24 * 60 * 60;
const DEDUPE_SECONDS = 60;
const MAX_VISITS_PER_DAY = 100;

function clean(value, max = 200) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function clientIp(req) {
  const forwarded = req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '';
  const value = clean(String(forwarded).split(',')[0], 64);
  return value.replace(/^::ffff:/, '');
}

async function redisCommand(command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('광고 유입 저장소 환경변수가 없습니다.');

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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: '지원하지 않는 요청입니다.' });
  }

  const body = req.body || {};
  const adId = clean(body.adId, 120);
  const adGroup = clean(body.adGroup, 120);
  const keywordId = clean(body.keywordId, 120);
  const campaignType = clean(body.campaignType, 30);
  const utmSource = clean(body.utmSource, 40).toLowerCase();
  const utmMedium = clean(body.utmMedium, 40).toLowerCase();
  const nativeAdTag = Boolean(adId || adGroup || keywordId || campaignType);
  const taggedNaverAd = utmSource === 'naver' && ['cpc', 'paid', 'powerlink'].includes(utmMedium);

  if (!nativeAdTag && !taggedNaverAd) {
    return res.status(204).end();
  }

  const ip = clientIp(req);
  const userAgent = clean(req.headers['user-agent'], 300);
  if (!ip || /bot|crawler|spider|slurp|preview/i.test(userAgent)) {
    return res.status(204).end();
  }

  const ipHash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);
  const fingerprint = crypto.createHash('sha256')
    .update([ipHash, adId, adGroup, keywordId, clean(body.keyword, 100)].join('|'))
    .digest('hex').slice(0, 32);

  try {
    const dailyKey = `sokcho:visit-limit:${ipHash}:${new Date().toISOString().slice(0, 10)}`;
    const dailyCount = Number(await redisCommand(['INCR', dailyKey]) || 1);
    if (dailyCount === 1) await redisCommand(['EXPIRE', dailyKey, '86400']);
    if (dailyCount > MAX_VISITS_PER_DAY) return res.status(204).end();

    const dedupe = await redisCommand(['SET', `sokcho:visit-dedupe:${fingerprint}`, '1', 'EX', String(DEDUPE_SECONDS), 'NX']);
    if (!dedupe) return res.status(204).end();

    const now = new Date();
    const id = crypto.randomUUID();
    const event = {
      id,
      visitedAt: now.toISOString(),
      ip,
      keyword: clean(body.keyword || body.query, 100) || '-',
      query: clean(body.query, 100) || '-',
      rank: clean(body.rank, 20) || '-',
      adId: adId || '-',
      adGroup: adGroup || '-',
      device: /mobile|android|iphone|ipad/i.test(userAgent) ? '모바일' : 'PC',
      source: nativeAdTag ? '네이버 광고' : '네이버 CPC',
      landing: clean(body.landing, 300) || '-'
    };

    await redisCommand(['SET', `sokcho:visit:${id}`, JSON.stringify(event), 'EX', String(RETENTION_SECONDS)]);
    await redisCommand(['ZADD', 'sokcho:visits', String(now.getTime()), id]);
    await redisCommand(['ZREMRANGEBYSCORE', 'sokcho:visits', '-inf', String(now.getTime() - RETENTION_SECONDS * 1000)]);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Ad visit save failed', err && err.message ? err.message : err);
    return res.status(204).end();
  }
};
