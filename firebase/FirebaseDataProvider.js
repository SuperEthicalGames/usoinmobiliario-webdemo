// FirebaseDataProvider — Fase 3 (catálogo) + Fase 4 (reservas/citas) + sync de
// disponibilidad real / anti-doble-reserva (2026-09-04, mismo día que Fase 4).
//
// Implementa la misma forma que LocalDataProvider (ver index.html):
//   getCategoryKeys(), getCategory(typeKey), getApartments(typeKey), getStatusMeta(),
//   createReservation(rec), getReservation(code), getMyReservations(), setReservationStatus(code,status)
// para que ApartmentService/ReservationService puedan usar cualquiera de los dos sin saber
// cuál es. El catálogo (categories/apartments/statusMeta) se lee de un espejo en memoria
// (`cache`) sincronizado en tiempo real vía onValue() — por eso esas lecturas son síncronas
// aunque Firebase sea async. Las reservas son operaciones reales contra la red (crear/leer
// una reserva es una escritura/lectura puntual, no algo que tenga sentido espejar entero),
// así que esos cuatro métodos devuelven Promise, igual que su contraparte en LocalDataProvider.
//
// Cómo activarlo en index.html, una vez tengas tu firebase-config.js real:
//
//   <script type="module" src="firebase/FirebaseDataProvider.js"></script>
//
// (agrégalo antes del </body>, después del <script> principal — el orden no importa:
// los módulos siempre se ejecutan diferidos, después de que el script principal ya
// corrió y expuso window.__uso_setDataProvider). No hace falta tocar nada más del HTML.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getDatabase, ref, onValue, get, update } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

var app = initializeApp(firebaseConfig);
var db = getDatabase(app);

var cache = { categories: {}, apartments: {}, statusMeta: {}, unitBookings: {}, settings: {} };
var activated = false;

// Compartidos con index.html (LocalDataProvider vive en otro archivo/contexto de módulo,
// por eso se exponen en window en vez de importarse) — evita mantener dos copias.
var isoLocal = window.__uso_isoLocal;
var nightsBetween = window.__uso_nightsBetween;
function todayIsoLocal(){ return isoLocal(new Date()); }
function unitKeyOf(typeKey, num){ return typeKey + '_' + num; }
// Mismo criterio que LocalDataProvider.isHoldExpired: un HOLD 'pendiente' vencido sin pago
// reportado deja de contar como ocupación real.
function isHoldExpiredRecord(rec){
  return !!rec && rec.type === 'reserva' && rec.status === 'pendiente' && rec.expiresAt
    && rec.paymentStatus !== 'submitted' && rec.expiresAt < Date.now();
}

/* El estado que ve el visitante (disponible/en-uso/reservado) no puede seguir siendo un
   campo manual desconectado de las reservas reales — eso es "mentir". `apartments/{id}/status`
   sigue existiendo como control manual del admin (útil para bajar una unidad por
   mantenimiento sin necesitar una reserva formal detrás), pero acá se RECALCULA contra las
   reservas reales de esa unidad y esa versión calculada es la que gana si hay una reserva
   activa o próxima.
   ANTES: solo contaba CONFIRMADAS — un cliente real completando el flujo de reserva (HOLD
   'pendiente', todavía sin que el admin la confirme a mano) no cambiaba nada acá, así que la
   unidad seguía viéndose "disponible" para el resto de visitantes mientras esa reserva ya
   estaba en curso. Bug real reportado ("el sitio no actualiza el estado en el flujo del
   cliente"). Ahora un HOLD 'pendiente' vigente (no vencido, ver isHoldExpiredRecord) cuenta
   igual que una confirmada — rechazada/cancelada o un HOLD ya vencido nunca cuentan, así que
   un abandono no deja la unidad "atascada" como ocupada. */
