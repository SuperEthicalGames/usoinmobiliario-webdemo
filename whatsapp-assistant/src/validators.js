const { isValidIsoDate, parseIsoDate } = require('./dateUtil');

// Mismo patrón de correo que valida database.rules.json server-side — si el backend acepta
// algo que las reglas rechazarían, el error solo aparecería más tarde y menos claro.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// EXACTAMENTE 3 letras mayúsculas + 3 dígitos — mismo formato que Unity/index.html, nunca
// UUID, nunca 5/7 caracteres. No cambiar.
const CODE_PATTERN = /^[A-Z]{3}[0-9]{3}$/;

// El formato solo no basta: en pruebas reales la IA (bajo presión de completar la solicitud)
// rellenó estos campos con valores de relleno que SÍ tienen formato válido — "Cliente",
// "0000000000", "pendiente@correo.com" — y la reserva/cita se creó igual porque pasaban estas
// validaciones. Esto NO fue un caso aislado del nombre/teléfono/correo — es un patrón general:
// cualquier campo que dependa de que el cliente escriba un dato real (también el monto/
// referencia/banco de un pago reportado) corre el mismo riesgo. Estas listas/helpers son
// genéricos para poder aplicarse en cualquier campo de este tipo, no solo en reservas/citas.
const PLACEHOLDER_WORDS = ['cliente', 'test', 'n/a', 'na', 'usuario', 'nombre', 'sin nombre', 'pendiente', 'ninguna', 'ninguno', 'no tengo', 'ejemplo', 'placeholder', 'desconocido', 'referencia', 'banco'];
const PLACEHOLDER_EMAIL_LOCALS = ['pendiente', 'cliente', 'test', 'ejemplo', 'placeholder', 'correo', 'na', 'usuario', 'nombre', 'email'];
const PLACEHOLDER_EMAIL_DOMAINS = ['correo.com', 'example.com', 'test.com', 'mail.com', 'email.com', 'dominio.com'];

// Todos los caracteres repetidos (0000000000, 1111111111, aaaaaa) — un dato real casi nunca
// tiene esta forma, sea teléfono, referencia de pago, etc.
function isRepeatedChar(value) {
  const s = String(value || '').trim();
  return s.length > 0 && /^(.)\1*$/.test(s);
}

function isPlaceholderText(value) {
  const s = String(value || '').trim().toLowerCase();
  return !s || PLACEHOLDER_WORDS.includes(s) || isRepeatedChar(s);
}

function isPlaceholderPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return isRepeatedChar(digits);
}

function isPlaceholderName(name) {
  return isPlaceholderText(name);
}

function isValidEmail(email) {
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) return false;
  const [local, domain] = email.trim().toLowerCase().split('@');
  return !PLACEHOLDER_EMAIL_LOCALS.includes(local) && !PLACEHOLDER_EMAIL_DOMAINS.includes(domain);
}

// Para el comprobante de pago reportado (sección 14 del pedido) — mismo criterio que el resto:
// formato válido no basta, tiene que parecer un dato real que el cliente sí escribió.
function isValidPaymentAmount(amount) {
  const n = Number(amount);
  return Number.isFinite(n) && n > 0;
}

function isValidPaymentReference(reference) {
  const s = String(reference || '').trim();
  return s.length >= 4 && !isPlaceholderText(s);
}

function isValidBankName(bank) {
  return !isPlaceholderText(bank);
}

function isValidCodeFormat(code) {
  return typeof code === 'string' && CODE_PATTERN.test(code.trim());
}

function isValidPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 7 && !isPlaceholderPhone(phone);
}

function isValidDateRange(checkin, checkout) {
  if (!isValidIsoDate(checkin) || !isValidIsoDate(checkout)) return false;
  return parseIsoDate(checkout) > parseIsoDate(checkin);
}

function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}

// Junta los campos obligatorios que falten para crear una reserva (sección 11/12 del pedido:
// correo SIEMPRE obligatorio) — devuelve una lista vacía si todo está completo, para que
// aiAgent.js sepa exactamente qué preguntarle al cliente a continuación sin adivinar.
function missingReservationFields({ num, checkin, checkout, guests, name, phone, email }) {
  // typeKey NO se exige acá — el número identifica el apartamento sin ambigüedad en este
  // catálogo (verificado: sin choques de número entre categorías), así que si el cliente dice
  // "quiero la 9" sin mencionar la categoría, num solo ya es suficiente (ver
  // firebase.js:findApartmentByNum).
  const missing = [];
  if (!num) missing.push('apartamento');
  if (!checkin || !checkout || !isValidDateRange(checkin, checkout)) missing.push('fechas (checkin/checkout válidos)');
  if (!isPositiveInt(guests)) missing.push('número de huéspedes');
  if (!name || !String(name).trim() || isPlaceholderName(name)) missing.push('nombre');
  if (!isValidPhone(phone)) missing.push('teléfono');
  if (!isValidEmail(email)) missing.push('correo electrónico');
  return missing;
}

function missingVisitFields({ name, phone, email, visitDate, visitTime }) {
  const missing = [];
  if (!name || !String(name).trim() || isPlaceholderName(name)) missing.push('nombre');
  if (!isValidPhone(phone)) missing.push('teléfono');
  if (!isValidEmail(email)) missing.push('correo electrónico');
  if (!isValidIsoDate(visitDate)) missing.push('fecha de la visita');
  if (!visitTime || !/^\d{2}:\d{2}$/.test(visitTime)) missing.push('hora de la visita');
  return missing;
}

function missingPaymentReportFields({ amount, reference, bank }) {
  const missing = [];
  if (!isValidPaymentAmount(amount)) missing.push('monto');
  if (!isValidPaymentReference(reference)) missing.push('referencia de la transferencia');
  if (!isValidBankName(bank)) missing.push('banco');
  return missing;
}

module.exports = {
  isValidEmail,
  isValidCodeFormat,
  isValidPhone,
  isValidDateRange,
  isPositiveInt,
  isValidPaymentAmount,
  isValidPaymentReference,
  isValidBankName,
  missingReservationFields,
  missingVisitFields,
  missingPaymentReportFields,
};
