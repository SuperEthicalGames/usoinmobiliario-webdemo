const fb = require('./firebase');
const pricing = require('./pricing');
const dateUtil = require('./dateUtil');
const validators = require('./validators');
const config = require('../config');

// Extraído de businessTools.createReservationHold/createVisit y adminRoutes.js's
// POST /admin/api/reservations — las tres copias hacían EXACTAMENTE el mismo
// validar->resolver apartamento->tope de huéspedes->disponibilidad->precio->armar registro
// (un bug real, el tope de huéspedes, ya tuvo que corregirse una vez en dos lugares distintos).
// Este módulo es el único que decide la forma del registro; fb.createReservation/
// createSpecificVisit/createGeneralVisit siguen siendo el único paso de ESCRITURA (ya
// compartido antes de este cambio). Cada caller (bot, ruta pública nueva, ruta admin) traduce
// el `.code` del error a su propio contrato de respuesta — nunca lanza texto en español acá,
// eso es decisión de cada caller (el bot sí necesita frases en español para el cliente final,
// la ruta HTTP nueva/admin solo necesitan el código).

function apartmentLabel(num) {
  return `Apartamento H${num}`;
}

function typedError(message, code, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

// El cliente (index.html) generaba el código y confiaba en que Firebase Rules rechazara un
// !data.exists() ya tomado (colisión ~1/17.5M, "realísticamente imposible" pero no cero). El
// Admin SDK no tiene ese mismo candado gratis — sin este chequeo, una colisión real
// sobreescribiría en silencio el registro de otra persona en vez de fallar. Se mueve acá, el
// único lugar que ahora genera códigos para reservas/citas de cualquier canal.
const MAX_CODE_ATTEMPTS = 5;
async function generateUniqueCode() {
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
    const code = fb.generateCode();
    // eslint-disable-next-line no-await-in-loop
    const existing = await fb.getReservationByCode(code);
    if (!existing) return code;
  }
  throw typedError('code-generation-exhausted', 'internal');
}

// Dos convenciones de nombres coexisten para "qué apartamento" y hay que aceptar ambas: el bot
// (businessTools.js, args de function-calling) y el panel admin (ManualReservation.tsx) mandan
// typeKey/num; el sitio público (FirebaseDataProvider.js) arma su `rec` con unitType/unitNum
// desde siempre (son también los nombres de los campos ya guardados en Firebase) y esta
// migración lo reusa tal cual, sin tocar ese contrato existente — normalizar acá, en el único
// lugar compartido, es más simple que forzar a un caller a cambiar cómo ya nombra sus campos.
function resolveUnitArgs({ typeKey, num, unitType, unitNum }) {
  return { typeKey: typeKey || unitType, num: num || unitNum };
}

// Devuelve el registro completo, listo para fb.createReservation(rec) — NO escribe nada.
// Descarta cualquier campo "de confianza" (code/status/expiresAt/paymentStatus/estTotal/
// priceSnapshot/nights) que un caller público pudiera intentar mandar: se recalculan siempre
// acá, con las tarifas/disponibilidad reales del servidor, nunca con lo que mande el cliente.
async function buildReservationRecord(args) {
  const { checkin, checkout, guests, name, phone, email, notes } = args;
  const { typeKey, num } = resolveUnitArgs(args);
  const missing = validators.missingReservationFields({ num, checkin, checkout, guests, name, phone, email });
  if (missing.length > 0) throw typedError('invalid-reservation-fields', 'invalid', { missingFields: missing });

  const apt = await fb.getApartment(typeKey, num);
  if (!apt) throw typedError('apartment-not-found', 'not-found');
  // Hallazgo real de auditoría (antes solo vivía en el prompt de la IA, nada lo impedía
  // server-side): un pedido de más huéspedes de los que la unidad admite.
  if (apt.maxPersons && Number(guests) > apt.maxPersons) {
    throw typedError('capacity-exceeded', 'invalid', {
      missingFields: [`máximo ${apt.maxPersons} huésped(es) para este apartamento`],
      maxPersons: apt.maxPersons,
    });
  }

  // Pre-chequeo de disponibilidad (no atómico, misma razón que siempre: dar un error rápido y
  // claro). La garantía real contra doble-reserva sigue siendo el reclamo transaccional
  // noche-por-noche dentro de fb.createReservation, que corre después, ya con el registro
  // completo en mano.
  const availability = await fb.checkAvailability(apt.typeKey, apt.num, checkin, checkout);
  if (!availability.available) throw typedError('dates-taken', 'conflict', { reason: availability.reason });

  const nights = dateUtil.nightsBetween(checkin, checkout).length;
  const snapshot = pricing.priceBreakdown(apt, nights, guests);
  const code = await generateUniqueCode();

  const rec = {
    code,
    type: 'reserva',
    createdAt: new Date().toISOString(),
    unitType: apt.typeKey,
    unitNum: apt.num,
    unitLabel: apartmentLabel(apt.num),
    name: String(name).trim(),
    phone: String(phone).trim(),
    email: String(email).trim(),
    notes: notes ? String(notes).trim() : '',
    status: 'pendiente',
    checkin,
    checkout,
    nights,
    guests,
    paymentStatus: 'none',
    expiresAt: dateUtil.nowEpochMs() + config.holdDurationMs,
  };
  if (snapshot) {
    rec.estTotal = snapshot.total;
    rec.priceSnapshot = snapshot;
  }
  return rec;
}

// Devuelve { rec, isGeneral } — el caller decide entre fb.createSpecificVisit/createGeneralVisit
// según isGeneral (mismo criterio que businessTools.createVisit ya usaba).
async function buildVisitRecord(args) {
  const { name, phone, email, notes, visitDate, visitTime } = args;
  const { typeKey, num } = resolveUnitArgs(args);
  const missing = validators.missingVisitFields({ name, phone, email, visitDate, visitTime });
  if (missing.length > 0) throw typedError('invalid-visit-fields', 'invalid', { missingFields: missing });

  const isGeneral = !typeKey || !num;
  let unitLabel = 'Visita general';
  let resolvedTypeKey = null;
  let resolvedNum = null;
  if (!isGeneral) {
    const apt = await fb.getApartment(typeKey, num);
    if (!apt) throw typedError('apartment-not-found', 'not-found');
    resolvedTypeKey = apt.typeKey;
    resolvedNum = apt.num;
    unitLabel = apartmentLabel(apt.num);
  }

  const code = await generateUniqueCode();
  const rec = {
    code,
    type: 'cita',
    createdAt: new Date().toISOString(),
    unitType: resolvedTypeKey,
    unitNum: resolvedNum,
    unitLabel,
    name: String(name).trim(),
    phone: String(phone).trim(),
    email: String(email).trim(),
    notes: notes ? String(notes).trim() : '',
    status: 'pendiente',
    visitDate,
    visitTime,
    appointmentType: isGeneral ? 'general_visit' : 'specific_visit',
  };
  return { rec, isGeneral };
}

module.exports = { buildReservationRecord, buildVisitRecord };
