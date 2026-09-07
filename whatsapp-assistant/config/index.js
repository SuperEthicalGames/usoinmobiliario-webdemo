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

  // Duración del HOLD — debe coincidir EXACTAMENTE con HOLD_DURATION_MS de index.html y
  // DateUtil.HoldDurationMs de Unity. Un solo negocio, una sola regla, en tres lugares.
  holdDurationMs: 15 * 60 * 1000,

  // Tiempo de inactividad antes de olvidar el contexto de una conversación (sección 23 del
  // pedido: "expiración/limpieza para evitar memoria infinita").
  conversationTtlMs: 30 * 60 * 1000,
};

if (!config.firebase.serviceAccountJson && !config.firebase.serviceAccountPath) {
  throw new Error(
    'Debes definir FIREBASE_SERVICE_ACCOUNT_JSON o FIREBASE_SERVICE_ACCOUNT_PATH (ver .env.example)'
  );
}

if (config.llm.provider === 'openai' && !config.openai.apiKey) {
  throw new Error('LLM_PROVIDER=openai pero falta OPENAI_API_KEY (ver .env.example)');
}
if (config.llm.provider !== 'openai' && !config.gemini.apiKey) {
  throw new Error('Falta GEMINI_API_KEY (o define LLM_PROVIDER=openai con OPENAI_API_KEY, ver .env.example)');
}

module.exports = config;
