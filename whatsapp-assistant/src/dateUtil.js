// Espeja nightsBetween()/isoLocal() de index.html y DateUtil.cs de Unity — mismo criterio
// exacto: fechas puras "YYYY-MM-DD" sin hora/zona horaria, un nodo por cada noche desde
// checkin (incl.) hasta checkout (excl.). No se reinventa el formato en este tercer puerto.

function parseIsoDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function nightsBetween(checkinIso, checkoutIso) {
  const nights = [];
  let d = parseIsoDate(checkinIso);
  const end = parseIsoDate(checkoutIso);
  while (d < end) {
    nights.push(toIsoDate(d));
    d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  }
  return nights;
}

function isValidIsoDate(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(iso)) && !Number.isNaN(parseIsoDate(iso).getTime());
}

// "Hoy" en la zona horaria del negocio (Bogotá, UTC-5 fijo, sin horario de verano) — mismo
// offset fijo que usa Unity (DateUtil.TodayIsoBogota), por la misma razón: Bogotá nunca
// cambia de offset, no hace falta una base de datos de zonas horarias.
function todayIsoBogota() {
  const nowBogota = new Date(Date.now() - 5 * 60 * 60 * 1000);
  return toIsoDate(nowBogota);
}

function nowEpochMs() {
  return Date.now();
}

module.exports = { parseIsoDate, toIsoDate, nightsBetween, isValidIsoDate, todayIsoBogota, nowEpochMs };
