const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

// Punto de entrada que usa Firebase al desplegar (`firebase deploy --only functions`) — NO se
// usa en desarrollo local, ahí sigue sirviendo src/server.js. Los secretos reales (nunca en
// .env aquí) se cargan de Secret Manager con `firebase functions:secrets:set NOMBRE` y se
// inyectan como variables de entorno normales justo antes de que corra el código de abajo —
// config/index.js los lee exactamente igual que en local, sin saber que vienen de otro lado.
const WHATSAPP_TOKEN = defineSecret('WHATSAPP_TOKEN');
const WHATSAPP_VERIFY_TOKEN = defineSecret('WHATSAPP_VERIFY_TOKEN');
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

// src/app.js (vía config/index.js) exige que los secretos ya existan en process.env apenas se
// hace el require() — pero en la fase de "discovery" con la que Firebase detecta qué secretos
// declara esta función, todavía NO están inyectados (por eso se declaran arriba, para que
// Firebase sepa cuáles pedir). Cargar la app perezosamente, solo en la primera petición real
// (no al cargar este archivo), evita que esa fase de discovery reviente por falta de secretos.
let app;
function handler(req, res) {
  if (!app) app = require('./src/app');
  return app(req, res);
}

exports.api = onRequest(
  {
    secrets: [WHATSAPP_TOKEN, WHATSAPP_VERIFY_TOKEN, GEMINI_API_KEY, OPENAI_API_KEY],
    region: 'us-central1',
  },
  handler
);