function effectiveStatus(typeKey, num, rawStatus){
  var bookings = cache.unitBookings[unitKeyOf(typeKey, num)];
  if(!bookings) return rawStatus;
  var today = todayIsoLocal();
  var hasActive = false, hasFuture = false;
  Object.keys(bookings).forEach(function(code){
    var b = bookings[code];
    if(!b || b.type !== 'reserva') return;
    var isLiveHold = b.status === 'pendiente' && !isHoldExpiredRecord(b);
    if(b.status !== 'confirmada' && !isLiveHold) return;
    if(b.checkin <= today && today < b.checkout) hasActive = true;
    else if(b.checkin > today) hasFuture = true;
  });
  if(hasActive) return 'en-uso';
  if(hasFuture) return 'reservado';
  return rawStatus;
}

function apartmentsByCategory(typeKey){
  var out = [];
  Object.keys(cache.apartments).forEach(function(key){
    var apt = cache.apartments[key];
    if(!apt || apt.typeKey !== typeKey) return;
    // Ocultar del catálogo público (sección 9 del pedido) — ausente/undefined se trata como
    // visible (compatibilidad hacia atrás: unidades ya existentes nunca tuvieron este campo).
    // El middleware SIGUE viendo la unidad completa (lee /admin/api/apartments, no este
    // archivo) — ocultar es solo de cara al cliente final, nunca de cara a quien administra.
    if(apt.isVisible === false) return;
    var rates = apt.rates || {};
    out.push({
      num: apt.num, status: effectiveStatus(typeKey, apt.num, apt.status), area: apt.area, maxPersons: apt.maxPersons,
      baths: apt.baths, beds: apt.beds, feature: apt.feature,
      one: rates.one, two: rates.two, extra: rates.extra, month: rates.month,
      promo: apt.promo, flagship: apt.flagship
    });
  });
  return out;
}

/* ---------------- Reservas/citas (Fase 4) + anti-doble-reserva ----------------
   database.rules.json (ver archivo hermano) hace esto seguro sin necesitar Cloud Functions
   ni exponer nada de más:
     - reservationsManager/reservations/{code} y reservationsManager/visits/{code}: dos
       sub-árboles separados (no un único `reservations/{code}` con un campo `type` como
       único diferenciador) — refleja que reservas y citas son dos procesos de negocio
       distintos y hace la consola de Firebase más legible. Cada uno: lectura pública SOLO
       por código exacto (nadie puede "listar" y ver reservas/citas ajenas); escritura
       pública solo para CREAR; solo un admin autenticado puede modificar/cancelar un
       registro existente (Fase 6, todavía sin UI).
     - unitBookings/{unitKey}/{code}: espejo público pero SIN datos de contacto (solo
       status/type/fechas) — de lectura completa (por eso sí aparece en el onValue de "/" y
       alimenta effectiveStatus arriba), para que el catálogo pueda mostrar disponibilidad
       real sin exponer nombre/teléfono de nadie.
     - bookedNights/{unitKey}/{fecha} y bookedVisitSlots/{unitKey}/{fecha_hora}: un nodo por
       noche/turno ocupado, de solo-crear (`!data.exists()`). La CREACIÓN de una reserva
       escribe reservations + unitBookings + estos nodos en UNA sola llamada a update() con
       varias rutas — Firebase valida las rutas de un update() multi-ruta de forma atómica
       (todo o nada), así que si alguna noche/turno ya estaba tomado, el update ENTERO se
       rechaza — ninguna reserva queda "a medias" y dos reservas no pueden ganar la misma
       fecha aunque lleguen casi al mismo tiempo. Esto es lo que garantiza "no doble reserva
       / no doble cita" de verdad, no solo una validación del lado del navegador.
       IMPORTANTE (corregido 2026-09-12, ver AUDITORIA_EXTERNA_2026_09.md hallazgo #2): antes de
       esta fecha, `!data.exists()` bastaba para CREAR un nodo en bookedNights/bookedVisitSlots
       con cualquier código inventado, sin que existiera ningún unitBookings/reservation real
       detrás. Eso no era solo una reserva falsa (que igual expiraría) — era un candado
       PERMANENTE: sin un unitBookings real con `expiresAt`, ni reclaimExpiredHold() (arriba) ni
       la condición de reclamo de la regla de bookedNights podían liberarlo nunca. Las reglas
       ahora exigen, dentro del mismo update() atómico, que el código escrito en bookedNights/
       bookedVisitSlots corresponda a un unitBookings real (tipo y fechas/turno coincidentes), y
       que ESE unitBookings corresponda a su vez a una reservationsManager/reservations o
       /visits real (mismo code, unitType/unitNum coincidentes con $unitKey) — o sea, ya no basta
       con escribir un nodo suelto, hay que crear una reserva/cita completa y válida (con nombre/
       teléfono/correo, aunque sean inventados) para bloquear una fecha, exactamente el mismo
       costo que ya tenía el flujo legítimo, así que ninguna reserva real deja de funcionar. */

