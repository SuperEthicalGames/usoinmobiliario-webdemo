const express = require('express');
const rateLimit = require('express-rate-limit');
const firebase = require('./firebase');
const whatsapp = require('./whatsapp');
const aiAgent = require('./aiAgent');
const conversationStore = require('./conversationStore');
const emailService = require('./emailService');
const reservationBuilder = require('./reservationBuilder');
const validators = require('./validators');
const dateUtil = require('./dateUtil');
const { normalizeMarkup } = require('./markup');
const { requireAdminAuth, attachRole } = require('./adminAuth');
const adminRoutes = require('./adminRoutes');
const config = require('../config');

// La app de Express en sí, sin app.listen() — separada de server.js para poder reusarla tal
// cual tanto en local (server.js la arranca con app.listen) como en Cloud Functions (Firebase
// la envuelve con onRequest() y maneja el puerto/ciclo de vida por su cuenta).
firebase.init();
conversationStore.startCleanupLoop();
// Ver el hallazgo crítico del plan de migración de reservas: una vez que el sitio público deje
// de escribir directo a Firebase, este barrido pasa a ser la ÚNICA forma de liberar un HOLD
// vencido (antes era un efecto secundario de que alguien, quien sea, chequeara disponibilidad
// para esa unidad exacta). Arrancado siempre, no solo cuando las Rules ya estén cerradas —
// reclamar un HOLD vencido nunca es incorrecto, con o sin las Rules viejas todavía activas.
firebase.startHoldSweepLoop();

const app = express();
// Render (como cualquier PaaS) pone la app detrás de su propio proxy/load balancer — sin
// decirle a Express que confíe en ESE primer salto, req.ip devuelve la IP del proxy, la MISMA
// para todas las visitas reales, en vez de la del visitante (que sí llega en X-Forwarded-For).
// Bug real encontrado en auditoría: chatLimiter (abajo) usa req.ip por defecto para el límite
// de 30 peticiones/10min — sin esto, ese límite terminaba compartido por TODO el sitio en vez
// de ser por visitante, y un puñado de usuarios concurrentes bastaba para que /chat/web/message
// le devolviera 429 a cualquiera, la denegación de servicio que el rate limit debía evitar.
app.set('trust proxy', 1);
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
const LOCALHOST_ORIGIN = /^http:\/\/localhost:\d+$/;
// Además de SITE_ORIGIN (producción), acepta cualquier http://localhost:<puerto> — mismo
// criterio ya usado por allowAdminOrigin (abajo) para exactamente el mismo problema: probar el
// sitio público en local (`python -m http.server`, o cualquier dev server) contra el backend
// real no tenía forma de funcionar, cada escritura fallaba con el preflight rechazado (bug real
// encontrado en vivo probando el flujo completo de reservas/pagos). Esto NO relaja ningún
// control de acceso real — estas rutas ya eran alcanzables por cualquier script/curl sin pasar
// por un navegador ni por CORS (ver comentario de allowAdminOrigin); CORS solo decide qué
// respuesta puede LEER un navegador, nunca la única barrera.
function allowSiteOrigin(req, res, next) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', LOCALHOST_ORIGIN.test(origin || '') ? origin : SITE_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  // Idempotency-Key: nuevo, para /reservations y /visits (ver plan de migración de reservas) —
  // sin sumarlo acá, un navegador real bloquea el preflight de cualquier request que la incluya.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// CORS separado para /admin/api/* — origen DISTINTO (el panel de administración,
// usoinmobiliario-middleware), nunca el mismo que el sitio público. Necesita el header
// Authorization (token de Firebase), a diferencia de allowSiteOrigin.
//
// Además de config.adminOrigin (producción), se acepta cualquier http://localhost:<puerto> —
// el panel corriendo con `npm run dev` no tenía forma de hablar con el backend real, ni
// siquiera para pruebas manuales (bug real: se vio en vivo, cada llamada admin fallaba con
// "Response to preflight request doesn't pass access control check"). Esto NO relaja el
// control de acceso real: requireAdminAuth (abajo, antes de adminRoutes) sigue exigiendo un
// token válido de Firebase sin importar el origen — CORS es solo qué respuestas puede LEER un
// navegador, nunca la única barrera (mismo criterio ya documentado arriba para allowSiteOrigin).
function allowAdminOrigin(req, res, next) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', LOCALHOST_ORIGIN.test(origin || '') ? origin : config.adminOrigin);
  res.setHeader('Vary', 'Origin');
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

