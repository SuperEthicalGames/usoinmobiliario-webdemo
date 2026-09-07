const config = require('../config');

// Contexto de conversación por número de WhatsApp (sección 22/23 del pedido) — en memoria,
// nada de esto es "la fuente de verdad" del negocio (esa sigue siendo Firebase), es solo el
// hilo de la charla para que el cliente no tenga que repetir información. Se limpia solo tras
// un rato de inactividad para no crecer indefinidamente; si el proceso se reinicia, el
// historial de conversación se pierde (aceptable para un MVP gratuito — documentado en el
// README, no una base de datos paralela del negocio).

const conversations = new Map(); // phone -> { history: [...], lastActive: number }
const locks = new Map(); // phone -> promesa de la cola de procesamiento en curso

// Si el mismo número manda varios mensajes seguidos (muy común: nombre, teléfono y correo como
// burbujas separadas), cada webhook los procesa en su propia llamada async — sin esto, dos
// mensajes casi simultáneos podían leer el MISMO historial de partida (ninguno ve el resultado
// del otro todavía) y cada uno decidir por su cuenta que ya tenía todo para crear la reserva/
// cita, generando duplicados. Esto encola el procesamiento por número: el siguiente mensaje de
// ESE número espera a que el anterior termine (y ya haya guardado su turno en el historial)
// antes de empezar. Números distintos no se bloquean entre sí.
function runSerialized(phone, fn) {
  const previous = locks.get(phone) || Promise.resolve();
  const run = previous.then(fn, fn);
  locks.set(phone, run.catch(() => {}));
  return run;
}

function get(phone) {
  const entry = conversations.get(phone);
  if (!entry) return null;
  entry.lastActive = Date.now();
  return entry.history;
}

function getOrCreate(phone) {
  let entry = conversations.get(phone);
  if (!entry) {
    entry = { history: [], lastActive: Date.now() };
    conversations.set(phone, entry);
  }
  entry.lastActive = Date.now();
  return entry.history;
}

function append(phone, message) {
  const history = getOrCreate(phone);
  history.push(message);
  return history;
}

function reset(phone) {
  conversations.delete(phone);
}

function cleanupExpired() {
  const now = Date.now();
  for (const [phone, entry] of conversations.entries()) {
    if (now - entry.lastActive > config.conversationTtlMs) conversations.delete(phone);
  }
}

// Se arranca una sola vez desde server.js — revisa cada 5 minutos, no hace falta más
// frecuencia para una TTL de 30 minutos.
function startCleanupLoop() {
  setInterval(cleanupExpired, 5 * 60 * 1000).unref();
}

module.exports = { get, getOrCreate, append, reset, cleanupExpired, startCleanupLoop, runSerialized };