// reservationsManager/reservations/{code} y reservationsManager/visits/{code} — separados
// en dos sub-árboles distintos (en vez de un único `reservations/{code}` con un campo
// `type` como único diferenciador) para que la estructura misma refleje que son dos
// procesos de negocio distintos, más fácil de navegar en la consola de Firebase y de
// asegurar por separado en las rules. `type` se sigue guardando dentro del registro (no solo
// implícito por la ruta) para que el resto del código (BOOKING, renderReservationSummary,
// etc.) siga leyendo `res.type` exactamente igual que antes — cero cambios en la UI por esto.
function pathFor(type){ return type === 'cita' ? 'reservationsManager/visits' : 'reservationsManager/reservations'; }

var MY_CODES_KEY = 'usoInmobiliario_misCodigos_v1';
function loadMyCodes(){
  try{ var raw = localStorage.getItem(MY_CODES_KEY); return raw ? JSON.parse(raw) : []; }catch(e){ return []; }
}
function rememberMyCode(code, type){
  try{
    var list = loadMyCodes();
    list.unshift({code: code, type: type});
    localStorage.setItem(MY_CODES_KEY, JSON.stringify(list));
  }catch(e){}
}

// El reclamo oportunista de un HOLD vencido (poner bookedNights=null) YA NO vive acá — era la
// única escritura anónima que le quedaba a este archivo, y ahora un barrido periódico en el
// backend (firebase.js: sweepExpiredHolds/startHoldSweepLoop) hace ese trabajo de forma
// confiable para TODA la base, no solo para la unidad que alguien esté mirando en este momento
// (ver plan de migración de reservas). Estas dos lecturas siguen filtrando un HOLD vencido para
// no bloquear al usuario que consulta — simplemente ya no intentan "limpiarlo" ellas mismas.
//
// Una noche con un nodo en bookedNights parece ocupada, pero si el HOLD dueño ya venció sin
// pago reportado ya no cuenta como bloqueo real — se confirma leyendo unitBookings/{unitKey}/
// {code} (público, sin datos de contacto) por el código que aparece en bookedNights. Devuelve
// {free} o {free:false, reason} — reason distingue una reserva ya CONFIRMADA de un HOLD todavía
// pendiente (sección 22 del pedido: la disponibilidad debe poder explicar por qué no).
function checkNightFree(unitKey, night){
  return get(ref(db, 'bookedNights/' + unitKey + '/' + night)).then(function(snap){
    if(!snap.exists()) return { free: true };
    var code = snap.val();
    return get(ref(db, 'unitBookings/' + unitKey + '/' + code)).then(function(ubSnap){
      var ub = ubSnap.exists() ? ubSnap.val() : null;
      if(isHoldExpiredRecord(ub)) return { free: true };
      var reason = (ub && ub.status === 'confirmada') ? 'confirmed_reservation' : 'temporary_hold';
      return { free: false, reason: reason };
    });
  });
}
// Agrega el resultado de todas las noches del rango en un solo {available, reason}. Si hay
// alguna noche bloqueada por una reserva CONFIRMADA, esa es la razón que se reporta (es la
// más "definitiva"); si no, se reporta que hay un HOLD temporal en el camino.
function checkNightsFree(unitKey, nights){
  return Promise.all(nights.map(function(n){ return checkNightFree(unitKey, n); }))
    .then(function(results){
      var blocked = results.filter(function(r){ return !r.free; });
      if(!blocked.length) return { available: true };
      var reason = blocked.some(function(r){ return r.reason === 'confirmed_reservation'; })
        ? 'confirmed_reservation' : 'temporary_hold';
      return { available: false, reason: reason };
    });
}
function checkSlotFree(unitKey, slotKey){
  return get(ref(db, 'bookedVisitSlots/' + unitKey + '/' + slotKey)).then(function(snap){ return !snap.exists(); });
}
// Disponibilidad real para un rango de fechas, expuesta a AvailabilityService para que el
// calendario del modal la consulte en vivo mientras el usuario elige fechas.
function checkAvailability(typeKey, num, checkinIso, checkoutIso){
  var unitKey = unitKeyOf(typeKey, num);
  var nights = nightsBetween(checkinIso, checkoutIso);
  return checkNightsFree(unitKey, nights);
}
// Mapa {fechaIso: 'confirmed_reservation'|'temporary_hold'} de TODAS las noches ya ocupadas
// de una unidad, calculado directo del espejo `cache.unitBookings` (ya sincronizado en
// tiempo real vía onValue, ver abajo) — sin llamada de red adicional, y se mantiene al día
// mientras el visitante tiene el calendario abierto. Alimenta el calendario del modal para
// pintar cada día como ocupado/disponible en vez de solo avisar tras elegir un rango inválido.
function getOccupiedDates(typeKey, num){
  var unitKey = unitKeyOf(typeKey, num);
  var bookings = cache.unitBookings[unitKey] || {};
  var out = {};
  Object.keys(bookings).forEach(function(code){
    var b = bookings[code];
    if(!b || b.type !== 'reserva' || b.status === 'rechazada' || b.status === 'cancelada') return;
    if(isHoldExpiredRecord(b)) return;
    var reason = b.status === 'confirmada' ? 'confirmed_reservation' : 'temporary_hold';
    nightsBetween(b.checkin, b.checkout).forEach(function(n){
      if(out[n] !== 'confirmed_reservation') out[n] = reason;
    });
  });
  return Promise.resolve(out);
}