// Correo de "pago reportado" — llamado por index.html justo después de que reportPayment()
// guarda el pago en Firebase (mountPaymentSection), mismo patrón fire-and-forget que el correo
// de confirmación de arriba: nunca bloquea la respuesta de éxito que ya ve el cliente.
app.options('/email/payment-reported', allowSiteOrigin);
app.post('/email/payment-reported', allowSiteOrigin, async (req, res) => {
  try {
    const { code, email, lang } = req.body || {};
    const result = await emailService.sendPaymentReported({ code, email, lang });
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = EMAIL_ERROR_STATUS[err.code] || 500;
    if (status === 500) console.error('[app] Error enviando correo de pago reportado:', err);
    res.status(status).json({ error: err.code || 'unknown-error' });
  }
});

// "Información de visita" (sección 37 del pedido) — el único correo transaccional que nunca se
// construyó hasta ahora: agendar una cita no mandaba ningún correo. Mismo patrón exacto que
// reservation-confirmation, solo que valida type==='cita' en vez de 'reserva'.
app.options('/email/visit-confirmation', allowSiteOrigin);
app.post('/email/visit-confirmation', allowSiteOrigin, async (req, res) => {
  try {
    const { code, email, lang } = req.body || {};
    const result = await emailService.sendVisitConfirmation({ code, email, lang });
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = EMAIL_ERROR_STATUS[err.code] || 500;
    if (status === 500) console.error('[app] Error enviando correo de confirmación de cita:', err);
    res.status(status).json({ error: err.code || 'unknown-error' });
  }
});

// Reservas/citas/pagos del sitio público — antes escritas directo a Firebase desde el
// navegador (Rules como única barrera); ahora el backend es dueño de la escritura para TODOS
// los canales, no solo WhatsApp/chat (ver plan de migración de reservas). reservationBuilder
// hace el mismo validar->resolver->tope->disponibilidad->precio->armar registro que ya usan
// businessTools.js/adminRoutes.js — un tercer lugar reinventándolo habría sido exactamente el
// tipo de duplicación que ya causó un bug real (el tope de huéspedes) una vez.
//
// Respuesta de éxito: el registro COMPLETO (no el subconjunto angosto que devuelve el bot) —
// index.html espera exactamente lo que FirebaseDataProvider.createReservation devolvía antes
// (el mismo `rec` que se acababa de escribir), para poder seguir renderizando el paso 4, la
// tarjeta descargable, etc. sin ningún cambio en esos call sites.
const RESERVATION_ERROR_STATUS = { invalid: 400, 'not-found': 404 };
function reservationErrorStatus(err) {
  return RESERVATION_ERROR_STATUS[err.code] || (err.code === 'conflict' ? 409 : 500);
}
function sendReservationError(req, res, err) {
  const status = reservationErrorStatus(err);
  if (status === 500) console.error(`[app] ${req.method} ${req.originalUrl}:`, err);
  res.status(status).json({ error: err.code || 'internal-error', ...(err.missingFields ? { missingFields: err.missingFields } : {}) });
}

// Mismo orden de magnitud que chatLimiter (escrituras reales, no solo lectura) — una sesión de
// reserva normal manda como mucho un puñado de intentos (colisión de código, reintento tras un
// error de red), nunca decenas.
const reservationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate-limited' },
});

