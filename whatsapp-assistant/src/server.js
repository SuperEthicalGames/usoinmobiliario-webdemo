const express = require('express');
const config = require('../config');
const firebase = require('./firebase');
const whatsapp = require('./whatsapp');
const aiAgent = require('./aiAgent');
const conversationStore = require('./conversationStore');

firebase.init();
conversationStore.startCleanupLoop();

const app = express();
app.use(express.json());

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

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(config.port, () => {
  console.log(`[server] Asistente de Uso Inmobiliario escuchando en puerto ${config.port}`);
});
