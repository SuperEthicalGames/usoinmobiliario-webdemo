const config = require('../config');
const conversationStore = require('./conversationStore');
const { toolSchemas, executeFunctionCall, buildSystemInstruction } = require('./assistantCore');

// Mismo contrato que geminiProvider.js (handleIncomingMessage(phone, userText) -> texto),
// hablando con la API de Chat Completions de OpenAI en vez de Gemini. assistantCore.js ya usa
// JSON Schema en minúsculas, que es exactamente lo que OpenAI espera — acá no hace falta
// convertir nada, a diferencia de Gemini.

const API_URL = 'https://api.openai.com/v1/chat/completions';

const tools = toolSchemas.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

async function callOpenAI(messages) {
  const payload = JSON.stringify({
    model: config.openai.model,
    messages,
    tools,
    tool_choice: 'auto',
  });

  // Mismo criterio de resistencia que geminiProvider.js (ver ese archivo para el porqué): 5
  // intentos con backoff exponencial + timeout explícito, ya que fetch() nativo no tiene uno.
  const REQUEST_TIMEOUT_MS = 30000;
  const MAX_ATTEMPTS = 5;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res, body;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openai.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: payload,
        signal: controller.signal,
      });
      // res.json() dentro del try, protegido por el mismo AbortController — ver
      // geminiProvider.js para el porqué (un fetch() puede resolver y aun así colgarse leyendo
      // un body que nunca termina de llegar).
      body = await res.json();
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err.name === 'AbortError'
        ? new Error(`OpenAI API timeout tras ${REQUEST_TIMEOUT_MS}ms`)
        : err;
      if (attempt === MAX_ATTEMPTS) throw lastErr;
      console.warn(`[openaiProvider] ${lastErr.message}, reintentando (${attempt}/${MAX_ATTEMPTS})...`);
      await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 15000)));
      continue;
    }
    clearTimeout(timeout);

    if (res.ok) return body;

    lastErr = new Error(`OpenAI API error ${res.status}: ${JSON.stringify(body)}`);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) throw lastErr;
    console.warn(`[openaiProvider] OpenAI ${res.status}, reintentando (${attempt}/${MAX_ATTEMPTS})...`);
    await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 15000)));
  }
  throw lastErr;
}

// conversationStore guarda un transcript neutral {role:'user'|'model', parts:[{text}]}
// (compartido con geminiProvider.js) — acá se traduce a los roles que OpenAI espera
// ('user'/'assistant') justo antes de enviarlo, nunca se persiste en formato OpenAI.
function toOpenAiRole(role) {
  return role === 'model' ? 'assistant' : role;
}

async function handleIncomingMessage(phone, userText) {
  const isFirstMessage = conversationStore.get(phone) === null;
  const history = conversationStore.getOrCreate(phone);
  const messages = [
    { role: 'system', content: buildSystemInstruction(isFirstMessage) },
    ...history.map((h) => ({ role: toOpenAiRole(h.role), content: h.parts.map((p) => p.text || '').join('') })),
    { role: 'user', content: userText },
  ];

  let guard = 0;
  let finalText = '';

  while (guard < 6) {
    guard++;
    const result = await callOpenAI(messages);
    const message = result.choices && result.choices[0] && result.choices[0].message;
    const toolCalls = (message && message.tool_calls) || [];

    if (toolCalls.length === 0) {
      finalText = (message && message.content) || '';
      break;
    }

    // Turno del asistente pidiendo la(s) función(es) — se agrega tal cual a la conversación.
    messages.push(message);

    // A diferencia de Gemini, la API de OpenAI SÍ acepta (y exige) role:'tool' por cada
    // llamada, cada uno referenciando su propio tool_call_id.
    for (const call of toolCalls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* args mal formados, se trata como vacío */ }
      const toolResult = await executeFunctionCall(call.function.name, args);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(toolResult) });
    }
  }

  if (!finalText) {
    finalText = 'Disculpa, tuve un problema procesando eso. ¿Puedes reformular tu mensaje?';
    console.error('[openaiProvider] Se agotó el límite de turnos de function calling sin respuesta de texto.');
  }

  conversationStore.append(phone, { role: 'user', parts: [{ text: userText }] });
  conversationStore.append(phone, { role: 'model', parts: [{ text: finalText }] });
  return finalText;
}

module.exports = { handleIncomingMessage };
