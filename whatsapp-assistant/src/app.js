const express = require('express');
const rateLimit = require('express-rate-limit');
const firebase = require('./firebase');
const whatsapp = require('./whatsapp');
const aiAgent = require('./aiAgent');
const conversationStore = require('./conversationStore');
const emailService = require('./emailService');
const { normalizeMarkup } = require('./markup');
const { requireAdminAuth } = require('./adminAuth');
const adminRoutes = require('./adminRoutes');
const config = require('../config');

// La app de Express en sí, sin app.listen() — separada de server.js para poder reusarla tal
// cual tanto en local (server.js la arranca con app.listen) como en Cloud Functions (Firebase
// la envuelve con onRequest() y maneja el puerto/ciclo de vida por su cuenta).
firebase.init();
conversationStore.startCleanupLoop();

const app = express();
// Captura el body crudo (bytes exactos) además de parsearlo — necesario para verificar la
// firma HMAC de Meta (whatsapp.verifySignature), que debe calcularse sobre el body TAL CUAL
// llegó, no sobre JSON.stringify(req.body) (el reserializado no siempre coincide byte a byte).
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// CORS mínimo, un solo origen permitido (el sitio público) — nada de la librería `cors` para
// esto, mismo criterio de "sin dependencias de más" que ya usaba email-worker/src/index.js
// para exactamente este caso (un solo origen conocido). Reusado por /email/* y /chat/web/*
// (esta última todavía no existe) — /admin/api/* usa su PROPIO origen permitido, nunca este.
//
// El header Origin que manda un navegador real es SOLO esquema+host(+puerto) — NUNCA incluye
// path (confirmado probando el preflight real: siteBaseUrl trae "/usoinmobiliario-webdemo" al
// final porque así arma los links a cada apartamento, pero comparar contra eso literal habría
// hecho que un navegador real rechazara esta respuesta por no calzar con su Origin real).
const SITE_ORIGIN = new URL(config.siteBaseUrl).origin;
function allowSiteOrigin(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', SITE_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// CORS separado para /admin/api/* — origen DISTINTO (el panel de administración,
// usoinmobiliario-middleware), nunca el mismo que el sitio público. Necesita el header
// Authorization (token de Firebase), a diferencia de allowSiteOrigin.
function allowAdminOrigin(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', config.adminOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// GET — verificación única del webhook por parte de Meta (sección 25).
app.get('/webhook/whatsapp', (req, res) => {
  const challenge = whatsapp.verifyWebhook(req.query);
  if (challenge !== null) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// POST — mensajes entrantes. Se responde 200 de inmediato (Meta reintenta si no hay
// respuesta rápida) y el mensaje se procesa después, sin bloquear el webhook.
app.post('/webhook/whatsapp', (req, res) => {
  if (!whatsapp.verifySignature(req.rawBody, req.headers['x-hub-signature-256'])) {
    console.warn('[server] Webhook rechazado: firma inválida (posible tráfico falsificado).');
    return res.sendStatus(403);
  }
  res.sendStatus(200);

  const incoming = whatsapp.parseIncomingMessage(req.body);
  if (!incoming) return; // no era un mensaje de texto de un cliente (status, imagen, etc.)

  conversationStore.runSerialized(incoming.from, () => processMessage(incoming)).catch((err) => {
    console.error('[server] Error procesando mensaje entrante:', err);
  });
});

async function processMessage({ from, text }) {
  let reply;
  try {
    reply = await aiAgent.handleIncomingMessage(from, text);
  } catch (err) {
    console.error('[server] Error del asistente IA:', err);
    reply = 'En este momento estoy teniendo dificultades técnicas. Dame un momento o comunícate directamente con nosotros.';
  }
  try {
    await whatsapp.sendTextMessage(from, reply);
  } catch (err) {
    console.error('[server] Error enviando respuesta por WhatsApp:', err);
  }
}

// Chat web (index.html) — mismo cerebro que WhatsApp (aiAgent.handleIncomingMessage), canal
// distinto. A diferencia del webhook de WhatsApp, este endpoint es público y alcanzable
// directo por cualquiera (CORS es un control de navegador, no protege contra un script/curl
// pegándole a la URL de Render sin pasar por un navegador) y puede disparar llamadas medidas a
// la IA y escrituras reales en Firebase — de ahí el rate limit real por IP, algo que el webhook
// de WhatsApp no necesita porque Meta ya pone esa fricción de su lado.
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate-limited' },
});
app.options('/chat/web/message', allowSiteOrigin);
app.post('/chat/web/message', allowSiteOrigin, chatLimiter, async (req, res) => {
  const { sessionId, text } = req.body || {};
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200) {
    return res.status(400).json({ error: 'invalid-session' });
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) {
    return res.status(400).json({ error: 'invalid-text' });
  }
  // Namespacing acá, no dentro de conversationStore/aiAgent — esas capas siguen tratando la
  // clave como un string opaco, sin saber ni importarles que existan varios canales (ver
  // handleIncomingMessage en geminiProvider.js/openaiProvider.js).
  const conversationKey = `web:${sessionId.trim()}`;
  try {
    const reply = await conversationStore.runSerialized(conversationKey, () => aiAgent.handleIncomingMessage(conversationKey, text.trim(), 'web'));
    res.json({ reply: normalizeMarkup(reply) });
  } catch (err) {
    console.error('[app] Error procesando mensaje del chat web:', err);
    res.status(500).json({ error: 'internal-error' });
  }
});

// Correo de confirmación de reserva — llamado por index.html tanto al crear una reserva como
// al reenviar desde "Mi reserva" (ese flujo ya exige escribir el correo de vuelta; este
// endpoint reusa esa misma verificación del lado del servidor para ambos casos, ver
// emailService.js). Reemplaza la llamada que antes iba al Worker de Cloudflare.
const EMAIL_ERROR_STATUS = {
  invalid: 400, 'not-configured': 503, 'rate-limited': 429, 'not-found': 404, forbidden: 403,
};
// Preflight explícito: sin esto, Express responde el OPTIONS automáticamente por su cuenta
// ANTES de llegar a allowSiteOrigin (solo listando "Allow: POST", sin ningún header de CORS)
// — un navegador real interpreta eso como preflight fallido y NUNCA llega a mandar el POST.
// Encontrado probando en vivo, no asumido.
app.options('/email/reservation-confirmation', allowSiteOrigin);
app.post('/email/reservation-confirmation', allowSiteOrigin, async (req, res) => {
  try {
    const { code, email, lang } = req.body || {};
    const result = await emailService.sendReservationConfirmation({ code, email, lang });
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = EMAIL_ERROR_STATUS[err.code] || 500;
    if (status === 500) console.error('[app] Error enviando correo de confirmación:', err);
    res.status(status).json({ error: err.code || 'unknown-error' });
  }
});

// Panel de administración (usoinmobiliario-middleware) — todo bajo /admin/api/* pasa por CORS
// del origen del panel (nunca el del sitio público) y por requireAdminAuth (token real de
// Firebase Auth, verificado server-side). El preflight OPTIONS se registra ANTES y sin
// requireAdminAuth — un preflight real de navegador no manda el header Authorization todavía
// (mismo bug de preflight ya encontrado y corregido en /email/reservation-confirmation, acá
// aplicado a todo el prefijo con un comodín en vez de ruta por ruta).
app.options('/admin/api/*', allowAdminOrigin);
app.use('/admin/api', allowAdminOrigin, requireAdminAuth, adminRoutes);

app.get('/health', (_req, res) => res.json({ ok: true }));

module.exports = app;
