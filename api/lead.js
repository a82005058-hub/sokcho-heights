const crypto = require('crypto');

function clean(value, max = 500) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
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
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Redis ${response.status}`);
  }
  return payload.result;
}

async function saveLead(lead) {
  await redisCommand(['SET', `sokcho:lead:${lead.id}`, JSON.stringify(lead)]);
  await redisCommand(['ZADD', 'sokcho:leads', String(Date.parse(lead.createdAt)), lead.id]);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST 요청만 가능합니다.' });
  }

  const body = req.body || {};
  const name = clean(body.name, 40);
  const phone = clean(body.phone, 30);
  const type = clean(body.type, 40);
  const message = clean(body.message, 700);

  if (!name || !phone) {
    return res.status(400).json({ error: '이름과 연락처를 입력해주세요.' });
  }

  const accessKey = process.env.NCP_ACCESS_KEY;
  const secretKey = process.env.NCP_SECRET_KEY;
  const serviceId = process.env.NCP_SENS_SERVICE_ID || 'ncp:sms:kr:377763776657:sokcho-heights';
  const sender = (process.env.NCP_SENS_SENDER || '01082005058').replace(/\D/g, '');
  const receiver = (process.env.LEAD_RECEIVER || '01082005058').replace(/\D/g, '');

  if (!accessKey || !secretKey || !serviceId || !sender || !receiver) {
    return res.status(500).json({ error: '문자 서비스 환경변수 설정이 필요합니다.' });
  }

  const lead = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    name,
    phone,
    type: type && type !== '관심 타입 선택' ? type : '-',
    message: message || '-',
    smsStatus: 'pending'
  };

  try {
    await saveLead(lead);
  } catch (err) {
    console.error('Lead save failed', err && err.message ? err.message : err);
    return res.status(500).json({ error: '상담신청 저장 중 오류가 발생했습니다.' });
  }

  const smsText = [
    '[속초중앙하이츠 상담신청]',
    `이름: ${name}`,
    `연락처: ${phone}`,
    `관심타입: ${type && type !== '관심 타입 선택' ? type : '-'}`,
    `문의/방문희망: ${message || '-'}`
  ].join('\n');

  const uri = `/sms/v2/services/${serviceId}/messages`;
  const timestamp = Date.now().toString();
  const signatureMessage = `POST ${uri}\n${timestamp}\n${accessKey}`;
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(signatureMessage)
    .digest('base64');

  const payload = {
    type: 'LMS',
    contentType: 'COMM',
    countryCode: '82',
    from: sender,
    subject: '속초중앙하이츠 상담신청',
    content: smsText,
    messages: [{ to: receiver }]
  };

  try {
    const response = await fetch(`https://sens.apigw.ntruss.com${uri}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ncp-apigw-timestamp': timestamp,
        'x-ncp-iam-access-key': accessKey,
        'x-ncp-apigw-signature-v2': signature
      },
      body: JSON.stringify(payload)
    });

    let result = {};
    try { result = await response.json(); } catch (_) {}

    if (!response.ok) {
      console.error('NCP SENS send failed', response.status, result);
      lead.smsStatus = 'failed';
      lead.updatedAt = new Date().toISOString();
      try { await saveLead(lead); } catch (saveError) {
        console.error('Lead status update failed', saveError && saveError.message ? saveError.message : saveError);
      }
      return res.status(502).json({
        error: '문자 발송에 실패했습니다. 발신번호 승인 및 Vercel 환경변수를 확인해주세요.'
      });
    }

    lead.smsStatus = 'sent';
    lead.smsRequestId = result.requestId || null;
    lead.updatedAt = new Date().toISOString();
    try { await saveLead(lead); } catch (saveError) {
      console.error('Lead status update failed', saveError && saveError.message ? saveError.message : saveError);
    }

    return res.status(200).json({ ok: true, requestId: result.requestId || null });
  } catch (err) {
    console.error('NCP SENS request error', err && err.message ? err.message : err);
    lead.smsStatus = 'failed';
    lead.updatedAt = new Date().toISOString();
    try { await saveLead(lead); } catch (saveError) {
      console.error('Lead status update failed', saveError && saveError.message ? saveError.message : saveError);
    }
    return res.status(500).json({ error: '문자 발송 중 오류가 발생했습니다.' });
  }
};