// Idempotency-Key (sección 25 del pedido, antes fuera de alcance para el sitio público — ver
// AUDITORIA_EXTERNA_2026_09.md §5): TODO el trabajo va dentro de withIdempotency, no solo la
// escritura final — mismo motivo exacto que en adminRoutes.js's POST /reservations (un reintento
// de una solicitud ya exitosa no debe rechequear disponibilidad contra sus propias noches recién
// reclamadas). Esta ruta NO manda el correo de confirmación — a diferencia del bot (que no tiene
// ningún cliente JS propio orquestando un segundo paso), index.html ya hace esa llamada aparte a
// /email/reservation-confirmation justo después de que esto responde (ver sendReservationEmail
// en index.html); mandarlo también acá lo duplicaría.
app.options('/reservations', allowSiteOrigin);
app.post('/reservations', allowSiteOrigin, reservationLimiter, async (req, res) => {
  try {
    const created = await firebase.withIdempotency(req.headers['idempotency-key'], async () => {
      const rec = await reservationBuilder.buildReservationRecord(req.body || {});
      return firebase.createReservation(rec);
    });
    res.status(201).json(created);
  } catch (err) {
    sendReservationError(req, res, err);
  }
});

app.options('/visits', allowSiteOrigin);
app.post('/visits', allowSiteOrigin, reservationLimiter, async (req, res) => {
  try {
    const created = await firebase.withIdempotency(req.headers['idempotency-key'], async () => {
      const { rec, isGeneral } = await reservationBuilder.buildVisitRecord(req.body || {});
      return isGeneral ? firebase.createGeneralVisit(rec) : firebase.createSpecificVisit(rec);
    });
    res.status(201).json(created);
  } catch (err) {
    sendReservationError(req, res, err);
  }
});

// Conteo de tráfico del sitio público (sección "público visitado" del panel de analíticas) —
// público y sin requireAdminAuth a propósito, igual que /chat/web/message: el navegador de un
// visitante nunca tiene ni puede tener un token de admin. Guarda SOLO un contador agregado por
// día y por página (ver firebase.js:recordPageview) — nada de cookies, IP ni fingerprint, así
// que un rate limit generoso (una sesión de navegación normal manda pocas decenas de pageviews,
// nunca cientos) alcanza para frenar un script abusando del endpoint sin bloquear tráfico real.
const trafficLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate-limited' },
});

// Elegir método de pago / reportar un pago — mismo criterio de "el código ES la credencial"
// que ya regía database.rules.json (una reserva se identifica por su código de 3 letras+3
// dígitos, sin enumeración posible; quien lo tiene, la controla — decisión ya tomada y
// documentada en SECURITY.md, no reabierta acá). trafficLimiter (no reservationLimiter): esto
// nunca crea nada nuevo, mismo costo/riesgo que un pageview.
app.options('/reservations/:code/payment-method', allowSiteOrigin);
app.post('/reservations/:code/payment-method', allowSiteOrigin, trafficLimiter, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    const { method } = req.body || {};
    if (!validators.isValidCodeFormat(code)) return res.status(400).json({ error: 'invalid' });
    if (method !== 'bank_transfer' && method !== 'cash') return res.status(400).json({ error: 'invalid' });
    const updated = await firebase.setPaymentMethod(code, method);
    res.json(updated);
  } catch (err) {
    sendReservationError(req, res, err);
  }
});

// El cliente reporta haber pagado — SOLO 'submitted', nunca 'verified' (regla crítica ya
// establecida, ver firebase.js:reportPayment). Valida acá lo que antes validaba
// database.rules.json's .validate sobre paymentReport (Admin SDK se lo salta, ver plan de
// migración): monto/referencia/banco no-placeholder (validators.missingPaymentReportFields, ya
// existe y ya lo usa el bot — reusarlo acá es lo que cierra el hueco de "el sitio público nunca
// pasaba por este chequeo"), fecha con formato real, proofUrl https-only si viene. Tampoco manda
// el correo de "pago reportado" acá — index.html ya llama aparte a /email/payment-reported justo
// después de que esto responde (mismo motivo que en POST /reservations, arriba).
function isSafeProofUrl(url) {
  if (url == null || url === '') return true;
  return typeof url === 'string' && url.length < 2000 && /^https:\/\//.test(url);
}
app.options('/reservations/:code/payment-report', allowSiteOrigin);
app.post('/reservations/:code/payment-report', allowSiteOrigin, trafficLimiter, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!validators.isValidCodeFormat(code)) return res.status(400).json({ error: 'invalid' });
    const { amount, reference, bank, date, proofUrl } = req.body || {};
    const missing = validators.missingPaymentReportFields({ amount, reference, bank });
    if (!dateUtil.isValidIsoDate(date)) missing.push('fecha');
    if (!isSafeProofUrl(proofUrl)) missing.push('comprobante (URL inválida)');
    if (missing.length > 0) return res.status(400).json({ error: 'invalid', missingFields: missing });

    const report = {
      amount: Number(amount),
      reference: String(reference).trim(),
      bank: String(bank).trim(),
      date,
      reportedAt: new Date().toISOString(),
    };
    if (proofUrl) report.proofUrl = String(proofUrl).trim();

    const updated = await firebase.reportPayment(code, report);
    res.json(updated);
  } catch (err) {
    sendReservationError(req, res, err);
  }
});

