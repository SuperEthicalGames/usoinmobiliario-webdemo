// Convención de marcado ligero compartida por TODOS los canales (WhatsApp, chat web) — una
// sola especificación de formato, no dos. Antes vivía dentro de whatsapp.js con el nombre
// sanitizeForWhatsApp, pero no es realmente específico de WhatsApp: es una red de seguridad
// contra un problema real del MODELO, no del canal — confirmado en vivo (2026-09-07, mensaje
// de diagnóstico real) que el modelo puede emitir **negrilla**/__negrilla__ estilo GitHub o
// dejar un asterisco suelto bajo presión (cadena larga de function calls, modelo más pequeño),
// aunque el prompt le pida la sintaxis correcta. Sacado a su propio módulo para que el canal de
// chat web (que nunca pasa por whatsapp.js) reciba la misma protección, no una versión sin ella.
//
// Sintaxis soportada: *negrilla*, _cursiva_, ~tachado~ (un símbolo a cada lado, sin espacios
// pegados) — nunca **negrilla** estilo GitHub, nunca encabezados (#), nunca enlaces [texto](url).

// WhatsApp/el widget web emparejan los símbolos de marcado en orden a lo largo de TODO el
// mensaje — si queda una cantidad impar de un símbolo (por un asterisco de más, o una negrilla
// que el modelo dejó sin cerrar), no solo ese símbolo se ve literal: puede arrastrar y romper
// el emparejamiento de TODO lo que sigue en el mensaje.
//
// Antes esto borraba TODAS las apariciones del símbolo en el mensaje entero para volver la
// cuenta par — pero el mensaje final también puede traer datos reales del cliente citados
// textualmente (correo, referencia de pago, notas), que no tienen nada que ver con el marcado
// y no pasan por ningún validador que excluya *_~. Bug real encontrado en auditoría: un correo
// como "ana_maria@gmail.com" citado junto con una sola frase en cursiva en el mismo mensaje
// suma 3 guiones bajos (impar) y el mensaje le llegaba al cliente con el correo corrompido
// ("anamaria@gmail.com"). Basta con quitar UNA aparición (la última) para volver la cuenta
// par y resolver el problema de emparejamiento de WhatsApp, sin tocar el resto del texto.
function stripIfUnbalanced(text, marker) {
  const count = text.split(marker).length - 1;
  if (count % 2 === 0) return text;
  const lastIndex = text.lastIndexOf(marker);
  return text.slice(0, lastIndex) + text.slice(lastIndex + marker.length);
}

function normalizeMarkup(text) {
  let out = text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1: $2');
  out = stripIfUnbalanced(out, '*');
  out = stripIfUnbalanced(out, '_');
  out = stripIfUnbalanced(out, '~');
  return out;
}

module.exports = { normalizeMarkup, stripIfUnbalanced };
