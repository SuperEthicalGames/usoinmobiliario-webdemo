const config = require('../config');
const conversationStore = require('./conversationStore');
const { toolSchemas, executeFunctionCall, buildSystemInstruction } = require('./assistantCore');

// Habla con la API de Gemini vía REST directo (fetch), no con el paquete @google/generative-ai
// — verificado en vivo (2026-09-06) que ese paquete arma las respuestas de function calling con
// role:'function', que la API actual ya rechaza ("Role 'function' is not supported"); la API
// SÍ acepta el functionResponse dentro de un turno role:'user'. Ver test en el historial de
// esta sesión — no es una suposición, se probó contra la API real con la key real.

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// assistantCore usa JSON Schema estándar en minúsculas (nativo de OpenAI) — Gemini exige
// mayúsculas ("OBJECT"/"STRING"/"NUMBER"), así que se convierte acá, una sola vez por proceso.
function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema && typeof schema === 'object') {
    const out = {};
    for (const key of Object.keys(schema)) {
      out[key] = key === 'type' && typeof schema[key] === 'string' ? schema[key].toUpperCase() : toGeminiSchema(schema[key]);
    }
    return out;
  }
  return schema;
}

const functionDeclarations = toolSchemas.map((t) => ({ ...t, parameters: toGeminiSchema(t.parameters) }));

async function callGemini(contents, isFirstMessage) {
  const url = `${API_BASE}/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`;
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: buildSystemInstruction(isFirstMessage) }] },
    contents,
    tools: [{ functionDeclarations }],
  });

  // Gemini devuelve 503/429 "high demand"/cuota con cierta frecuencia en el nivel gratuito,
  // incluso con una key válida — es carga del lado de Google, no un bug nuestro (visto en vivo
  // repetidas veces durante las pruebas de esta sesión, incluyendo rachas de varios intentos
  // seguidos fallando). 5 intentos con backoff exponencial (2s,4s,8s,15s,15s tope) antes de
  // rendirse de verdad — más resistencia que un backoff lineal de 3 intentos ante una racha
  // sostenida de saturación, sin bloquear indefinidamente (WhatsApp ya recibió su 200 OK
  // inmediato, así que tardar más en responder el chat no rompe el webhook).
  //
  // fetch() de Node no tiene timeout por defecto — si la conexión se cuelga (visto en vivo
  // durante las pruebas de esta sesión: una llamada quedó colgada varios minutos sin error ni
  // respuesta), el await se queda esperando para siempre. AbortController con un límite
  // explícito convierte ese cuelgue silencioso en un error claro y reintentable.
  const REQUEST_TIMEOUT_MS = 30000;
  const MAX_ATTEMPTS = 5;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res, body;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: controller.signal,
      });
      // res.json() va DENTRO del try, protegido por el mismo AbortController — un fetch()
      // puede resolver (cabeceras recibidas) y aun así colgarse leyendo un body que Gemini
      // nunca termina de enviar (visto en vivo: quedó "atascado" minutos sin ningún log de
      // reintento, porque antes el timeout se cancelaba justo después del fetch, antes de leer
      // el body).
      body = await res.json();
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err.name === 'AbortError'
        ? new Error(`Gemini API timeout tras ${REQUEST_TIMEOUT_MS}ms`)
        : err;
      if (attempt === MAX_ATTEMPTS) throw lastErr;
      console.warn(`[geminiProvider] ${lastErr.message}, reintentando (${attempt}/${MAX_ATTEMPTS})...`);
      await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 15000)));
      continue;
    }
    clearTimeout(timeout);

    if (res.ok) return body;

    lastErr = new Error(`Gemini API error ${res.status}: ${JSON.stringify(body)}`);
    const retryable = res.status === 503 || res.status === 429;
    if (!retryable || attempt === MAX_ATTEMPTS) throw lastErr;
    console.warn(`[geminiProvider] Gemini ${res.status}, reintentando (${attempt}/${MAX_ATTEMPTS})...`);
    await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 15000)));
  }
  throw lastErr;
}

// Procesa un mensaje entrante de un número de WhatsApp y devuelve el texto de respuesta.
// Mantiene el historial de la conversación en conversationStore entre mensajes (mismo shape
// {role, parts} que espera la API, así se puede pasar tal cual como `contents`).
async function handleIncomingMessage(phone, userText) {
  const isFirstMessage = conversationStore.get(phone) === null;
  const history = conversationStore.getOrCreate(phone);
  const contents = [...history, { role: 'user', parts: [{ text: userText }] }];

  let guard = 0;
  let finalText = '';

  while (guard < 6) {
    guard++;
    const result = await callGemini(contents, isFirstMessage);
    const candidate = result.candidates && result.candidates[0];
    const parts = (candidate && candidate.content && candidate.content.parts) || [];
    const functionCallParts = parts.filter((p) => p.functionCall);

    if (functionCallParts.length === 0) {
      finalText = parts.map((p) => p.text || '').join('').trim();
      break;
    }

    // Turno del modelo pidiendo la(s) función(es) — se agrega tal cual a la conversación.
    contents.push(candidate.content);

    // Se resuelven todas las funciones pedidas y se devuelven en un solo turno role:'user'
    // (la API rechaza role:'function' — ver nota arriba).
    const responseParts = [];
    for (const part of functionCallParts) {
      const toolResult = await executeFunctionCall(part.functionCall.name, part.functionCall.args);
      responseParts.push({ functionResponse: { name: part.functionCall.name, response: toolResult } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  if (!finalText) {
    finalText = 'Disculpa, tuve un problema procesando eso. ¿Puedes reformular tu mensaje?';
    console.error('[geminiProvider] Se agotó el límite de turnos de function calling sin respuesta de texto.');
  }

  conversationStore.append(phone, { role: 'user', parts: [{ text: userText }] });
  conversationStore.append(phone, { role: 'model', parts: [{ text: finalText }] });
  return finalText;
}

module.exports = { handleIncomingMessage };