app.options('/track/pageview', allowSiteOrigin);
app.post('/track/pageview', allowSiteOrigin, trafficLimiter, async (req, res) => {
  const { path } = req.body || {};
  if (path != null && typeof path !== 'string') return res.status(400).json({ error: 'invalid-path' });
  try {
    await firebase.recordPageview(path);
    res.json({ ok: true });
  } catch (err) {
    console.error('[app] Error registrando pageview:', err);
    res.status(500).json({ error: 'internal-error' });
  }
});

// Traza real de fallos de conectividad del sitio público (ej. reserva/pago que no pudo
// confirmar que llegó a Firebase antes de escribir — ver index.html:
// window.__uso_assertConnected). `kind` es un enum fijo, nunca texto libre del cliente —
// mismo motivo que sanitizeTrafficPath en pageview, pero acá directamente se rechaza cualquier
// valor fuera de la lista en vez de sanitizarlo.
const CLIENT_ERROR_KINDS = new Set([
  'reservation-not-connected',
  'payment-method-not-connected',
  'payment-report-not-connected',
]);
app.options('/track/client-error', allowSiteOrigin);
app.post('/track/client-error', allowSiteOrigin, trafficLimiter, async (req, res) => {
  const { kind } = req.body || {};
  if (typeof kind !== 'string' || !CLIENT_ERROR_KINDS.has(kind)) return res.status(400).json({ error: 'invalid-kind' });
  try {
    await firebase.recordClientError(kind);
    res.json({ ok: true });
  } catch (err) {
    console.error('[app] Error registrando client-error:', err);
    res.status(500).json({ error: 'internal-error' });
  }
});

// Panel de administración (usoinmobiliario-middleware) — todo bajo /admin/api/* pasa por CORS
// del origen del panel (nunca el del sitio público) y por requireAdminAuth (token real de
// Firebase Auth, verificado server-side). El preflight OPTIONS se registra ANTES y sin
// requireAdminAuth — un preflight real de navegador no manda el header Authorization todavía
// (mismo bug de preflight ya encontrado y corregido en /email/reservation-confirmation, acá
// aplicado a todo el prefijo con un comodín en vez de ruta por ruta).
//
// Rate limit generoso (defensa en profundidad, no la barrera principal — esa es
// requireAdminAuth): sin esto, cualquiera que descubra esta URL podía mandar bearer tokens
// inventados sin límite, cada uno forzando una llamada de red real a
// admin.auth().verifyIdToken() (costo/latencia real, no gratis) antes de ser rechazado con
// 401. El panel real hace, como mucho, unas pocas decenas de llamadas por minuto en el uso
// normal de un solo admin — 200/5min deja margen de sobra sin abrir la puerta a un abuso
// ilimitado del endpoint más sensible del backend.
const adminLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate-limited' },
});
app.options('/admin/api/*', allowAdminOrigin);
app.use('/admin/api', allowAdminOrigin, adminLimiter, requireAdminAuth, attachRole, adminRoutes);

// Sin CORS, un `fetch()` desde el navegador del sitio público a esta ruta se bloquea en
// silencio (bug real encontrado en vivo: window.__uso_assertConnected empezó a usar esto para
// confirmar que el backend responde antes de dejar reservar — sin este header, CADA reserva
// real habría fallado con "no pudimos confirmar la conexión", nunca solo un caso raro). No hay
// nada sensible en la respuesta — un origen abierto es correcto para un healthcheck público.
app.get('/health', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ ok: true });
});

module.exports = app;
