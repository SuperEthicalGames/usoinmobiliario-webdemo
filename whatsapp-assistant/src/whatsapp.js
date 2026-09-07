const config = require('../config');

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

// Red de seguridad además de la instrucción en el prompt (assistantCore.js) — confirmado en
// vivo (2026-09-07, mensaje de diagnóstico real) que WhatsApp NO renderiza Markdown estilo
// GitHub: **negrilla**/__negrilla__ salen con los símbolos literales en pantalla, solo el
// marcado propio de WhatsApp (*negrilla*, _cursiva_, ~tachado~) funciona. El modelo puede
// olvidar la regla del prompt bajo presión (cadena larga de function calls, modelo más
// pequeño); esto lo corrige de todas formas justo antes de enviar, sin depender de que la IA
// nunca se equivoque.
// WhatsApp empareja los símbolos de marcado en orden a lo largo de TODO el mensaje — si queda
// una cantidad impar de un símbolo (por un asterisco de más, o una negrilla que el modelo dejó
// sin cerrar), no solo ese símbolo se ve literal: puede arrastrar y romper el emparejamiento de
// TODO lo que sigue en el mensaje. Más seguro quitar el símbolo por completo en ese caso que
// dejarlo mostrar roto.
function stripIfUnbalanced(text, marker) {
  const count = text.split(marker).length - 1;
  return count % 2 === 0 ? text : text.split(marker).join('');
}

function sanitizeForWhatsApp(text) {
  let out = text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1: $2');
  out = stripIfUnbalanced(out, '*');
  out = stripIfUnbalanced(out, '_');
  out = stripIfUnbalanced(out, '~');
  return out;
}

async function sendTextMessage(to, rawText) {
  const text = sanitizeForWhatsApp(rawText);
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

module.exports = { verifyWebhook, parseIncomingMessage, sendTextMessage };
