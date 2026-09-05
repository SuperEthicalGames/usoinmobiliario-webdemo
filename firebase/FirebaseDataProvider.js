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
   reservas CONFIRMADAS de esa unidad (nunca las "pendiente" — una solicitud sin confirmar no
   debe poder marcar una unidad como ocupada, solo bloquea esas fechas puntuales, ver más
   abajo) y esa versión calculada es la que gana si hay una reserva activa u próxima. */
function effectiveStatus(typeKey, num, rawStatus){
  var bookings = cache.unitBookings[unitKeyOf(typeKey, num)];
  if(!bookings) return rawStatus;
  var today = todayIsoLocal();
  var hasActive = false, hasFuture = false;
  Object.keys(bookings).forEach(function(code){
    var b = bookings[code];
    if(!b || b.status !== 'confirmada' || b.type !== 'reserva') return;
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
       / no doble cita" de verdad, no solo una validación del lado del navegador. */

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

// Libera de forma oportunista (mejor esfuerzo) las noches de un HOLD vencido sin pago — antes
// esto solo pasaba "de rebote" cuando alguien más intentaba tomar exactamente esas mismas
// noches (la regla de bookedNights ya lo permitía, ver database.rules.json: su condición de
// reclamo no distingue entre sobreescribir con un código nuevo o borrar/poner null). Ahora se
// dispara en cuanto CUALQUIER visitante consulta disponibilidad y lo detecta (checkNightFree /
// getOccupiedDates), para que la fecha no quede como un "candado fantasma" hasta que alguien
// más la reclame. Si falla (alguien ya la reclamó, o se reportó el pago justo antes), no
// importa — es solo limpieza, la lectura ya filtraba el HOLD vencido de todas formas.
function reclaimExpiredHold(unitKey, booking){
  if(!booking || !booking.checkin || !booking.checkout) return;
  var updates = {};
  nightsBetween(booking.checkin, booking.checkout).forEach(function(n){
    updates['bookedNights/' + unitKey + '/' + n] = null;
  });
  update(ref(db), updates).catch(function(){ /* mejor esfuerzo, ignorar */ });
}
// Una noche con un nodo en bookedNights parece ocupada, pero si el HOLD dueño ya venció sin
// pago reportado ya no cuenta como bloqueo real (mismo criterio que la regla de reclamo en
// database.rules.json) — se confirma leyendo unitBookings/{unitKey}/{code} (público, sin
// datos de contacto) por el código que aparece en bookedNights. Devuelve {free} o
// {free:false, reason} — reason distingue una reserva ya CONFIRMADA de un HOLD todavía
// pendiente (sección 22 del pedido: la disponibilidad debe poder explicar por qué no).
function checkNightFree(unitKey, night){
  return get(ref(db, 'bookedNights/' + unitKey + '/' + night)).then(function(snap){
    if(!snap.exists()) return { free: true };
    var code = snap.val();
    return get(ref(db, 'unitBookings/' + unitKey + '/' + code)).then(function(ubSnap){
      var ub = ubSnap.exists() ? ubSnap.val() : null;
      if(isHoldExpiredRecord(ub)){
        reclaimExpiredHold(unitKey, ub);
        return { free: true };
      }
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
    if(isHoldExpiredRecord(b)){ reclaimExpiredHold(unitKey, b); return; }
    var reason = b.status === 'confirmada' ? 'confirmed_reservation' : 'temporary_hold';
    nightsBetween(b.checkin, b.checkout).forEach(function(n){
      if(out[n] !== 'confirmed_reservation') out[n] = reason;
    });
  });
  return Promise.resolve(out);
}

function createReservation(rec){
  // Una visita general ("quiero conocer las opciones disponibles") no está atada a una
  // unidad — no hay bookedVisitSlots/unitBookings que escribir ni turno que chequear, se
  // guarda directo. El admin decide después qué apartamentos mostrar (no se inventa un
  // "matching" automático que no pidieron).
  if(rec.appointmentType === 'general_visit'){
    var updates0 = {};
    updates0[pathFor(rec.type) + '/' + rec.code] = rec;
    return update(ref(db), updates0).then(function(){
      rememberMyCode(rec.code, rec.type);
      return rec;
    }).catch(function(err){
      if(isPermissionDenied(err)){ var conflict = new Error('conflict'); conflict.code = 'conflict'; throw conflict; }
      throw err;
    });
  }

  var unitKey = unitKeyOf(rec.unitType, rec.unitNum);
  var nights = rec.type === 'reserva' ? nightsBetween(rec.checkin, rec.checkout) : null;
  var slotKey = rec.type === 'cita' ? (rec.visitDate + '_' + rec.visitTime) : null;

  // Chequeo previo (no atómico, pero rápido) — le da al usuario un mensaje preciso ("esas
  // fechas ya no están disponibles") en el caso normal. El update() multi-ruta de abajo es
  // la garantía real contra la carrera de dos escrituras casi simultáneas.
  var preCheck = rec.type === 'reserva'
    ? checkNightsFree(unitKey, nights).then(function(result){
        if(!result.available){ var e = new Error('dates-taken'); e.code = 'dates-taken'; throw e; }
      })
    : checkSlotFree(unitKey, slotKey).then(function(free){
        if(!free){ var e = new Error('slot-taken'); e.code = 'slot-taken'; throw e; }
      });

  return preCheck.then(function(){
    var updates = {};
    updates[pathFor(rec.type) + '/' + rec.code] = rec;
    var ub = { status: rec.status, type: rec.type };
    if(rec.type === 'reserva'){
      ub.checkin = rec.checkin; ub.checkout = rec.checkout;
      // expiresAt/paymentStatus también se espejan aquí (nodo público, sin datos de
      // contacto) porque checkNightFree/las rules de reclamo de HOLD vencido necesitan
      // leerlos sin poder — ni deber — leer el registro privado en reservationsManager/.
      ub.expiresAt = rec.expiresAt; ub.paymentStatus = rec.paymentStatus;
      nights.forEach(function(n){ updates['bookedNights/' + unitKey + '/' + n] = rec.code; });
    } else {
      ub.visitDate = rec.visitDate; ub.visitTime = rec.visitTime;
      updates['bookedVisitSlots/' + unitKey + '/' + slotKey] = rec.code;
    }
    updates['unitBookings/' + unitKey + '/' + rec.code] = ub;
    return update(ref(db), updates);
  }).then(function(){
    rememberMyCode(rec.code, rec.type);
    return rec;
  }).catch(function(err){
    if(err && (err.code === 'dates-taken' || err.code === 'slot-taken')) throw err;
    // Pasó el chequeo previo pero el update() atómico igual fue rechazado — alguien más
    // ganó esas mismas fechas/turno en el instante entre el chequeo y la escritura (carrera
    // real, no un fallo del código). No tiene sentido reintentar con un código nuevo: lo que
    // está ocupado son las fechas, no el código.
    // OJO: a diferencia del error que recibe onValue() (trae `.code === 'PERMISSION_DENIED'`),
    // get()/update() rechazan con un Error plano SIN `.code`, solo `.message === "Permission
    // denied"` — hay que detectarlo por el texto, no por `.code` (confirmado en vivo contra
    // el proyecto real, no asumido).
    if(isPermissionDenied(err)){
      var conflict = new Error('conflict'); conflict.code = 'conflict';
      throw conflict;
    }
    throw err;
  });
}
function isPermissionDenied(err){
  return !!err && (err.code === 'PERMISSION_DENIED' || /permission[_ ]denied/i.test(err.message || ''));
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
// vigente) — transición de un solo sentido (solo se puede fijar una vez, ver
// database.rules.json: paymentMethod tiene su propio .write de "crear sin auth", igual que
// paymentReport). Bloque A del pedido: PaymentProvider abstrae esto (ver index.html), este
// método es simplemente la escritura real detrás de esa abstracción.
function setPaymentMethod(code, method){
  return getReservation(code).then(function(rec){
    if(!rec) throw new Error('reservation-not-found');
    if(rec.type !== 'reserva') throw new Error('not-a-reservation');
    var updates = {};
    updates[pathFor(rec.type) + '/' + code + '/paymentMethod'] = method;
    return update(ref(db), updates).then(function(){ return getReservation(code); });
  });
}

// Reporte de pago (transferencia bancaria) — el cliente registra referencia/fecha/monto/
// banco tras hacer la transferencia. Es una transición de UN SOLO SENTIDO ('none' -> 'submitted')
// permitida sin auth por las rules (ver database.rules.json: paymentStatus y paymentReport
// tienen su propio .write, más permisivo que el nodo padre, que ya no acepta escritura
// anónima una vez creada la reserva) — nadie puede revertir un pago reportado ni escribirlo
// dos veces. Se espeja también en unitBookings para que isHoldExpiredRecord dejе de poder
// reclamar estas fechas en cuanto se reporta el pago, aunque el HOLD ya haya vencido.
function reportPayment(code, report){
  return getReservation(code).then(function(rec){
    if(!rec) throw new Error('reservation-not-found');
    if(rec.type !== 'reserva') throw new Error('not-a-reservation');
    var unitKey = unitKeyOf(rec.unitType, rec.unitNum);
    var updates = {};
    updates[pathFor(rec.type) + '/' + code + '/paymentStatus'] = 'submitted';
    updates[pathFor(rec.type) + '/' + code + '/paymentReport'] = report;
    updates['unitBookings/' + unitKey + '/' + code + '/paymentStatus'] = 'submitted';
    return update(ref(db), updates).then(function(){ return getReservation(code); });
  });
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
