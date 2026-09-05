import { AwsClient } from 'aws4fetch';

// Recibe { to_email, to_name, subject, message_html, reservation_code, app_secret } desde
// index.html (EmailProvider.send) y reenvía el correo real a través de Amazon SES v2,
// usando el dominio usoinmobiliario.com (ya verificado en esa cuenta AWS — mismo dominio
// que ya recibe correo entrante, ver el MX record real apuntando a inbound-smtp.<region>).
// Las credenciales de AWS viven SOLO como secrets de Cloudflare (nunca en este archivo,
// nunca en index.html) — este Worker es la única pieza que las conoce.

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function json(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) }
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'method-not-allowed' }, 405, env);
    }

    // Freno de abuso de baja fricción, no una barrera criptográfica real: el Origin de un
    // navegador real no se puede falsificar, pero un cliente no-navegador sí podría mandar
    // cualquier valor. La protección real contra abuso está en AWS (cuota de SES, costo
    // marginal ínfimo) y en Cloudflare (límite diario del plan gratuito) — esto solo evita
    // que un bot casual dispare envíos sin siquiera intentar imitar el sitio real.
    const origin = request.headers.get('Origin') || '';
    if (env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) {
      return json({ error: 'forbidden-origin' }, 403, env);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'bad-json' }, 400, env);
    }

    if (env.APP_SHARED_SECRET && body.app_secret !== env.APP_SHARED_SECRET) {
      return json({ error: 'forbidden' }, 403, env);
    }

    var to_email = body.to_email, to_name = body.to_name, subject = body.subject,
        message_html = body.message_html, reservation_code = body.reservation_code;

    if (!to_email || !subject || !message_html) {
      return json({ error: 'missing-fields' }, 400, env);
    }
    if (!EMAIL_RE.test(to_email)) {
      return json({ error: 'invalid-email' }, 400, env);
    }

    const aws = new AwsClient({
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.AWS_REGION,
      service: 'ses'
    });

    const fromHeader = env.SES_FROM_NAME
      ? env.SES_FROM_NAME + ' <' + env.SES_FROM_EMAIL + '>'
      : env.SES_FROM_EMAIL;

    const sesPayload = {
      FromEmailAddress: fromHeader,
      Destination: { ToAddresses: [to_email] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Html: { Data: message_html, Charset: 'UTF-8' } }
        }
      }
    };
    if (env.SES_REPLY_TO) sesPayload.ReplyToAddresses = [env.SES_REPLY_TO];

    let sesRes;
    try {
      sesRes = await aws.fetch('https://email.' + env.AWS_REGION + '.amazonaws.com/v2/email/outbound-emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sesPayload)
      });
    } catch (e) {
      console.error('[SES] request failed', e);
      return json({ error: 'ses-request-failed' }, 502, env);
    }

    if (!sesRes.ok) {
      const errText = await sesRes.text();
      console.error('[SES] send failed', sesRes.status, errText);
      return json({ error: 'ses-send-failed', status: sesRes.status }, 502, env);
    }

    const sesJson = await sesRes.json();
    return json({ ok: true, messageId: sesJson.MessageId, reservation_code: reservation_code }, 200, env);
  }
};