// El backend (whatsapp-assistant) es ahora el único que escribe reservas/citas/pagos — para
// TODOS los canales, no solo WhatsApp/chat (ver plan de migración de reservas). Esta función ya
// no toca Firebase directo: solo arma el POST y traduce la respuesta, exactamente la misma
// forma/errores que antes para que ReservationService/VisitService/BOOKING en index.html no
// necesiten ningún cambio. El backend recalcula code/status/expiresAt/paymentStatus/estTotal/
// priceSnapshot server-side (nunca confía en lo que mande este `rec`) y reclama las noches con
// transacciones reales — la garantía de anti-doble-reserva ya no depende de las Rules de
// Firebase para este camino.
function backendUrl(path){ return (window.__uso_backendBaseUrl || '') + path; }
function postToBackend(path, body, idempotencyKey){
  var headers = { 'Content-Type': 'application/json' };
  if(idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return fetch(backendUrl(path), { method: 'POST', headers: headers, body: JSON.stringify(body) })
    .then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if(res.ok) return data;
        var err = new Error(data.error || ('http-' + res.status));
        err.code = data.error || ('http-' + res.status);
        if(data.missingFields) err.missingFields = data.missingFields;
        throw err;
      });
    });
}

function createReservation(rec){
  var path = rec.type === 'cita' ? '/visits' : '/reservations';
  return postToBackend(path, rec, rec.idempotencyKey).then(function(created){
    // El código real es el que el backend generó (fb.generateCode() del lado del servidor,
    // con chequeo de colisión) — YA NO es necesariamente rec.code (el que este navegador
    // había armado solo para tener algo que mandar). Usar rec.code acá guardaría el código
    // equivocado en "Mi reserva" — un bug real fácil de pasar por alto porque antes ambos
    // valores eran siempre el mismo.
    rememberMyCode(created.code, created.type);
    return created;
  });
}

