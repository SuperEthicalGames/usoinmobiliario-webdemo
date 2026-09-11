const crypto = require('crypto');
const config = require('../config');
const { normalizeMarkup } = require('./markup');

// Único lugar que habla con WhatsApp Cloud API (sección 25 del pedido) — verificación del
// webhook, parseo de mensajes entrantes, envío de respuestas. Nada de lógica de negocio ni de
// IA vive acá.

const GRAPH_BASE = `https://graph.facebook.com/${config.whatsapp.apiVersion}`;

// GET /webhook/whatsapp — Meta llama esto una vez al configurar el webhook, con el token que
// tú mismo definiste en WHATSAPP_VERIFY_TOKEN. Si coincide, hay que devolver `hub.challenge`
// tal cual, sin envolver en JSON.
function verifyWebhook(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    return challenge;
  }
  return null;
}

// Confirma que un POST al webhook realmente viene de Meta — hallazgo de severidad alta de
// AUDITORIA_COMPLETA.md: sin esto, cualquiera que encuentre la URL puede mandar un payload
// fabricado y el bot lo procesa como si fuera un cliente real (gasto de cuota de IA, HOLDs
// falsos, mensajes salientes a un número elegido por el atacante usando el WhatsApp real del
// negocio). Meta firma el body crudo con HMAC-SHA256 usando el "App Secret" (Meta for
// Developers > tu app > Configuración > Básica — un tercer valor, distinto de
// WHATSAPP_TOKEN/WHATSAPP_VERIFY_TOKEN) — hay que comparar contra el body SIN parsear (ver
// app.js: express.json({verify}) captura esos bytes crudos antes de convertirlos a objeto,
// porque JSON.stringify(req.body) no siempre reproduce byte a byte lo que Meta mandó).
let warnedNotConfigured = false;
function verifySignature(rawBody, signatureHeader) {
  if (!config.whatsapp.appSecret) {
    // FAIL CLOSED en producción: aceptar tráfico sin firma ("warn and accept") es exactamente
    // el patrón que SECURITY_AUDIT.md marca como inaceptable para un webhook público — sin
    // esto, cualquiera que encuentre la URL puede inyectar mensajes falsos (gasto de cuota de
    // IA, HOLDs falsos, mensajes salientes a un tercero con el WhatsApp real del negocio).
    // Fuera de producción (desarrollo local sin secretos de Meta a mano) sí se permite seguir
    // probando el bot sin firma, con una advertencia clara en logs.
    if (config.isProduction) {
      console.error('[whatsapp] WHATSAPP_APP_SECRET no configurado en producción (NODE_ENV=production) — rechazando TODO el tráfico del webhook hasta configurarlo. Ver DEPLOYMENT.md: Meta for Developers > tu app > Configuración > Básica > "App Secret", luego agrégalo como variable de entorno en Render.');
      return false;
    }
    if (!warnedNotConfigured) {
      console.warn('[whatsapp] WHATSAPP_APP_SECRET no configurado — la firma del webhook NO se está verificando (permitido solo fuera de producción). NUNCA despliegues así a producción.');
      warnedNotConfigured = true;
    }
    return true;
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expectedHex = crypto.createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest('hex');
  const providedHex = signatureHeader.slice(7);
  if (expectedHex.length !== providedHex.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(providedHex, 'hex'));
  } catch {
    return false;
  }
}

// Extrae el primer mensaje de texto entrante del payload del webhook, o null si el evento no
// es un mensaje de texto de un cliente (puede ser un status de entrega, una imagen, etc. — se
// ignoran silenciosamente por ahora, no es un error).
function parseIncomingMessage(body) {
  try {
    const entry = body.entry && body.entry[0];
    const change = entry && entry.changes && entry.changes[0];
    const value = change && change.value;
    const message = value && value.messages && value.messages[0];
    if (!message) return null;
    if (message.type !== 'text') return null;
    return {
      from: message.from, // número del cliente, formato WhatsApp (sin '+', ej. "573001234567")
      text: message.text.body,
      messageId: message.id,
    };
  } catch {
    return null;
  }
}

// La normalización de marcado (negrilla/cursiva/tachado, balance de símbolos) vive en
// markup.js — WhatsApp NO renderiza Markdown estilo GitHub (**negrilla** sale literal en
// pantalla, confirmado en vivo 2026-09-07), pero el problema de fondo es del MODELO, no de
// este canal, así que la protección es compartida, no una copia local.

async function sendTextMessage(to, rawText) {
  const text = normalizeMarkup(rawText);
  const url = `${GRAPH_BASE}/${config.whatsapp.phoneNumberId}/messages`;

  // Sin timeout, un fetch() colgado bloquearía el envío para siempre (mismo problema real
  // encontrado y corregido en aiAgent.js/callGemini durante las pruebas de esta sesión).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let res, body;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsapp.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text, preview_url: false },
      }),
      signal: controller.signal,
    });
    // La lectura del body va DENTRO del try, protegida por el mismo AbortController — ver
    // geminiProvider.js para el porqué (un fetch() puede resolver y aun así colgarse leyendo
    // un body que nunca termina de llegar).
    body = res.ok ? await res.json() : await res.text().catch(() => '');
  } catch (err) {
    throw err.name === 'AbortError' ? new Error('WhatsApp send timeout tras 15000ms') : err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`WhatsApp send failed (${res.status}): ${body}`);
  }
  return body;
}

module.exports = { verifyWebhook, verifySignature, parseIncomingMessage, sendTextMessage };
