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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return false;
  const d = parseIsoDate(iso);
  if (Number.isNaN(d.getTime())) return false;
  // Date.UTC no rechaza un día fuera de rango (Date.UTC(2026,1,30) para "30 de febrero" no
  // da NaN, lo normaliza solo a marzo 2) — round-trip contra el mismo objeto Date para
  // detectar ese desborde en vez de solo chequear NaN. Bug real encontrado en auditoría: sin
  // esto, una fecha con día inválido pasaba la validación y quedaba guardada tal cual
  // ("2026-02-30") mientras nightsBetween/precio/disponibilidad la trataban como otra fecha
  // real (marzo 2) — el registro mostraría una fecha y bloquearía/cobraría otra.
  const [y, m, day] = String(iso).split('-').map(Number);
  return d.getUTCFullYear() === y && d.getUTCMonth() === m - 1 && d.getUTCDate() === day;
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