function getReservation(code){
  // No sabemos de antemano si el código es de una reserva o una cita (quien busca solo
  // escribe el código) — se prueba primero reservations/ y, si no aparece ahí, visits/.
  return get(ref(db, 'reservationsManager/reservations/' + code)).then(function(snap){
    if(snap.exists()) return snap.val();
    return get(ref(db, 'reservationsManager/visits/' + code)).then(function(snap2){
      return snap2.exists() ? snap2.val() : null;
    });
  });
}

function getMyReservations(){
  var mine = loadMyCodes();
  return Promise.all(mine.map(function(m){ return getReservation(m.code); })).then(function(recs){
    return recs.filter(function(r){ return !!r; });
  });
}

function setReservationStatus(code, status){
  // Solo funciona si quien llama está autenticado (rules) — hoy nada en la UI lo invoca
  // todavía (no existe login de administrador, eso es Fase 6), queda listo para entonces.
  // Si se rechaza/cancela, libera las noches/turno bloqueados para que otra persona sí
  // pueda pedir esas mismas fechas — sin esto, una reserva rechazada dejaría el calendario
  // bloqueado para siempre, lo cual sería otra forma de "mentir".
  return getReservation(code).then(function(rec){
    if(!rec) return null;
    var unitKey = unitKeyOf(rec.unitType, rec.unitNum);
    var updates = {};
    updates[pathFor(rec.type) + '/' + code + '/status'] = status;
    updates['unitBookings/' + unitKey + '/' + code + '/status'] = status;
    if(status === 'rechazada' || status === 'cancelada'){
      if(rec.type === 'reserva'){
        nightsBetween(rec.checkin, rec.checkout).forEach(function(n){
          updates['bookedNights/' + unitKey + '/' + n] = null;
        });
      } else {
        updates['bookedVisitSlots/' + unitKey + '/' + rec.visitDate + '_' + rec.visitTime] = null;
      }
    }
    return update(ref(db), updates).then(function(){ return getReservation(code); });
  });
}

// El cliente elige método de pago (bank_transfer/cash) para una reserva ya creada (HOLD
// vigente) — transición de un solo sentido (el backend ahora reimplementa a mano el
// write-once que antes hacían las Rules, ver firebase.js:setPaymentMethod). Bloque A del
// pedido: PaymentProvider abstrae esto (ver index.html), este método es simplemente el POST
// real detrás de esa abstracción.
function setPaymentMethod(code, method){
  return postToBackend('/reservations/' + code + '/payment-method', { method: method });
}

// Reporte de pago (transferencia bancaria) — el cliente registra referencia/fecha/monto/
// banco tras hacer la transferencia. Transición de UN SOLO SENTIDO ('none' -> 'submitted'),
// ahora reforzada por firebase.js:reportPayment (ya lo hacía) en vez de por las Rules.
function reportPayment(code, report){
  return postToBackend('/reservations/' + code + '/payment-report', report);
}

function getPaymentInfo(){ return cache.settings.paymentInfo || null; }

var FirebaseDataProvider = {
  getCategoryKeys: function(){ return Object.keys(cache.categories); },
  getCategory: function(typeKey){
    var cat = cache.categories[typeKey];
    if(!cat) return null;
    var out = {};
    Object.keys(cat).forEach(function(k){ out[k] = cat[k]; });
    out.units = apartmentsByCategory(typeKey);
    // rooms = fotos/recorrido 360° del modelo — desde que las imágenes se migraron a URLs
    // externas (ya no base64), este campo son solo strings livianos, así que sí puede vivir
    // en Firebase sin tocar Storage. Se prefiere lo que traiga categories/{typeKey}/rooms si
    // ya se importó (ver firebase/seed-apartments.json); mientras eso no pase, se completa
    // desde LocalDataProvider para no dejar el catálogo sin fotos.
    var localCat = window.LocalDataProvider.getCategory(typeKey);
    out.rooms = (cat.rooms && cat.rooms.length) ? cat.rooms : (localCat ? localCat.rooms : []);
    return out;
  },
  getApartments: function(typeKey){ return apartmentsByCategory(typeKey); },
  getStatusMeta: function(){ return cache.statusMeta; },
  checkAvailability: checkAvailability,
  getOccupiedDates: getOccupiedDates,
  createReservation: createReservation,
  getReservation: getReservation,
  getMyReservations: getMyReservations,
  setReservationStatus: setReservationStatus,
  setPaymentMethod: setPaymentMethod,
  reportPayment: reportPayment,
  getPaymentInfo: getPaymentInfo
};

