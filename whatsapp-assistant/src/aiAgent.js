const config = require('../config');

// Selecciona el proveedor de IA según LLM_PROVIDER ('gemini' por defecto, o 'openai') — ambos
// implementan exactamente el mismo contrato (handleIncomingMessage(phone, userText) -> texto)
// y comparten las mismas reglas/herramientas vía assistantCore.js, así que cambiar de
// proveedor es solo esta elección, nada más en el resto del código necesita saberlo.
const provider = config.llm.provider === 'openai'
  ? require('./openaiProvider')
  : require('./geminiProvider');

module.exports = { handleIncomingMessage: provider.handleIncomingMessage };
