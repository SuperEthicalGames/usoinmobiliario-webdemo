// Convierte un entero a su forma escrita en español — requisito legal real: la factura de
// referencia (ver receiptPdf.js) trae "La suma de: (SEISCIENTOS TREINTA MIL PESOS 00 M.L)", el
// monto en letras es lo que hace válido el documento como título valor (letra de cambio) según
// el art. 774 del Código Civil, no es decoración. Soporta hasta 999.999.999 — de sobra para
// cualquier canon/abono real de este negocio.

const UNITS = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
const TEENS = ['diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve'];
const TWENTIES = ['veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const TENS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const HUNDREDS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

function twoDigits(n) {
  if (n < 10) return UNITS[n];
  if (n < 20) return TEENS[n - 10];
  if (n < 30) return TWENTIES[n - 20];
  const tens = Math.floor(n / 10);
  const rest = n % 10;
  return rest === 0 ? TENS[tens] : `${TENS[tens]} y ${UNITS[rest]}`;
}
function threeDigits(n) {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const hundredsWord = HUNDREDS[hundreds];
  return rest === 0 ? hundredsWord : (hundredsWord ? `${hundredsWord} ${twoDigits(rest)}` : twoDigits(rest));
}

function integerToWordsEs(n) {
  const num = Math.round(Math.abs(Number(n) || 0));
  if (num === 0) return 'cero';

  const millions = Math.floor(num / 1000000);
  const thousands = Math.floor((num % 1000000) / 1000);
  const rest = num % 1000;

  const parts = [];
  if (millions > 0) parts.push(millions === 1 ? 'un millón' : `${threeDigits(millions)} millones`);
  if (thousands > 0) parts.push(thousands === 1 ? 'mil' : `${threeDigits(thousands)} mil`);
  if (rest > 0) parts.push(threeDigits(rest));
  return parts.join(' ').trim();
}

// Formato exacto que usa la factura real: mayúsculas, "PESOS", sin decimales (COP no los usa en
// la práctica de este negocio) — ej. "SEISCIENTOS TREINTA MIL PESOS".
function copAmountInWords(n) {
  return `${integerToWordsEs(n).toUpperCase()} PESOS`;
}

module.exports = { integerToWordsEs, copAmountInWords };