/* Un solo listener en la raíz ("/") requiere permiso de lectura EN LA RAÍZ misma — con
   reglas reales publicadas (sin `.read:true` en "/", a propósito: cada nodo tiene su propio
   permiso, ver database.rules.json) ese listener se rechaza ENTERO con PERMISSION_DENIED,
   aunque `categories`/`apartments`/`statusMeta` sean individualmente públicos. Por eso cada
   nodo tiene su propio onValue — así uno que todavía no sea legible (ej. `unitBookings` en
   un proyecto que no haya publicado las reglas más nuevas) no tumba a los demás. */
var ready = { categories: false, apartments: false, statusMeta: false };
function maybeActivate(){
  if(!(ready.categories && ready.apartments && ready.statusMeta)) return;
  if(!activated){
    activated = true;
    window.__uso_setDataProvider(FirebaseDataProvider);
  } else {
    window.__uso_refresh(); // cambio en vivo (ej. admin cambió un estado) — re-renderiza
  }
}

onValue(ref(db, 'categories'), function(snap){
  cache.categories = snap.val() || {}; ready.categories = true; maybeActivate();
}, function(error){
  console.error("FirebaseDataProvider: no se pudo leer categories — el sitio sigue funcionando con los datos locales.", error);
});
onValue(ref(db, 'apartments'), function(snap){
  cache.apartments = snap.val() || {}; ready.apartments = true; maybeActivate();
}, function(error){
  console.error("FirebaseDataProvider: no se pudo leer apartments — el sitio sigue funcionando con los datos locales.", error);
});
onValue(ref(db, 'statusMeta'), function(snap){
  cache.statusMeta = snap.val() || {}; ready.statusMeta = true; maybeActivate();
}, function(error){
  console.error("FirebaseDataProvider: no se pudo leer statusMeta — el sitio sigue funcionando con los datos locales.", error);
});
// unitBookings es una mejora (sincroniza el estado disponible/en-uso/reservado con reservas
// reales) pero no es indispensable para mostrar el catálogo — si sus reglas todavía no están
// publicadas, el catálogo sigue funcionando con el status manual crudo (degradado, no roto).
onValue(ref(db, 'unitBookings'), function(snap){
  cache.unitBookings = snap.val() || {};
  if(activated) window.__uso_refresh();
}, function(error){
  console.error("FirebaseDataProvider: no se pudo leer unitBookings — el estado disponible/en-uso/reservado no se sincroniza con reservas confirmadas hasta que se publiquen las reglas más recientes (ver database.rules.json).", error);
});
// settings/paymentInfo (banco/titular/cuenta) es configuración del administrador, importada
// una vez vía consola (ver firebase/seed-payment-info.json) — nunca hardcodeada en el HTML.
// Tampoco es indispensable para activar el catálogo: si todavía no existe, getPaymentInfo()
// simplemente devuelve null y la UI de pago lo señala en vez de inventar datos.
onValue(ref(db, 'settings'), function(snap){
  cache.settings = snap.val() || {};
  if(activated) window.__uso_refresh();
}, function(error){
  console.error("FirebaseDataProvider: no se pudo leer settings — la información de pago no estará disponible hasta que se publiquen las reglas.", error);
});

window.FirebaseDataProvider = FirebaseDataProvider;
