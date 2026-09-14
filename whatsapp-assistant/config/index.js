require('dotenv').config();

// Un solo lugar que lee process.env — si falta algo crítico, el servidor debe negarse a
// arrancar con un mensaje claro, en vez de fallar más tarde a medio webhook con un error
// críptico de Firebase/WhatsApp/Gemini.
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name} (ver .env.example)`);
  return value;
}

function optional(name, fallback) {
  return process.env[name] || fallback;
}

const config = {
  port: Number(optional('PORT', '3000')),

  // Distingue producción de desarrollo local para un puñado de controles que NUNCA deben
  // relajarse en producción (hoy: exigir la firma del webhook de WhatsApp, ver whatsapp.js) —
  // sección "cambios de producción importantes" de la auditoría de seguridad. Render no fija
  // NODE_ENV por su cuenta; se define explícitamente en render.yaml.
  isProduction: optional('NODE_ENV', 'development') === 'production',

  firebase: {
    databaseURL: required('FIREBASE_DATABASE_URL'),
    serviceAccountJson: optional('FIREBASE_SERVICE_ACCOUNT_JSON', ''),
    serviceAccountPath: optional('FIREBASE_SERVICE_ACCOUNT_PATH', ''),
  },

  whatsapp: {
    token: required('WHATSAPP_TOKEN'),
    phoneNumberId: required('WHATSAPP_PHONE_NUMBER_ID'),
    verifyToken: required('WHATSAPP_VERIFY_TOKEN'),
    apiVersion: optional('WHATSAPP_API_VERSION', 'v20.0'),
    // "App Secret" de Meta for Developers > tu app > Configuración > Básica (NO es
    // WHATSAPP_TOKEN ni WHATSAPP_VERIFY_TOKEN, es un tercer valor distinto) — firma cada
    // webhook entrante para confirmar que de verdad viene de Meta. OPCIONAL a propósito: el
    // bot ya está desplegado y funcionando sin esto (ver AUDITORIA_COMPLETA.md, hallazgo de
    // severidad alta) — exigirlo con required() habría roto el despliegue actual en Render en
    // el próximo deploy. Mientras no esté configurado, la verificación se salta con una
    // advertencia clara en los logs en vez de rechazar tráfico real de Meta.
    appSecret: optional('WHATSAPP_APP_SECRET', ''),
  },

  // 'gemini' (gratis, cuota limitada) u 'openai' (de pago, separado de cualquier suscripción
  // de ChatGPT — esa es para chat.openai.com, no para la API). Solo se exige la credencial del
  // proveedor realmente activo, para no forzar a tener las dos configuradas a la vez.
  llm: {
    provider: optional('LLM_PROVIDER', 'gemini'),
  },

  gemini: {
    apiKey: optional('GEMINI_API_KEY', ''),
    model: optional('GEMINI_MODEL', 'gemini-flash-lite-latest'),
  },

  openai: {
    apiKey: optional('OPENAI_API_KEY', ''),
    model: optional('OPENAI_MODEL', 'gpt-4o-mini'),
  },

  // Origen permitido para /admin/api/* — un panel de administración separado (repo
  // usoinmobiliario-middleware, React+Vite+TS), NUNCA el mismo origen que /chat/web/*
  // (config.siteBaseUrl) ni el mismo CORS. Valor por defecto asumiendo GitHub Pages para el
  // panel (mismo mecanismo ya probado y gratis del sitio principal) — cambiar por variable de
  // entorno si el panel termina en otro host.
  adminOrigin: optional('ADMIN_ORIGIN', 'https://superethicalgames.github.io'),

  // El único admin que puede crear/revocar OTROS admins (sección "sistema de registro solo
  // para el administrador principal" del pedido). No usa custom claims de Firebase (exigiría
  // un paso de bootstrap aparte) — con una sola cuenta "principal" ya conocida de antemano,
  // comparar el email del token verificado contra este valor es correcto y no hay que
  // sobre-diseñarlo. Cualquier admin nuevo que el principal cree NUNCA puede ser principal él
  // mismo (no hay forma de que su email coincida con este valor a menos que de verdad sea esta
  // cuenta), así que la restricción es real, no solo de UI.
  superAdminEmail: optional('SUPER_ADMIN_EMAIL', 'usoinmobiliario@gmail.com'),

  // Correo transaccional real, $0 — API HTTP de Resend (resend.com), no SMTP. SMTP de Gmail
  // directo desde este backend se abandonó el 2026-09-13: Render (como la mayoría de
  // plataformas cloud) bloquea o descarta en silencio las conexiones SMTP salientes desde IPs
  // de centro de datos — confirmado en vivo (ETIMEDOUT), no una suposición. Resend expone el
  // mismo envío por HTTPS (puerto 443, nunca bloqueado), capa gratis de sobra (3.000/mes).
  // RESEND_FROM: mientras no se verifique un dominio propio en Resend, la cuenta solo puede
  // usar su remitente de sandbox (onboarding@resend.dev) y solo puede mandar al correo con el
  // que te registraste ahí — suficiente para probar, real para producción solo tras verificar
  // un dominio propio (resend.com/domains).
  email: {
    resendApiKey: optional('RESEND_API_KEY', ''),
    resendFrom: optional('RESEND_FROM', 'Uso Inmobiliario <onboarding@resend.dev>'),
  },

  // Notificaciones push del sistema operativo (2026-09-14) — Web Push estándar (Push API +
  // Service Worker + VAPID), no un servicio de terceros: Chrome/Edge/Firefox lo entregan gratis
  // por su cuenta, mismo criterio de costo ya aplicado con Resend/Cloudinary. El par de llaves
  // se generó UNA vez con `npx web-push generate-vapid-keys` (determinístico, sin red ni
  // cuenta) — la pública viaja también en el bundle del middleware (no es secreta, mismo
  // criterio que el apiKey de Firebase); la privada es la única que de verdad debe protegerse.
  // vapidSubject es un contacto real exigido por el protocolo VAPID (para que un proveedor de
  // push pueda avisarle a alguien si el servidor abusa del servicio) — nunca se muestra al
  // usuario final.
  vapid: {
    publicKey: optional('VAPID_PUBLIC_KEY', 'BErcl8a1nCnM9htI2hq3Bt_yIpEuY0soWbDjxZDIuUTqT02NaATCTRweExI8J5fQFo2MJEpDOhgmcy7VYw1bFlY'),
    privateKey: optional('VAPID_PRIVATE_KEY', ''),
    subject: optional('VAPID_SUBJECT', 'mailto:usoinmobiliario@gmail.com'),
  },

  // URL pública donde vive el sitio (index.html, Firebase Hosting) — usada para armar el link
  // real de cada apartamento (misma ruta hash que ya existe en el sitio: #/unidad/:tipo?u=:num,
  // ver route() en index.html). Sin barra final.
  siteBaseUrl: optional('SITE_BASE_URL', 'https://superethicalgames.github.io/usoinmobiliario-webdemo'),

  // Duración del HOLD — debe coincidir EXACTAMENTE con HOLD_DURATION_MS de index.html y
  // DateUtil.HoldDurationMs de Unity. Un solo negocio, una sola regla, en tres lugares.
  holdDurationMs: 15 * 60 * 1000,

  // Tiempo de inactividad antes de olvidar el contexto de una conversación (sección 23 del
  // pedido: "expiración/limpieza para evitar memoria infinita").
  conversationTtlMs: 30 * 60 * 1000,
};

// FIREBASE_SERVICE_ACCOUNT_JSON/PATH ya NO es obligatorio: solo hace falta en local. Corriendo
// dentro de Cloud Functions/Cloud Run del mismo proyecto, firebase.js usa credenciales
// automáticas del entorno — no hay nada que definir acá (ver firebase.js:init()).

if (config.llm.provider === 'openai' && !config.openai.apiKey) {
  throw new Error('LLM_PROVIDER=openai pero falta OPENAI_API_KEY (ver .env.example)');
}
if (config.llm.provider !== 'openai' && !config.gemini.apiKey) {
  throw new Error('Falta GEMINI_API_KEY (o define LLM_PROVIDER=openai con OPENAI_API_KEY, ver .env.example)');
}

module.exports = config;
