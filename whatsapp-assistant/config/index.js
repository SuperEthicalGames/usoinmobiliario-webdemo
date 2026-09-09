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

  // Correo transaccional real, $0 — SMTP de Gmail con la cuenta real del negocio + una
  // "contraseña de aplicación" (requiere verificación en dos pasos activada en esa cuenta de
  // Gmail; Google > Cuenta > Seguridad > Contraseñas de aplicaciones). No es la contraseña
  // normal de la cuenta — nunca usar esa.
  email: {
    gmailUser: optional('GMAIL_USER', 'usoinmobiliario@gmail.com'),
    gmailAppPassword: optional('GMAIL_APP_PASSWORD', ''),
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
