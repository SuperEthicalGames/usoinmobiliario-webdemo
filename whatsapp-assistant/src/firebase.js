const admin = require('firebase-admin');
const fs = require('fs');
const config = require('../config');
const { nightsBetween, nowEpochMs, todayIsoBogota, toIsoDate, parseIsoDate } = require('./dateUtil');

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
  // En local hace falta un archivo/JSON de cuenta de servicio explícito. Corriendo dentro de
  // Cloud Functions/Cloud Run del MISMO proyecto, el SDK ya tiene credenciales automáticas
  // (Application Default Credentials) — no hay archivo que descargar ni subir, y de hecho no
  // debería subirse nunca a producción. Mismo databaseURL en ambos casos.
  const hasExplicitCredential = !!(config.firebase.serviceAccountJson || config.firebase.serviceAccountPath);
  app = admin.initializeApp({
    credential: hasExplicitCredential ? admin.credential.cert(loadServiceAccount()) : admin.credential.applicationDefault(),
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
// Un cliente real dice "H09", "habitación 09", "la 09" o "quiero la 9" — el prompt le pide a
// la IA que extraiga solo el número, pero no hay que depender de que lo haga perfecto siempre:
// esto quita cualquier letra/espacio (deja solo dígitos) antes de comparar, así "H09"/"h9"/"09"
// (con o sin cero a la izquierda) resuelven al mismo apartamento sin importar qué mandó la IA.
async function findApartmentByNum(num) {
  const digitsOnly = String(num).replace(/\D/g, '');
  if (!digitsOnly) return null;
  const target = digitsOnly.padStart(2, '0');
  const apartments = await getApartments();
  return apartments.find((a) => String(a.num).replace(/\D/g, '').padStart(2, '0') === target) || null;
}

async function getApartment(typeKey, num) {
  const snap = await dbGet(`apartments/${typeKey}_${num}`);
  if (snap.exists()) return snap.val();
  return findApartmentByNum(num);
}

// Antes esto solo se editaba a mano en la consola de Firebase (mismo motivo documentado ya en
// setPaymentInfo) — el pedido reabre esto a propósito: la sección Apartamentos del panel debía
// ser el CMS real del catálogo, no un dashboard de solo lectura.
//
// `status`/`isVisible` van SIEMPRE (aunque no vengan en el patch) para no dejarlos en un
// estado ambiguo: status nunca debe faltar (rompe effectiveStatus/catalog), isVisible ausente
// se trata como true en todo lector, así que se normaliza a un booleano explícito en cuanto se
// toca la unidad desde acá, en vez de dejarlo implícito para siempre.
// Mismo criterio que isSafeProofUrl en app.js:339 (URL admin-supplied que termina en un
// atributo HTML sin escapar del lado del sitio público) — largo acotado y sin comillas/ángulos
// que puedan escapar el atributo `src="..."`. A diferencia de isSafeProofUrl, acá también se
// acepta una ruta relativa `media/...` (nunca solo https) porque las fotos ya existentes de
// seed-apartments.json viven así (archivos reales del repo, no URLs); las fotos NUEVAS que
// suba el CMS sí serán siempre https (Cloudinary).
function isSafeMediaUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length >= 2000) return false;
  if (/["'<>]/.test(url)) return false;
  return /^https:\/\//.test(url) || /^media\//.test(url);
}
function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita tildes (NFD deja la tilde como diacrítico combinante aparte)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function sanitizeBilingual(v) {
  return { es: String(v?.es ?? '').trim(), en: String(v?.en ?? '').trim() };
}
// rooms (fotos + descripción de cada ambiente) son POR APARTAMENTO, no por categoría — decisión
// 2026-09-13: aunque dos unidades compartan categoría ("estudio"), cada una es una distribución
// real distinta, así que un modelo compartido no sirve para describirlas. Se reemplaza COMPLETO
// (mismo criterio que rates) — el editor del middleware siempre manda el array entero, nunca un
// merge parcial que podría mezclar rooms viejos y nuevos en un orden inconsistente.
function sanitizeRooms(rooms) {
  if (!Array.isArray(rooms)) { const e = new Error('invalid-rooms'); e.code = 'invalid'; throw e; }
  const usedSlugs = new Set();
  return rooms.map((r, i) => {
    if (!isSafeMediaUrl(r?.img) || !isSafeMediaUrl(r?.thumb)) {
      const e = new Error('invalid-room-photo'); e.code = 'invalid'; throw e;
    }
    let slug = slugify(r?.slug) || slugify(r?.name?.es) || `room-${i}`;
    while (usedSlugs.has(slug)) slug = `${slug}-${i}`;
    usedSlugs.add(slug);
    return {
      slug, img: r.img, thumb: r.thumb, area: String(r?.area ?? '').trim(),
      name: sanitizeBilingual(r?.name), tag: sanitizeBilingual(r?.tag), blurb: sanitizeBilingual(r?.blurb),
      features: Array.isArray(r?.features) ? r.features.map(sanitizeBilingual) : [],
    };
  });
}

const APARTMENT_STATUSES = new Set(['disponible', 'en-uso', 'reservado']);
function sanitizeApartmentPatch(data, existing) {
  const out = { ...existing };
  if (data.status !== undefined) {
    if (!APARTMENT_STATUSES.has(data.status)) { const e = new Error('invalid-status'); e.code = 'invalid'; throw e; }
    out.status = data.status;
  }
  if (data.isVisible !== undefined) out.isVisible = !!data.isVisible;
  if (data.area !== undefined) out.area = Number(data.area) || 0;
  if (data.maxPersons !== undefined) out.maxPersons = Number(data.maxPersons) || 1;
  if (data.baths !== undefined) out.baths = Number(data.baths) || 1;
  if (data.beds !== undefined) out.beds = Array.isArray(data.beds) ? data.beds.map((b) => String(b)) : [];
  if (data.feature !== undefined) {
    out.feature = { es: String(data.feature?.es || '').trim(), en: String(data.feature?.en || '').trim() };
  }
  if (data.rates !== undefined) {
    const r = data.rates || {};
    out.rates = {
      ...(Array.isArray(r.one) ? { one: r.one.map(Number) } : {}),
      ...(Array.isArray(r.two) ? { two: r.two.map(Number) } : {}),
      ...(Array.isArray(r.extra) ? { extra: r.extra.map(Number) } : {}),
      ...(r.month != null ? { month: Number(r.month) } : {}),
    };
  }
  if (data.rooms !== undefined) out.rooms = sanitizeRooms(data.rooms);
  if (data.promo !== undefined) out.promo = !!data.promo;
  if (data.flagship !== undefined) out.flagship = !!data.flagship;
  return out;
}
async function updateApartment(typeKey, num, data) {
  const key = unitKeyOf(typeKey, num);
  const snap = await dbGet(`apartments/${key}`);
  if (!snap.exists()) { const e = new Error('not-found'); e.code = 'not-found'; throw e; }
  const updated = sanitizeApartmentPatch(data, snap.val());
  await dbSet(`apartments/${key}`, updated);
  return { ...updated, _key: key };
}
async function createApartment(typeKey, num, data) {
  const key = unitKeyOf(typeKey, num);
  const snap = await dbGet(`apartments/${key}`);
  if (snap.exists()) { const e = new Error('already-exists'); e.code = 'conflict'; throw e; }
  // isVisible:false (nunca true) — el panel crea con POST /apartments {} (sin tarifas, feature
  // ni fotos todavía, ver CreateApartmentForm en el middleware, cuyo propio texto dice "se crea
  // oculto por defecto") y feature:{es:'',en:''} + rooms:[] en vez de ausentes del todo — sin
  // esto, un apartamento recién creado y hecho visible antes de terminar de editarlo no tenía
  // `feature`, y unit.feature[LANG] en index.html (sin respaldo hasta ahora) tiraba TypeError
  // dentro del .map() que arma la grilla, tumbando el catálogo COMPLETO de esa categoría, no
  // solo la tarjeta de esa unidad — bug real visto en producción (2026-09-13). rooms:[] es
  // análogo: el sitio ya sabe mostrar "fotos próximamente" para una unidad sin rooms todavía.
  const base = {
    typeKey, num: String(num), status: 'disponible', isVisible: false,
    area: 0, maxPersons: 1, baths: 1, beds: [], feature: { es: '', en: '' }, rooms: [],
  };
  const created = sanitizeApartmentPatch(data, base);
  await dbSet(`apartments/${key}`, created);
  return { ...created, _key: key };
}

// --- Idempotencia (sección 25 del pedido, ya señalada como pendiente legítima en
// AUDITORIA_EXTERNA_2026_09.md §5) — un doble-click o un reintento de red en una operación
// administrativa no debe crear/ejecutar la acción dos veces. Reclamo atómico vía transacción
// (mismo criterio que claimNightAtomically para noches): dos requests con la MISMA clave no
// pueden ganar ambas la carrera de "quién ejecuta de verdad". Alcance de esta sesión: rutas
// admin del backend (/admin/api/*) — el sitio público escribe reservas/pagos directo a Firebase
// desde el navegador, un mecanismo distinto (fuera de alcance, ver plan). ---
// Una clave 'pending' se queda atascada para siempre solo si el proceso se cae ENTRE reclamarla
// y terminar fn() (el catch de abajo ya libera la clave en cualquier falla normal). Antes esto
// era aceptable porque el único caller era un admin autenticado reintentando a mano un botón; al
// generalizarse a una ruta pública, sin autenticar, propensa a reintentos de red reales (celular
// con mala señal), un proceso reiniciado a mitad de un request ajeno dejaría esa clave
// devolviendo 'conflict' para siempre, sin que el cliente pueda hacer nada al respecto. Una
// 'pending' con más de 30s es, en la práctica, abandonada — nada en este backend tarda tanto.
const IDEMPOTENCY_STUCK_MS = 30 * 1000;
async function withIdempotency(key, fn) {
  if (!key) return fn(); // sin clave, comportamiento de siempre — no se puede deduplicar sin ella
  const ref = db().ref(`idempotency/${key}`);
  const claim = await withTimeout(ref.transaction((current) => {
    if (current) return; // ya reclamada — abortar sin tocarla
    return { status: 'pending', createdAt: Date.now() };
  }), 'idempotency.claim');
  if (!claim.committed) {
    const existing = await dbGet(`idempotency/${key}`);
    const val = existing.val();
    if (val && val.status === 'done') return val.result;
    if (val && val.status === 'pending' && (Date.now() - val.createdAt) > IDEMPOTENCY_STUCK_MS) {
      await ref.remove().catch(() => {});
      return withIdempotency(key, fn); // reintenta el reclamo ahora que la clave quedó libre
    }
    // Todavía en vuelo (mismo request real duplicado, no un reintento tras fallo) — no bloquear
    // indefinidamente al segundo request, que reporte conflicto y el cliente decida reintentar.
    const e = new Error('duplicate-request-in-progress'); e.code = 'conflict'; throw e;
  }
  try {
    const result = await fn();
    await dbSet(`idempotency/${key}`, { status: 'done', result, createdAt: Date.now() });
    return result;
  } catch (err) {
    // La operación real falló — liberar la clave para permitir un reintento genuino del cliente
    // (no queremos que un fallo de red deje la clave "quemada" para siempre).
    await ref.remove().catch(() => {});
    throw err;
  }
}

async function getStatusMeta() {
  const snap = await dbGet('statusMeta');
  return snap.val() || {};
}

async function getPaymentInfo() {
  const snap = await dbGet('settings/paymentInfo');
  return snap.val() || null;
}

// Antes esto solo se editaba a mano en la consola de Firebase (decisión original: "el sitio
// tampoco ofrece edición, no se agrega acá" — pedido nuevo del usuario la reabre a propósito).
// Reemplaza el objeto completo — mismas 4 llaves siempre, nunca un merge parcial que pueda
// dejar mezclados datos viejos y nuevos de cuentas bancarias distintas.
async function setPaymentInfo({ bankName, accountHolder, accountType, accountNumber }) {
  const value = {
    bankName: String(bankName || '').trim(),
    accountHolder: String(accountHolder || '').trim(),
    accountType: String(accountType || '').trim(),
    accountNumber: String(accountNumber || '').trim(),
  };
  if (!value.bankName || !value.accountHolder || !value.accountType || !value.accountNumber) {
    const e = new Error('missing-fields'); e.code = 'invalid'; throw e;
  }
  await dbSet('settings/paymentInfo', value);
  return value;
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

// Barrido periódico de HOLDs vencidos — hasta ahora la única forma de liberar un HOLD vencido
// era un cliente anónimo escribiendo bookedNights=null como efecto secundario de leer
// disponibilidad (reclaimExpiredHold arriba, disparado desde checkNight/getOccupiedDates en el
// sitio público). Una vez que las Rules dejen de permitir esa escritura anónima (ver plan de
// migración de reservas), esa habría sido la ÚNICA forma de liberar un HOLD abandonado — sin
// este barrido, cada reserva no pagada que expira dejaría sus noches bloqueadas para siempre
// (nadie volvería a "tropezar" con ellas leyendo disponibilidad para ESE unit exacto). Recorre
// TODO unitBookings (17 apartamentos, decenas de reservas — a esta escala un solo fetch es más
// simple que una query indexada) y reclama cualquier HOLD que isHoldExpired() marque.
async function sweepExpiredHolds() {
  const allBookings = await getAllUnitBookings();
  const nowMs = nowEpochMs();
  for (const [unitKey, bookings] of Object.entries(allBookings)) {
    for (const booking of Object.values(bookings || {})) {
      if (isHoldExpired(booking, nowMs) && booking.checkin && booking.checkout) {
        // eslint-disable-next-line no-await-in-loop
        await reclaimExpiredHold(unitKey, booking.checkin, booking.checkout);
      }
    }
  }
}

// Arrancado una sola vez desde app.js (mismo patrón que conversationStore.startCleanupLoop) —
// 5 minutos alcanza de sobra para un HOLD de 15.
function startHoldSweepLoop() {
  setInterval(() => {
    sweepExpiredHolds().catch((err) => console.error('[firebase] sweepExpiredHolds falló:', err));
  }, 5 * 60 * 1000).unref();
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
// AvailabilityService.EffectiveStatus.
//
// ANTES: solo contaba reservas CONFIRMADAS — una reserva recién creada por un cliente real
// (pendiente, con su HOLD de 15 min todavía corriendo) no cambiaba nada acá, así que el
// apartamento seguía viéndose "disponible" en el sitio y en el panel mientras el cliente ya
// estaba a mitad de una reserva real y el admin no la hubiera confirmado a mano todavía.
// Bug real reportado: "el sistema no actualiza el estado en el flujo del cliente". Ahora un
// HOLD 'pendiente' vigente (no vencido, ver isHoldExpired) cuenta exactamente igual que una
// confirmada — el estado cambia en cuanto el cliente crea la reserva, no cuando el admin la
// aprueba. Uno rechazado/cancelado o un HOLD ya vencido nunca cuenta (mismo criterio de
// siempre), así que un abandono no deja el apartamento "atascado" como ocupado.
function effectiveStatus(apartment, unitBookings, todayIso) {
  if (!apartment) return null;
  const bookings = Object.values(unitBookings || {});
  if (bookings.length === 0) return apartment.status;
  let hasActive = false;
  let hasFuture = false;
  const nowMs = nowEpochMs();
  for (const b of bookings) {
    if (!b || b.type !== 'reserva') continue;
    const isLiveHold = b.status === 'pendiente' && !isHoldExpired(b, nowMs);
    if (b.status !== 'confirmada' && !isLiveHold) continue;
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

// Liberar SOLO si el nodo todavía es de este código — mismo criterio de "todo o nada" que
// claimNightAtomically/claimSlotAtomically, pero para el camino inverso. Sin este chequeo
// (bug real encontrado en auditoría), un reject/cancel duplicado sobre el mismo code (doble
// clic, o un reintento de red tras una respuesta lenta) volvía a poner en null las mismas
// noches/turno en su segunda pasada — si en el intervalo alguien más ya las había reclamado
// legítimamente para OTRA reserva, ese segundo reject les borraba el cupo sin ningún aviso ni
// error, produciendo un choque de fechas real que el resto del archivo existe para evitar.
async function releaseNightIfOwned(unitKey, night, code) {
  await dbTransaction(`bookedNights/${unitKey}/${night}`, (current) => (current === code ? null : undefined));
}
async function releaseSlotIfOwned(unitKey, slotKey, code) {
  await dbTransaction(`bookedVisitSlots/${unitKey}/${slotKey}`, (current) => (current === code ? null : undefined));
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

// Mismo guardado condicional que hacía la regla de Firebase para este campo
// (auth != null || !data.exists() — escritura anónima de una sola vez), replicado acá porque
// Admin SDK no pasa por esa regla. Sin este chequeo (hallazgo real al generalizar esta función
// para la ruta pública nueva), cualquiera con el código podía cambiar el método de pago ida y
// vuelta después de que el cliente ya se hubiera decidido — antes las Rules lo impedían solas.
async function setPaymentMethod(code, method) {
  const rec = await getReservationByCode(code);
  if (!rec) { const e = new Error('reservation-not-found'); e.code = 'not-found'; throw e; }
  if (rec.type !== 'reserva') { const e = new Error('not-a-reservation'); e.code = 'invalid'; throw e; }
  if (rec.paymentMethod) { const e = new Error('payment-method-already-set'); e.code = 'invalid'; throw e; }
  await dbSet(`${pathFor('reserva')}/${code}/paymentMethod`, method);
  return getReservationByCode(code);
}

// --- Acciones administrativas (panel web, nunca alcanzables desde la IA) ---
// Puerto directo de ReservationLifecycleService/IReservationRepository/PaymentService en
// Unity (ya validados, no se inventa lógica nueva) y de setReservationStatus en
// firebase/FirebaseDataProvider.js (libera bookedNights/bookedVisitSlots al rechazar/
// cancelar, para no dejar fechas bloqueadas para siempre). Estas funciones NUNCA se exponen
// en businessTools.js — solo las llaman las rutas /admin/api/*, protegidas por adminAuth.js.

// Cambia status y, salvo en una cita general (que nunca reclama unitBookings/bookedNights/
// bookedVisitSlots — no hay unidad que liberar), espeja el cambio en unitBookings y libera
// las noches/turno ocupados si el resultado es rechazada/cancelada.
async function setReservationStatus(code, status) {
  const rec = await getReservationByCode(code);
  if (!rec) { const e = new Error('reservation-not-found'); e.code = 'not-found'; throw e; }

  const updates = { [`${pathFor(rec.type)}/${code}/status`]: status };
  const isGeneralVisit = rec.type === 'cita' && rec.appointmentType === 'general_visit';
  const shouldRelease = !isGeneralVisit && rec.unitType && rec.unitNum && (status === 'rechazada' || status === 'cancelada');
  if (!isGeneralVisit && rec.unitType && rec.unitNum) {
    const unitKey = unitKeyOf(rec.unitType, rec.unitNum);
    updates[`unitBookings/${unitKey}/${code}/status`] = status;
    await dbUpdate(updates);
    // Liberar noches/turno DESPUÉS del update de status, y solo si siguen siendo de este
    // code — ver releaseNightIfOwned/releaseSlotIfOwned arriba, así un reject/cancel
    // duplicado no le borra el cupo a una reserva distinta que ya reclamó esas mismas fechas.
    if (shouldRelease) {
      const unitKeyForRelease = unitKeyOf(rec.unitType, rec.unitNum);
      if (rec.type === 'reserva') {
        for (const n of nightsBetween(rec.checkin, rec.checkout)) {
          await releaseNightIfOwned(unitKeyForRelease, n, code);
        }
      } else {
        await releaseSlotIfOwned(unitKeyForRelease, `${rec.visitDate}_${rec.visitTime}`, code);
      }
    }
  } else {
    await dbUpdate(updates);
  }
  return getReservationByCode(code);
}
const confirmReservation = (code) => setReservationStatus(code, 'confirmada');
const rejectReservation = (code) => setReservationStatus(code, 'rechazada');
const cancelReservation = (code) => setReservationStatus(code, 'cancelada');
const completeReservation = (code) => setReservationStatus(code, 'completada');

async function setPaymentVerification(code, paymentStatus) {
  const rec = await getReservationByCode(code);
  if (!rec) { const e = new Error('reservation-not-found'); e.code = 'not-found'; throw e; }
  if (rec.type !== 'reserva') { const e = new Error('not-a-reservation'); e.code = 'invalid'; throw e; }
  // setReservationStatus nunca toca paymentStatus al rechazar/cancelar (bug relacionado
  // encontrado en la misma auditoría) — sin este guard, se podía "verificar"/"rechazar" el
  // pago de una reserva que ya no existe en la práctica, y esa reserva muerta se quedaba
  // apareciendo para siempre en "pagos por verificar" del dashboard/Pagos.
  if (rec.status === 'rechazada' || rec.status === 'cancelada') {
    // BUG REAL preexistente (encontrado al agregar check-in/check-out con el mismo mecanismo):
    // .code quedaba en 'invalid' genérico en vez de 'reservation-not-active' — el panel YA
    // tiene un mensaje específico para ese código exacto (api.ts, API_ERROR_MESSAGES), pero
    // nunca podía dispararse porque el backend jamás mandaba ese string, solo 'invalid'.
    const e = new Error('reservation-not-active'); e.code = 'reservation-not-active'; throw e;
  }
  const unitKey = unitKeyOf(rec.unitType, rec.unitNum);
  const updates = {
    [`${pathFor('reserva')}/${code}/paymentStatus`]: paymentStatus,
    [`unitBookings/${unitKey}/${code}/paymentStatus`]: paymentStatus,
  };
  await dbUpdate(updates);
  return getReservationByCode(code);
}
const verifyPayment = (code) => setPaymentVerification(code, 'verified');
const rejectPayment = (code) => setPaymentVerification(code, 'rejected');

// El efectivo nunca pasa por 'submitted' (el cliente no reporta nada por su cuenta) — el
// admin confirma en persona que recibió el dinero, saltando directo a 'verified'. Mismo
// contrato exacto que PaymentService.RegisterCashPaymentAsync en Unity: sin monto, sin
// paymentReport (eso es solo para transferencias, donde el cliente sí llena un formulario).
async function registerCashPayment(code) {
  const rec = await getReservationByCode(code);
  if (!rec) { const e = new Error('reservation-not-found'); e.code = 'not-found'; throw e; }
  if (rec.type !== 'reserva') { const e = new Error('not-a-reservation'); e.code = 'invalid'; throw e; }
  if (rec.paymentMethod !== 'cash') { const e = new Error('not-cash-payment'); e.code = 'invalid'; throw e; }
  return setPaymentVerification(code, 'verified');
}

// --- Lecturas administrativas: traen todo y filtran en memoria, mismo patrón que ya usa
// getApartments() — sin precedente de orderByChild/equalTo en este proyecto, y a esta escala
// (17 apartamentos, decenas de reservas) no hace falta. Devuelven los registros completos
// (no la proyección angosta de getReservationTool en businessTools.js, pensada para la IA) —
// la pantalla de Pagos necesita paymentReport/priceSnapshot. ---

async function listReservations() {
  const snap = await dbGet('reservationsManager/reservations');
  return Object.values(snap.val() || {});
}

async function listVisits() {
  const snap = await dbGet('reservationsManager/visits');
  return Object.values(snap.val() || {});
}

async function getAllUnitBookings() {
  const snap = await dbGet('unitBookings');
  return snap.val() || {};
}

// Apartamento + su status EFECTIVO (mismo effectiveStatus() de arriba, ya escrito, antes sin
// ningún caller — ver auditoría) — un solo fetch de unitBookings para las 17 unidades, no uno
// por unidad.
async function listApartmentsWithEffectiveStatus() {
  const [apartments, allBookings] = await Promise.all([getApartments(), getAllUnitBookings()]);
  const todayIso = todayIsoBogota();
  return apartments.map((apt) => ({
    ...apt,
    effectiveStatus: effectiveStatus(apt, allBookings[unitKeyOf(apt.typeKey, apt.num)], todayIso),
  }));
}

// Puerto directo de DashboardService.GetSummaryAsync (Unity) — mismos 3 bloques, cada uno con
// su propio try/catch (una regla de Firebase todavía no publicada para "visits" no debe tumbar
// el resto del panel, solo dejar esa sección vacía; ya pasó exactamente esto en Unity).
async function getDashboardSummary() {
  const summary = {
    availableCount: 0, inUseCount: 0, reservedCount: 0,
    pendingReservations: 0, confirmedReservations: 0,
    activeHolds: 0, pendingPaymentVerifications: 0,
    upcomingVisits: [],
    // Sección "Operación" (2026-09-14) — todo reusa datos/listas que ya existían para sus
    // propias pantallas (Pagos/Aseo/Mantenimiento/Contratos/Apartamentos), esto solo los cuenta.
    apartmentsNeedingRealPhotos: 0, pendingCashPayments: 0,
    cleaningPending: 0, maintenanceOpen: 0, contractsExpiringSoon: 0,
  };
  const todayIso = todayIsoBogota();

  try {
    const [apartments, allBookings] = await Promise.all([getApartments(), getAllUnitBookings()]);
    for (const apt of apartments) {
      const effective = effectiveStatus(apt, allBookings[unitKeyOf(apt.typeKey, apt.num)], todayIso);
      if (effective === 'disponible') summary.availableCount++;
      else if (effective === 'en-uso') summary.inUseCount++;
      else if (effective === 'reservado') summary.reservedCount++;
      // "Necesita fotos reales" = tiene ambientes pero NINGUNO tiene todavía una foto https
      // real (Cloudinary) — las fotos de vista previa copiadas el 2026-09-14 viven como ruta
      // relativa `media/...`. En cuanto se suba UNA foto real a cualquier ambiente, deja de
      // contar acá aunque falten las demás (evita que "a medias" quede pendiente para siempre).
      const rooms = apt.rooms || [];
      if (rooms.length > 0 && !rooms.some((r) => /^https:\/\//.test(r.img || ''))) {
        summary.apartmentsNeedingRealPhotos++;
      }
    }
  } catch (err) {
    console.error('[firebase] getDashboardSummary: no se pudieron cargar apartamentos', err);
  }

  let reservationsForCash = [];
  try {
    const reservations = await listReservations();
    reservationsForCash = reservations;
    const nowMs = nowEpochMs();
    for (const r of reservations) {
      if (r.status === 'pendiente') summary.pendingReservations++;
      else if (r.status === 'confirmada') summary.confirmedReservations++;
      if (r.status === 'pendiente' && r.expiresAt && r.paymentStatus !== 'submitted' && r.expiresAt >= nowMs) {
        summary.activeHolds++;
      }
      // setReservationStatus no limpia paymentStatus al rechazar/cancelar — sin excluir esos
      // dos estados acá, una reserva ya muerta con un pago reportado antes de rechazarse se
      // quedaba contando como "pago por verificar" para siempre (bug real encontrado en
      // auditoría, mismo motivo por el que setPaymentVerification ahora bloquea actuar sobre
      // una reserva rechazada/cancelada).
      if (r.paymentStatus === 'submitted' && r.status !== 'rechazada' && r.status !== 'cancelada') summary.pendingPaymentVerifications++;
    }
  } catch (err) {
    console.error('[firebase] getDashboardSummary: no se pudieron cargar reservas', err);
  }

  try {
    const visits = await listVisits();
    // 'pendiente' (esperando que el admin la confirme) Y 'confirmada' (ya va a pasar de
    // verdad) — antes solo entraba 'pendiente', así que una visita YA confirmada a futuro
    // desaparecía de "Próximas visitas" justo cuando más importa mostrarla (bug real: se
    // encontró una visita confirmada para 2027-01-10 que el dashboard ocultaba por completo).
    // 'rechazada'/'cancelada'/'completada' quedan fuera — ya no van a pasar o ya pasaron.
    summary.upcomingVisits = visits
      .filter((v) => (v.status === 'pendiente' || v.status === 'confirmada') && v.visitDate && v.visitDate >= todayIso)
      .sort((a, b) => (a.visitDate + a.visitTime).localeCompare(b.visitDate + b.visitTime))
      .slice(0, 10);
  } catch (err) {
    console.error('[firebase] getDashboardSummary: no se pudieron cargar visitas', err);
  }

  // Mismo criterio que isPendingCash en el panel (Payments.tsx) — reusa la lista de reservas ya
  // cargada arriba en vez de pedirla de nuevo.
  try {
    for (const r of reservationsForCash) {
      if (r.type === 'reserva' && r.paymentMethod === 'cash' && r.paymentStatus === 'none'
        && r.status !== 'rechazada' && r.status !== 'cancelada') {
        summary.pendingCashPayments++;
      }
    }
  } catch (err) {
    console.error('[firebase] getDashboardSummary: no se pudo calcular efectivo pendiente', err);
  }

  try {
    const [cleaning, maintenance, contracts] = await Promise.all([
      listCleaningTasks(), listMaintenanceTickets(), listContracts(),
    ]);
    summary.cleaningPending = cleaning.filter((t) => t.status === 'pendiente').length;
    summary.maintenanceOpen = maintenance.filter((t) => t.status !== 'resuelto').length;
    const in30Days = toIsoDate(new Date(parseIsoDate(todayIso).getTime() + 30 * 24 * 60 * 60 * 1000));
    summary.contractsExpiringSoon = contracts.filter((c) =>
      c.status === 'activo' && c.endDate && c.endDate >= todayIso && c.endDate <= in30Days).length;
  } catch (err) {
    console.error('[firebase] getDashboardSummary: no se pudo cargar aseo/mantenimiento/contratos', err);
  }

  return summary;
}

// --- Gestión de administradores (solo el super admin llega hasta acá, ver
// adminAuth.requireSuperAdmin) — usa Firebase Auth directo (admin.auth()), no Realtime
// Database. "Revocar" es deshabilitar (admin.auth().updateUser disabled:true), no borrar: es
// reversible, y verifyIdToken ya rechaza el token de una cuenta deshabilitada en la siguiente
// petición (no hace falta esperar a que expire solo). Crear un admin nuevo NUNCA puede volverlo
// super admin — eso depende únicamente de que su correo coincida con config.superAdminEmail,
// algo que quien lo crea no controla al llenar un formulario. ---

async function listAdminUsers() {
  const result = await admin.auth().listUsers(1000);
  return result.users.map((u) => ({
    uid: u.uid,
    email: u.email,
    disabled: u.disabled,
    createdAt: u.metadata.creationTime,
    lastSignInAt: u.metadata.lastSignInTime || null,
  }));
}

async function createAdminUser(email, password) {
  const user = await admin.auth().createUser({ email: String(email).trim(), password: String(password) });
  return { uid: user.uid, email: user.email, disabled: false, createdAt: user.metadata.creationTime, lastSignInAt: null };
}

async function setAdminUserDisabled(uid, disabled) {
  const user = await admin.auth().updateUser(uid, { disabled: !!disabled });
  return { uid: user.uid, email: user.email, disabled: user.disabled, createdAt: user.metadata.creationTime, lastSignInAt: user.metadata.lastSignInTime || null };
}

// --- Roles (RBAC) — OWNER nunca vive acá, es siempre config.superAdminEmail comparado en
// adminAuth.attachRole (decisión ya tomada en SECURITY.md, no reabierta). Este nodo solo
// distingue 'employee' de 'admin' para el resto de las cuentas; ausencia de documento =
// 'admin' (compatibilidad hacia atrás con cuentas creadas antes de que RBAC existiera). ---
async function getUserRole(uid) {
  const snap = await dbGet(`roles/${uid}`);
  const val = snap.val();
  return val ? val.role : null;
}
async function setUserRole(uid, role, actorEmail) {
  await dbSet(`roles/${uid}`, { role, createdAt: new Date().toISOString(), createdBy: actorEmail || null });
  return { uid, role };
}
// Crea la cuenta de Firebase Auth (misma función de siempre) y le adjunta un rol explícito —
// usado tanto para admins operativos como para empleados, la única diferencia es el rol.
async function createStaffUser(email, password, role, actorEmail) {
  const user = await createAdminUser(email, password);
  await setUserRole(user.uid, role, actorEmail);
  return { ...user, role };
}
// Fusiona las cuentas reales de Firebase Auth con su rol — el dueño nunca aparece con un
// documento en roles/, se deriva comparando el email igual que attachRole.
async function listUsersWithRoles() {
  const [authUsers, rolesSnap] = await Promise.all([listAdminUsers(), dbGet('roles')]);
  const roles = rolesSnap.val() || {};
  return authUsers.map((u) => ({
    ...u,
    role: u.email === config.superAdminEmail ? 'owner' : (roles[u.uid] && roles[u.uid].role === 'employee' ? 'employee' : 'admin'),
  }));
}

// --- Notificaciones — un nodo por destinatario (nunca compartido entre cuentas, cada quien
// solo puede leer/marcar las suyas — ver requireRole+chequeo de dueño en adminRoutes.js). Se
// crean desde el servidor únicamente (ej. al asignar una tarea de aseo/mantenimiento), nunca
// directo desde el cliente. ---
async function createNotification(uid, { type, message, targetCode }) {
  const ref = db().ref(`notifications/${uid}`).push();
  const entry = { type, message, targetCode: targetCode || null, read: false, createdAt: new Date().toISOString() };
  await withTimeout(ref.set(entry), 'notification.create');
  return { id: ref.key, ...entry };
}
async function listNotificationsForUser(uid, limit) {
  const snap = await withTimeout(db().ref(`notifications/${uid}`).orderByKey().limitToLast(limit || 50).get(), 'notifications.list');
  const val = snap.val() || {};
  return Object.entries(val).map(([id, entry]) => ({ id, ...entry })).reverse();
}
async function markNotificationRead(uid, id) {
  await dbSet(`notifications/${uid}/${id}/read`, true);
}

// --- Contratos (arriendo formal — cubre estadías largas que van más allá de una reserva
// corta con HOLD; el mismo apartamento puede tener reservas Y un contrato activo, ninguno de
// los dos bloquea al otro automáticamente, es el admin quien concilia fechas a mano). ---

async function createContract(data) {
  const code = generateCode();
  const rec = {
    code,
    unitType: data.unitType, unitNum: data.unitNum, unitLabel: data.unitLabel,
    tenantName: String(data.tenantName || '').trim(),
    tenantPhone: String(data.tenantPhone || '').trim(),
    tenantEmail: String(data.tenantEmail || '').trim(),
    startDate: data.startDate, endDate: data.endDate,
    monthlyRent: Number(data.monthlyRent) || 0,
    depositAmount: Number(data.depositAmount) || 0,
    documentUrl: data.documentUrl ? String(data.documentUrl).trim() : '',
    notes: data.notes ? String(data.notes).trim() : '',
    status: 'activo',
    createdAt: new Date().toISOString(),
    createdBy: data.createdBy || '',
  };
  await dbSet(`contracts/${code}`, rec);
  return rec;
}
async function listContracts() {
  const snap = await dbGet('contracts');
  return Object.values(snap.val() || {});
}
async function setContractStatus(code, status) {
  const snap = await dbGet(`contracts/${code}`);
  if (!snap.exists()) { const e = new Error('not-found'); e.code = 'not-found'; throw e; }
  await dbSet(`contracts/${code}/status`, status);
  return { ...snap.val(), status };
}

// --- Aseo (tareas de limpieza de turnover — entre huéspedes) ---

async function createCleaningTask(data) {
  const code = generateCode();
  const rec = {
    code,
    unitType: data.unitType, unitNum: data.unitNum, unitLabel: data.unitLabel,
    scheduledDate: data.scheduledDate,
    assignedTo: data.assignedTo ? String(data.assignedTo).trim() : '',
    relatedReservationCode: data.relatedReservationCode || '',
    notes: data.notes ? String(data.notes).trim() : '',
    status: 'pendiente',
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  await dbSet(`cleaningTasks/${code}`, rec);
  return rec;
}
async function listCleaningTasks() {
  const snap = await dbGet('cleaningTasks');
  return Object.values(snap.val() || {});
}
async function getCleaningTaskByCode(code) {
  const snap = await dbGet(`cleaningTasks/${code}`);
  return snap.exists() ? snap.val() : null;
}
async function setCleaningStatus(code, status) {
  const task = await getCleaningTaskByCode(code);
  if (!task) { const e = new Error('not-found'); e.code = 'not-found'; throw e; }
  const updates = { [`cleaningTasks/${code}/status`]: status };
  if (status === 'completado') updates[`cleaningTasks/${code}/completedAt`] = new Date().toISOString();
  await dbUpdate(updates);
  return { ...task, status, completedAt: status === 'completado' ? new Date().toISOString() : task.completedAt };
}

// --- Mantenimiento (fallas/pedidos reportados sobre un apartamento) ---

async function createMaintenanceTicket(data) {
  const code = generateCode();
  const rec = {
    code,
    unitType: data.unitType, unitNum: data.unitNum, unitLabel: data.unitLabel,
    title: String(data.title || '').trim(),
    description: data.description ? String(data.description).trim() : '',
    priority: ['baja', 'media', 'alta'].includes(data.priority) ? data.priority : 'media',
    assignedTo: data.assignedTo ? String(data.assignedTo).trim() : '',
    status: 'abierto',
    reportedBy: data.reportedBy || '',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };
  await dbSet(`maintenanceTickets/${code}`, rec);
  return rec;
}
async function listMaintenanceTickets() {
  const snap = await dbGet('maintenanceTickets');
  return Object.values(snap.val() || {});
}
async function getMaintenanceTicketByCode(code) {
  const snap = await dbGet(`maintenanceTickets/${code}`);
  return snap.exists() ? snap.val() : null;
}
async function setMaintenanceStatus(code, status) {
  const ticket = await getMaintenanceTicketByCode(code);
  if (!ticket) { const e = new Error('not-found'); e.code = 'not-found'; throw e; }
  const updates = { [`maintenanceTickets/${code}/status`]: status };
  if (status === 'resuelto') updates[`maintenanceTickets/${code}/resolvedAt`] = new Date().toISOString();
  await dbUpdate(updates);
  return { ...ticket, status, resolvedAt: status === 'resuelto' ? new Date().toISOString() : ticket.resolvedAt };
}

// --- Check-in / check-out real (marca de hora real de cuándo el huésped de verdad llegó/se
// fue — checkin/checkout en la reserva son solo las fechas PLANEADAS). Capa puramente
// aditiva sobre el estado ya existente: no reemplaza confirmar/completar, solo lo acompaña. ---

async function checkInReservation(code) {
  const rec = await getReservationByCode(code);
  if (!rec) { const e = new Error('reservation-not-found'); e.code = 'not-found'; throw e; }
  if (rec.type !== 'reserva') { const e = new Error('not-a-reservation'); e.code = 'not-a-reservation'; throw e; }
  if (rec.status !== 'confirmada') { const e = new Error('reservation-not-confirmed'); e.code = 'reservation-not-confirmed'; throw e; }
  if (rec.actualCheckinAt) { const e = new Error('already-checked-in'); e.code = 'already-checked-in'; throw e; }
  await dbSet(`${pathFor('reserva')}/${code}/actualCheckinAt`, new Date().toISOString());
  return getReservationByCode(code);
}

async function checkOutReservation(code) {
  const rec = await getReservationByCode(code);
  if (!rec) { const e = new Error('reservation-not-found'); e.code = 'not-found'; throw e; }
  if (rec.type !== 'reserva') { const e = new Error('not-a-reservation'); e.code = 'not-a-reservation'; throw e; }
  if (!rec.actualCheckinAt) { const e = new Error('not-checked-in-yet'); e.code = 'not-checked-in-yet'; throw e; }
  if (rec.actualCheckoutAt) { const e = new Error('already-checked-out'); e.code = 'already-checked-out'; throw e; }
  await dbSet(`${pathFor('reserva')}/${code}/actualCheckoutAt`, new Date().toISOString());
  // Dispara automáticamente el aseo de salida — una acción real del admin (el huésped de
  // verdad se fue) debe dejar armado el siguiente paso operativo, no depender de que alguien
  // se acuerde de crearlo a mano (mismo espíritu que el resto del archivo: liberar
  // noches/turno automáticamente en vez de dejarlo como tarea manual separada).
  try {
    await createCleaningTask({
      unitType: rec.unitType, unitNum: rec.unitNum, unitLabel: rec.unitLabel,
      scheduledDate: todayIsoBogota(), relatedReservationCode: code,
      notes: 'Aseo de salida generado automáticamente al registrar el check-out.',
    });
  } catch (err) {
    console.error('[firebase] checkOutReservation: no se pudo crear la tarea de aseo automática', err);
  }
  return getReservationByCode(code);
}

// --- Tráfico del sitio público — conteo agregado por día y por página, SIN cookies, SIN IP,
// SIN ningún identificador de visitante: no se puede reconstruir quién visitó, solo cuánto. ---

function sanitizeTrafficPath(path) {
  const withoutQuery = String(path || '/').split('?')[0].split('#')[0] || '/';
  return withoutQuery.slice(0, 200).replace(/[.#$/[\]]/g, '_') || '_root';
}
async function recordPageview(path) {
  const day = todayIsoBogota();
  const key = sanitizeTrafficPath(path);
  await dbTransaction(`siteTraffic/${day}/paths/${key}`, (current) => (current || 0) + 1);
  await dbTransaction(`siteTraffic/${day}/total`, (current) => (current || 0) + 1);
}
async function getSiteTraffic(days) {
  const snap = await dbGet('siteTraffic');
  const all = snap.val() || {};
  return Object.keys(all).sort().slice(-days).map((day) => ({
    day, total: all[day].total || 0, paths: all[day].paths || {},
  }));
}

// Contador agregado (día + tipo conocido) de fallos de conectividad reales del sitio público —
// ej. un cliente que no pudo confirmar su reserva/pago porque esta sesión seguía en
// LocalDataProvider (ver index.html: window.__uso_assertConnected). `kind` viene siempre de un
// enum fijo validado en app.js, nunca texto libre del cliente — mismo criterio anti-abuso que
// sanitizeTrafficPath, pero acá no hace falta sanitizar nada porque no se acepta nada fuera del
// enum. Deja una traza real en vez de depender solo de que el cliente se queje.
async function recordClientError(kind) {
  const day = todayIsoBogota();
  await dbTransaction(`clientErrors/${day}/${kind}`, (current) => (current || 0) + 1);
}

// --- Bitácora de acciones administrativas — quién hizo qué y cuándo, sobre qué reserva/
// contrato/tarea/admin. Ningún hallazgo de seguridad depende de esto (las Rules/requireAdminAuth
// ya son la barrera real), es trazabilidad para cuando algo hay que auditar después del hecho
// (sección 34 de la auditoría externa 2026-09-11: "falta auditoría de acciones"). Nunca debe
// romper la acción real que está registrando — mejor esfuerzo, un fallo de log se traga y se
// loguea a consola, no se propaga como error 500 al panel. ---
// Separa la bitácora en "reservas" vs "financiero" vs el resto (secciones 18-19 del pedido)
// sin construir dos árboles distintos — se deriva del PREFIJO del nombre de la acción (ya
// consistente en todos los call sites de adminRoutes.js: 'reservation.*', 'payment.*', etc.),
// así que ningún call site nuevo tiene que acordarse de pasar el dominio a mano.
const ACTION_DOMAINS = {
  reservation: 'reservation', record: 'reservation',
  payment: 'financial', payment_info: 'financial',
  user: 'admin', admin: 'admin',
  apartment: 'apartment',
  contract: 'operations', cleaning: 'operations', maintenance: 'operations',
};
function domainForAction(action) {
  const prefix = String(action || '').split('.')[0];
  return ACTION_DOMAINS[prefix] || 'other';
}
async function logAdminAction({ actorUid, actorEmail, action, target, metadata }) {
  const entry = {
    actorUid: actorUid || null,
    actorEmail: actorEmail || null,
    action,
    domain: domainForAction(action),
    target: target || null,
    metadata: metadata || null,
    timestamp: nowEpochMs(),
  };
  try {
    await withTimeout(db().ref('auditLog').push(entry), `push auditLog ${action}`);
  } catch (err) {
    console.error('[firebase] no se pudo escribir auditLog (acción real ya se ejecutó, esto es solo trazabilidad):', err);
  }
}
// Trae las últimas `limit` entradas (más reciente primero) — orderByKey().limitToLast() en vez
// de traer TODO el árbol como listReservations/listContracts: a diferencia de esos, este árbol
// crece sin cota (una entrada por cada acción administrativa, para siempre), así que sí importa
// acotar la lectura desde ahora.
async function listAuditLog(limit) {
  const snap = await withTimeout(
    db().ref('auditLog').orderByKey().limitToLast(limit).get(),
    'get auditLog'
  );
  const all = snap.val() || {};
  return Object.keys(all)
    .map((id) => ({ id, ...all[id] }))
    .sort((a, b) => b.timestamp - a.timestamp);
}

module.exports = {
  init,
  db,
  generateCode,
  unitKeyOf,
  getCategories,
  getApartments,
  getApartment,
  updateApartment,
  createApartment,
  getStatusMeta,
  withIdempotency,
  sanitizeApartmentPatch,
  domainForAction,
  getPaymentInfo,
  setPaymentInfo,
  listAdminUsers,
  createAdminUser,
  setAdminUserDisabled,
  getUserRole,
  setUserRole,
  createStaffUser,
  listUsersWithRoles,
  createNotification,
  listNotificationsForUser,
  markNotificationRead,
  getReservationByCode,
  getUnitBookings,
  checkAvailability,
  effectiveStatus,
  sweepExpiredHolds,
  startHoldSweepLoop,
  createReservation,
  createSpecificVisit,
  createGeneralVisit,
  reportPayment,
  setPaymentMethod,
  setReservationStatus,
  confirmReservation,
  rejectReservation,
  cancelReservation,
  completeReservation,
  verifyPayment,
  rejectPayment,
  registerCashPayment,
  listReservations,
  listVisits,
  getAllUnitBookings,
  listApartmentsWithEffectiveStatus,
  getDashboardSummary,
  createContract,
  listContracts,
  setContractStatus,
  createCleaningTask,
  listCleaningTasks,
  getCleaningTaskByCode,
  setCleaningStatus,
  createMaintenanceTicket,
  listMaintenanceTickets,
  getMaintenanceTicketByCode,
  setMaintenanceStatus,
  checkInReservation,
  checkOutReservation,
  recordPageview,
  getSiteTraffic,
  recordClientError,
  logAdminAction,
  listAuditLog,
};
