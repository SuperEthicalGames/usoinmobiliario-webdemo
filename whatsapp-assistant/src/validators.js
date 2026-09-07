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
// validaciones. Estas listas rechazan los patrones de relleno más comunes para que la función
// devuelva "falta este dato" de verdad en vez de aceptar basura con forma de dato real.
const PLACEHOLDER_NAMES = ['cliente', 'test', 'n/a', 'na', 'usuario', 'nombre', 'sin nombre'];
const PLACEHOLDER_EMAIL_LOCALS = ['pendiente', 'cliente', 'test', 'ejemplo', 'placeholder', 'correo', 'na', 'usuario', 'nombre', 'email'];
const PLACEHOLDER_EMAIL_DOMAINS = ['correo.com', 'example.com', 'test.com', 'mail.com', 'email.com', 'dominio.com'];

function isPlaceholderPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return /^(\d)\1*$/.test(digits); // todos los dígitos iguales (0000000000, 1111111111, etc.)
}

function isPlaceholderName(name) {
  return PLACEHOLDER_NAMES.includes(String(name || '').trim().toLowerCase());
}

function isValidEmail(email) {
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) return false;
  const [local, domain] = email.trim().toLowerCase().split('@');
  return !PLACEHOLDER_EMAIL_LOCALS.includes(local) && !PLACEHOLDER_EMAIL_DOMAINS.includes(domain);
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
function missingReservationFields({ typeKey, num, checkin, checkout, guests, name, phone, email }) {
  const missing = [];
  if (!typeKey || !num) missing.push('apartamento');
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

module.exports = {
  isValidEmail,
  isValidCodeFormat,
  isValidPhone,
  isValidDateRange,
  isPositiveInt,
  missingReservationFields,
  missingVisitFields,
};
