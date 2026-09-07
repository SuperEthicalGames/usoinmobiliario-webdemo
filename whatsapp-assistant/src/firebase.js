const admin = require('firebase-admin');
const fs = require('fs');
const config = require('../config');
const { nightsBetween, nowEpochMs } = require('./dateUtil');

// Único lugar que toca el SDK de Firebase Admin — mismo principio de capas que el proyecto
// Unity (UI -> Services -> Repositories -> Firebase): businessTools.js llama estas funciones,
// nunca al Admin SDK directamente. Mismos paths/nombres de campo que
// firebase/FirebaseDataProvider.js y los modelos C# de Unity — ver el diagnóstico dado al
// usuario antes de escribir este archivo.
function loadServiceAccount() {
  if (config.firebase.serviceAccountJson) {
    return JSON.parse(config.firebase.serviceAccountJson);
  }
  const raw = fs.readFileSync(config.firebase.serviceAccountPath, 'utf8');
  return JSON.parse(raw);
}

let app;
function init() {
  if (app) return app;
  app = admin.initializeApp({
    credential: admin.credential.cert(loadServiceAccount()),
    databaseURL: config.firebase.databaseURL,
  });
  return app;
}

function db() {
  init();
  return admin.database();
}

// El SDK de Firebase Admin no tiene timeout propio — una llamada colgada (visto en vivo esta
// misma sesión, tanto en pruebas de fetch() antes de tener AbortController como en llamadas
// reales durante pruebas de WhatsApp) se queda esperando para siempre, sin error, bloqueando
// toda la conversación. Mismo criterio que ya se aplicó a Gemini/WhatsApp (aiAgent.js/
// whatsapp.js): un límite explícito convierte un cuelgue silencioso en un error claro.
const FIREBASE_TIMEOUT_MS = 15000;
function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Firebase timeout tras ${FIREBASE_TIMEOUT_MS}ms (${label})`)), FIREBASE_TIMEOUT_MS)
    ),
  ]);
}

function dbGet(path) {
  return withTimeout(db().ref(path).get(), `get ${path}`);
}
function dbSet(path, value) {
  return withTimeout(db().ref(path).set(value), `set ${path}`);
}
function dbRemove(path) {
  return withTimeout(db().ref(path).remove(), `remove ${path}`);
}
function dbUpdate(updates) {
  return withTimeout(db().ref().update(updates), 'update');
}
function dbTransaction(path, updateFn) {
  return withTimeout(db().ref(path).transaction(updateFn), `transaction ${path}`);
}

// --- Alfabeto y formato exactos de genCode()/GenerateCode() en index.html y Unity — sin I/O
// para evitar confusión visual con 1/0. NO cambiar este formato. ---
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function generateCode() {
  let letters = '';
  for (let i = 0; i < 3; i++) letters += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
  const num = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  return letters + num;
}

function unitKeyOf(typeKey, num) {
  return `${typeKey}_${num}`;
}

function pathFor(type) {
  return type === 'cita' ? 'reservationsManager/visits' : 'reservationsManager/reservations';
}

// --- Lecturas de catálogo (categories/apartments/statusMeta) ---

async function getCategories() {
  const snap = await dbGet('categories');
  return snap.val() || {};
}

async function getApartments() {
  const snap = await dbGet('apartments');
  const raw = snap.val() || {};
  return Object.keys(raw).map((key) => ({ ...raw[key], _key: key }));
}

// El label que se le muestra al cliente ("Apartamento H09") no codifica el typeKey real
// ("estudio"/"dos") — cuando el cliente responde por ese label, el modelo no siempre puede
// reconstruir el typeKey exacto y a veces lo adivina mal, aunque el número sí lo recuerda bien.
// Confirmado en vivo: la IA pedía typeKey inexistentes y todo salía "no disponible" en cadena
// aunque Firebase mostraba disponibilidad real. Como `num` es único en TODO el catálogo (sin
// choques entre categorías, verificado contra los datos reales), buscar por número solo es un
// respaldo seguro cuando la clave exacta no existe.
async function findApartmentByNum(num) {
  const target = String(num).padStart(2, '0');
  const apartments = await getApartments();
  return (
    apartments.find((a) => String(a.num).padStart(2, '0') === target) ||
    apartments.find((a) => String(a.num) === String(num)) ||
    null
  );
}

async function getApartment(typeKey, num) {
  const snap = await dbGet(`apartments/${typeKey}_${num}`);
  if (snap.exists()) return snap.val();
  return findApartmentByNum(num);
}

async function getStatusMeta() {
  const snap = await dbGet('statusMeta');
  return snap.val() || {};
}

async function getPaymentInfo() {
  const snap = await dbGet('settings/paymentInfo');
  return snap.val() || null;
}

// --- Reservas / citas: lectura ---

async function getReservationByCode(code) {
  const upper = String(code || '').trim().toUpperCase();
  const resSnap = await dbGet(`reservationsManager/reservations/${upper}`);
  if (resSnap.exists()) return resSnap.val();
  const visitSnap = await dbGet(`reservationsManager/visits/${upper}`);
  return visitSnap.exists() ? visitSnap.val() : null;
}

async function getUnitBookings(unitKey) {
  const snap = await dbGet(`unitBookings/${unitKey}`);
  return snap.val() || {};
}

// Mismo criterio que IsHoldExpired en Unity / isHoldExpiredRecord en index.html.
function isHoldExpired(booking, nowMs) {
  return !!booking && booking.type === 'reserva' && booking.status === 'pendiente' && booking.expiresAt
    && booking.paymentStatus !== 'submitted' && booking.expiresAt < nowMs;
}

// Libera (best-effort) las noches de un HOLD vencido — mismo espíritu que
// ReclaimExpiredHoldAsync (Unity) / reclaimExpiredHold (index.html): si falla, no importa, la
// siguiente lectura lo vuelve a intentar.
async function reclaimExpiredHold(unitKey, checkin, checkout) {
  const updates = {};
  for (const night of nightsBetween(checkin, checkout)) {
    updates[`bookedNights/${unitKey}/${night}`] = null;
  }
  try {
    await dbUpdate(updates);
  } catch {
    /* mejor esfuerzo, ignorar */
  }
}

// Puerto de checkNightAsync (Unity) / checkNightFree (index.html): {free, reason}. Reclama de
// paso cualquier noche cuyo HOLD ya venció.
async function checkNight(unitKey, night) {
  const snap = await dbGet(`bookedNights/${unitKey}/${night}`);
  if (!snap.exists()) return { free: true, reason: null };

  const code = snap.val();
  const bookingSnap = await dbGet(`unitBookings/${unitKey}/${code}`);
  const booking = bookingSnap.val();

  if (isHoldExpired(booking, nowEpochMs())) {
    if (booking.checkin && booking.checkout) await reclaimExpiredHold(unitKey, booking.checkin, booking.checkout);
    return { free: true, reason: null };
  }
  const reason = booking && booking.status === 'confirmada' ? 'confirmed_reservation' : 'temporary_hold';
  return { free: false, reason };
}

// Disponibilidad para un rango completo — puerto de AvailabilityService.CheckAvailabilityAsync.
async function checkAvailability(typeKey, num, checkinIso, checkoutIso) {
  const unitKey = unitKeyOf(typeKey, num);
  const nights = nightsBetween(checkinIso, checkoutIso);
  const reasons = [];
  for (const night of nights) {
    const { free, reason } = await checkNight(unitKey, night);
    if (!free) reasons.push(reason);
  }
  if (reasons.length === 0) return { available: true, reason: null };
  const finalReason = reasons.includes('confirmed_reservation') ? 'confirmed_reservation' : 'temporary_hold';
  return { available: false, reason: finalReason };
}

// Estado EFECTIVO de un apartamento (disponible/en-uso/reservado) — puerto de
// AvailabilityService.EffectiveStatus. Solo cuenta reservas CONFIRMADAS.
function effectiveStatus(apartment, unitBookings, todayIso) {
  if (!apartment) return null;
  const bookings = Object.values(unitBookings || {});
  if (bookings.length === 0) return apartment.status;
  let hasActive = false;
  let hasFuture = false;
  for (const b of bookings) {
    if (!b || b.status !== 'confirmada' || b.type !== 'reserva') continue;
    if (b.checkin <= todayIso && todayIso < b.checkout) hasActive = true;
    else if (b.checkin > todayIso) hasFuture = true;
  }
  if (hasActive) return 'en-uso';
  if (hasFuture) return 'reservado';
  return apartment.status;
}

// --- Creación: EL punto crítico de concurrencia (ver diagnóstico dado al usuario). Admin SDK
// se salta las reglas de seguridad que en el cliente web hacen esta garantía, así que acá se
// reconstruye la misma garantía con transacciones reales sobre cada noche/turno individual. ---

// Intenta reclamar una sola noche de forma atómica: solo tiene éxito si el nodo está libre en
// ESE INSTANTE. Devuelve true si la reclamó, false si alguien más la tenía.
async function claimNightAtomically(unitKey, night, code) {
  const result = await dbTransaction(`bookedNights/${unitKey}/${night}`, (current) => {
    if (current === null) return code; // libre -> la reclamamos
    return undefined; // ocupada -> abortar esta transacción, no tocar el valor
  });
  return result.committed;
}

async function claimSlotAtomically(unitKey, slotKey, code) {
  const result = await dbTransaction(`bookedVisitSlots/${unitKey}/${slotKey}`, (current) => (current === null ? code : undefined));
  return result.committed;
}

async function releaseNights(unitKey, nights) {
  const updates = {};
  for (const n of nights) updates[`bookedNights/${unitKey}/${n}`] = null;
  await dbUpdate(updates);
}

// Crea una reserva de apartamento. Pre-chequea + reclama libertad de fecha por transacción,
// noche por noche; si CUALQUIER noche falla (alguien la tomó en el instante exacto), libera
// las que sí alcanzó a reclamar en este mismo intento y lanza 'conflict' — nunca deja un
// registro a medias.
async function createReservation(rec) {
  const unitKey = unitKeyOf(rec.unitType, rec.unitNum);
  const nights = nightsBetween(rec.checkin, rec.checkout);

  // Pre-chequeo + reclamo de HOLDs vencidos ANTES de intentar las transacciones — evita que un
  // HOLD viejo bloquee innecesariamente (ver checkNight/reclaimExpiredHold arriba).
  for (const night of nights) {
    await checkNight(unitKey, night);
  }

  const claimed = [];
  for (const night of nights) {
    const ok = await claimNightAtomically(unitKey, night, rec.code);
    if (!ok) {
      if (claimed.length > 0) await releaseNights(unitKey, claimed);
      const err = new Error('dates-taken');
      err.code = 'conflict';
      throw err;
    }
    claimed.push(night);
  }

  const unitBooking = {
    status: rec.status,
    type: 'reserva',
    checkin: rec.checkin,
    checkout: rec.checkout,
    paymentStatus: rec.paymentStatus || 'none',
  };
  if (rec.expiresAt) unitBooking.expiresAt = rec.expiresAt;

  const updates = {
    [`${pathFor('reserva')}/${rec.code}`]: rec,
    [`unitBookings/${unitKey}/${rec.code}`]: unitBooking,
  };
  try {
    await dbUpdate(updates);
  } catch (err) {
    await releaseNights(unitKey, claimed);
    throw err;
  }
  return rec;
}

// Cita a un apartamento específico — mismo patrón de reclamo atómico, pero de un solo turno
// (bookedVisitSlots), no de varias noches.
async function createSpecificVisit(rec) {
  const unitKey = unitKeyOf(rec.unitType, rec.unitNum);
  const slotKey = `${rec.visitDate}_${rec.visitTime}`;

  const ok = await claimSlotAtomically(unitKey, slotKey, rec.code);
  if (!ok) {
    const err = new Error('slot-taken');
    err.code = 'conflict';
    throw err;
  }

  const updates = {
    [`${pathFor('cita')}/${rec.code}`]: rec,
    [`unitBookings/${unitKey}/${rec.code}`]: {
      status: rec.status,
      type: 'cita',
      visitDate: rec.visitDate,
      visitTime: rec.visitTime,
    },
  };
  try {
    await dbUpdate(updates);
  } catch (err) {
    await dbRemove(`bookedVisitSlots/${unitKey}/${slotKey}`);
    throw err;
  }
  return rec;
}

// Visita general ("quiero conocer las opciones") — no está atada a una unidad, no hay
// turno/noches que reclamar, se guarda directo. Mismo criterio que CreateAsync en Unity /
// createReservation en index.html para appointmentType === 'general_visit'.
async function createGeneralVisit(rec) {
  await dbSet(`${pathFor('cita')}/${rec.code}`, rec);
  return rec;
}

// El cliente reporta haber pagado — SOLO marca paymentStatus='submitted', nunca 'verified'.
// Mismo guardado condicional que hace la regla de Firebase (solo desde 'none'), replicado acá
// porque Admin SDK no pasa por esa regla.
async function reportPayment(code, report) {
  const rec = await getReservationByCode(code);
  if (!rec) { const e = new Error('reservation-not-found'); e.code = 'not-found'; throw e; }
  if (rec.type !== 'reserva') { const e = new Error('not-a-reservation'); e.code = 'invalid'; throw e; }
  if (rec.paymentStatus && rec.paymentStatus !== 'none') {
    const e = new Error('payment-already-reported'); e.code = 'invalid'; throw e;
  }
  const unitKey = unitKeyOf(rec.unitType, rec.unitNum);
  const updates = {
    [`${pathFor('reserva')}/${code}/paymentStatus`]: 'submitted',
    [`${pathFor('reserva')}/${code}/paymentReport`]: report,
    [`unitBookings/${unitKey}/${code}/paymentStatus`]: 'submitted',
  };
  await dbUpdate(updates);
  return getReservationByCode(code);
}

async function setPaymentMethod(code, method) {
  const rec = await getReservationByCode(code);
  if (!rec) { const e = new Error('reservation-not-found'); e.code = 'not-found'; throw e; }
  if (rec.type !== 'reserva') { const e = new Error('not-a-reservation'); e.code = 'invalid'; throw e; }
  await dbSet(`${pathFor('reserva')}/${code}/paymentMethod`, method);
  return getReservationByCode(code);
}

module.exports = {
  init,
  db,
  generateCode,
  unitKeyOf,
  getCategories,
  getApartments,
  getApartment,
  getStatusMeta,
  getPaymentInfo,
  getReservationByCode,
  getUnitBookings,
  checkAvailability,
  effectiveStatus,
  createReservation,
  createSpecificVisit,
  createGeneralVisit,
  reportPayment,
  setPaymentMethod,
};
