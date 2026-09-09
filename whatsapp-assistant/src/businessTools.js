const fb = require('./firebase');
const pricing = require('./pricing');
const dateUtil = require('./dateUtil');
const validators = require('./validators');
const config = require('../config');
const emailService = require('./emailService');

// Las únicas funciones que el modelo de IA puede invocar (function calling) — ver aiAgent.js
// para las declaraciones que se le exponen a Gemini. Cada una valida su entrada y devuelve
// datos reales de Firebase; ninguna inventa información. Deliberadamente NO existe aquí
// confirmPayment/approveReservation/verifyPayment/setStatus — esas son exclusivamente
// administrativas (panel de Unity), nunca alcanzables desde la IA (sección 14/30 del pedido).

// EXACTAMENTE la misma convención que unitLabel() en index.html ("Apartamento H"+num) — el
// link que se manda junto a esta etiqueta apunta a esa misma página, así que el nombre tiene
// que coincidir con lo que el cliente ve ahí. (La resolución de typeKey/num por número, en
// firebase.js, ya no depende de esta etiqueta — sigue protegiendo contra que la IA adivine mal
// el typeKey al llamar una función, sin importar cómo se muestre el nombre acá.)
function apartmentLabel(typeKey, num) {
  return `Apartamento H${num}`;
}

// Misma ruta hash que index.html usa para la página de una unidad (#/unidad/:tipo?u=:num, ver
// route() en index.html) — el link que manda el bot debe ser EXACTAMENTE ese, nunca uno
// reconstruido a mano, para que apunte de verdad a la ficha real del apartamento.
function apartmentUrl(typeKey, num) {
  return `${config.siteBaseUrl}/#/unidad/${typeKey}?u=${num}`;
}

// Mismo criterio que AvailabilityService.IsUnitBookable en Unity: el campo crudo `status` es
// el control manual del admin (mantenimiento/remodelación) — si no está 'disponible', ni
// reservas ni visitas específicas deberían ofrecerse para esa unidad, sin importar fechas.
function isUnitBookable(apartment) {
  return !!apartment && apartment.status === 'disponible';
}

async function searchApartments({ guests, checkin, checkout, typeKey } = {}) {
  try {
    const apartments = await fb.getApartments();
    const candidates = apartments.filter((a) => {
      if (typeKey && a.typeKey !== typeKey) return false;
      if (guests && a.maxPersons < guests) return false;
      return isUnitBookable(a);
    });

    const results = [];
    for (const apt of candidates) {
      let available = true;
      let reason = null;
      if (checkin && checkout && validators.isValidDateRange(checkin, checkout)) {
        const check = await fb.checkAvailability(apt.typeKey, apt.num, checkin, checkout);
        available = check.available;
        reason = check.reason;
      }
      if (!available) continue;

      const nights = checkin && checkout ? dateUtil.nightsBetween(checkin, checkout).length : null;
      const price = nights ? pricing.priceBreakdown(apt, nights, guests || 1) : null;

      results.push({
        typeKey: apt.typeKey,
        num: apt.num,
        label: apartmentLabel(apt.typeKey, apt.num),
        url: apartmentUrl(apt.typeKey, apt.num),
        area: apt.area,
        maxPersons: apt.maxPersons,
        baths: apt.baths,
        feature: apt.feature ? apt.feature.es || apt.feature.en : null,
        priceEstimate: price ? { total: price.total, currency: price.currency, nights: price.nights } : null,
      });
    }
    return { ok: true, apartments: results, count: results.length };
  } catch (err) {
    console.error('[businessTools.searchApartments]', err);
    return { ok: false, error: 'No se pudo consultar el catálogo de apartamentos en este momento.' };
  }
}

async function getApartment({ typeKey, num } = {}) {
  try {
    if (!num) return { ok: false, error: 'Falta el número del apartamento.' };
    const apt = await fb.getApartment(typeKey, num);
    if (!apt) return { ok: false, error: 'No existe ese apartamento.' };
    return {
      ok: true,
      apartment: {
        typeKey: apt.typeKey,
        num: apt.num,
        label: apartmentLabel(apt.typeKey, apt.num),
        url: apartmentUrl(apt.typeKey, apt.num),
        status: apt.status,
        area: apt.area,
        maxPersons: apt.maxPersons,
        baths: apt.baths,
        beds: apt.beds,
        feature: apt.feature ? apt.feature.es || apt.feature.en : null,
        rates: apt.rates,
      },
    };
  } catch (err) {
    console.error('[businessTools.getApartment]', err);
    return { ok: false, error: 'No se pudo consultar ese apartamento en este momento.' };
  }
}

// Si ya se sabe el número de huéspedes, de una vez calcula el precio en la MISMA llamada —
// evita que la IA tenga que hacer una segunda ida y vuelta a Gemini solo para pedir el precio
// justo después de confirmar disponibilidad (el caso más común: "¿está libre y cuánto cuesta?"
// en un solo mensaje). calculatePrice sigue existiendo aparte para cuando solo hace falta precio.
async function checkAvailabilityTool({ typeKey, num, checkin, checkout, guests } = {}) {
  try {
    if (!num) return { ok: false, error: 'Falta el número del apartamento.' };
    if (!validators.isValidDateRange(checkin, checkout)) {
      return { ok: false, error: 'Fechas inválidas. Formato AAAA-MM-DD, checkout después de checkin.' };
    }
    const apt = await fb.getApartment(typeKey, num);
    if (!apt) return { ok: false, error: 'No existe ese apartamento.' };
    if (!isUnitBookable(apt)) return { ok: true, available: false, reason: 'unit_not_bookable' };
    const result = await fb.checkAvailability(apt.typeKey, apt.num, checkin, checkout);
    if (!result.available || !validators.isPositiveInt(guests)) return { ok: true, ...result };

    const nights = dateUtil.nightsBetween(checkin, checkout).length;
    const breakdown = pricing.priceBreakdown(apt, nights, guests);
    return { ok: true, ...result, priceEstimate: breakdown ? { total: breakdown.total, currency: breakdown.currency, nights: breakdown.nights } : null };
  } catch (err) {
    console.error('[businessTools.checkAvailability]', err);
    return { ok: false, error: 'No se pudo verificar disponibilidad en este momento.' };
  }
}

async function calculatePriceTool({ typeKey, num, checkin, checkout, guests } = {}) {
  try {
    if (!num) return { ok: false, error: 'Falta el número del apartamento.' };
    if (!validators.isValidDateRange(checkin, checkout)) {
      return { ok: false, error: 'Fechas inválidas. Formato AAAA-MM-DD, checkout después de checkin.' };
    }
    if (!validators.isPositiveInt(guests)) return { ok: false, error: 'Número de huéspedes inválido.' };

    const apt = await fb.getApartment(typeKey, num);
    if (!apt) return { ok: false, error: 'No existe ese apartamento.' };
    const nights = dateUtil.nightsBetween(checkin, checkout).length;
    const breakdown = pricing.priceBreakdown(apt, nights, guests);
    if (!breakdown) return { ok: true, hasRates: false, message: 'Sin tarifas publicadas para esta unidad.' };
    return { ok: true, hasRates: true, ...breakdown };
  } catch (err) {
    console.error('[businessTools.calculatePrice]', err);
    return { ok: false, error: 'No se pudo calcular el precio en este momento.' };
  }
}

// Punto crítico (sección 6-11 del pedido): crea la reserva SIEMPRE como 'pendiente' + HOLD de
// 15 minutos, exige correo, re-verifica disponibilidad con reclamo atómico justo antes de
// escribir (ver firebase.js createReservation). Nunca confirma nada.
async function createReservationHold(args = {}) {
  const { typeKey, num, checkin, checkout, guests, name, phone, email, notes } = args;
  try {
    const missing = validators.missingReservationFields(args);
    if (missing.length > 0) return { ok: false, missingFields: missing, error: `Falta información: ${missing.join(', ')}.` };

    const apt = await fb.getApartment(typeKey, num);
    if (!apt) return { ok: false, error: 'No existe ese apartamento.' };
    if (!isUnitBookable(apt)) return { ok: false, error: 'Ese apartamento no está disponible para reservar en este momento.' };

    const availability = await fb.checkAvailability(apt.typeKey, apt.num, checkin, checkout);
    if (!availability.available) {
      return {
        ok: false,
        error: availability.reason === 'confirmed_reservation'
          ? 'Esas fechas ya tienen una reserva confirmada.'
          : 'Esas fechas están en HOLD temporal de otra persona ahora mismo.',
      };
    }

    const nights = dateUtil.nightsBetween(checkin, checkout).length;
    const snapshot = pricing.priceBreakdown(apt, nights, guests);

    const rec = {
      code: fb.generateCode(),
      type: 'reserva',
      createdAt: new Date().toISOString(),
      unitType: apt.typeKey,
      unitNum: apt.num,
      unitLabel: apartmentLabel(apt.typeKey, apt.num),
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

    const created = await fb.createReservation(rec);

    // Fire-and-forget: el correo es un canal, no la fuente de verdad (misma regla ya
    // establecida en index.html) — nunca debe alargar la respuesta del bot ni, mucho menos,
    // hacer fallar una reserva ya creada si el envío falla. Nunca esperar (await) esto acá.
    emailService.sendReservationConfirmation({ code: created.code, email: created.email }).catch((err) => {
      console.error(`[businessTools] No se pudo enviar el correo de confirmación de ${created.code}:`, err.code || err.message);
    });

    return {
      ok: true,
      code: created.code,
      holdMinutes: 15,
      expiresAt: created.expiresAt,
      estTotal: created.estTotal || null,
      currency: 'COP',
    };
  } catch (err) {
    if (err.code === 'conflict') {
      return { ok: false, error: 'Justo se ocuparon esas fechas — intenta con otras fechas o apartamento.' };
    }
    console.error('[businessTools.createReservationHold]', err);
    return { ok: false, error: 'No se pudo crear la reserva en este momento.' };
  }
}

async function getReservationTool({ code } = {}) {
  try {
    if (!validators.isValidCodeFormat(code)) return { ok: false, error: 'Formato de código inválido. Debe ser 3 letras + 3 números, ej. ABC123.' };
    const rec = await fb.getReservationByCode(code);
    if (!rec) return { ok: true, found: false };
    return {
      ok: true,
      found: true,
      code: rec.code,
      type: rec.type,
      status: rec.status,
      unitLabel: rec.unitLabel,
      checkin: rec.checkin,
      checkout: rec.checkout,
      visitDate: rec.visitDate,
      visitTime: rec.visitTime,
      paymentStatus: rec.paymentStatus,
      paymentMethod: rec.paymentMethod,
      estTotal: rec.estTotal,
    };
  } catch (err) {
    console.error('[businessTools.getReservation]', err);
    return { ok: false, error: 'No se pudo consultar esa reserva en este momento.' };
  }
}

// Cita general (sin apartamento) o específica (con typeKey+num) — sección 16-18 del pedido.
async function createVisit(args = {}) {
  const { typeKey, num, name, phone, email, notes, visitDate, visitTime } = args;
  try {
    const missing = validators.missingVisitFields(args);
    if (missing.length > 0) return { ok: false, missingFields: missing, error: `Falta información: ${missing.join(', ')}.` };

    const isGeneral = !typeKey || !num;
    let unitLabel = 'Visita general';
    let resolvedTypeKey = null;
    let resolvedNum = null;
    if (!isGeneral) {
      const apt = await fb.getApartment(typeKey, num);
      if (!apt) return { ok: false, error: 'No existe ese apartamento.' };
      if (!isUnitBookable(apt)) return { ok: false, error: 'Ese apartamento no está disponible para agendar visita en este momento.' };
      resolvedTypeKey = apt.typeKey;
      resolvedNum = apt.num;
      unitLabel = apartmentLabel(apt.typeKey, apt.num);
    }

    const rec = {
      code: fb.generateCode(),
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

    const created = isGeneral ? await fb.createGeneralVisit(rec) : await fb.createSpecificVisit(rec);
    return { ok: true, code: created.code };
  } catch (err) {
    if (err.code === 'conflict') {
      return { ok: false, error: 'Justo se ocupó ese horario — intenta con otra fecha/hora.' };
    }
    console.error('[businessTools.createVisit]', err);
    return { ok: false, error: 'No se pudo agendar la visita en este momento.' };
  }
}

async function getPaymentInfoTool() {
  try {
    const info = await fb.getPaymentInfo();
    if (!info) return { ok: false, error: 'No hay datos bancarios configurados todavía.' };
    return { ok: true, ...info };
  } catch (err) {
    console.error('[businessTools.getPaymentInfo]', err);
    return { ok: false, error: 'No se pudo consultar la información de pago en este momento.' };
  }
}

// El cliente elige método de pago — SOLO registra la elección, la reserva sigue 'pendiente'.
async function setPaymentMethodTool({ code, method } = {}) {
  try {
    if (!validators.isValidCodeFormat(code)) return { ok: false, error: 'Formato de código inválido.' };
    if (method !== 'bank_transfer' && method !== 'cash') return { ok: false, error: "method debe ser 'bank_transfer' o 'cash'." };
    await fb.setPaymentMethod(code.toUpperCase(), method);
    return { ok: true };
  } catch (err) {
    if (err.code === 'not-found') return { ok: false, error: 'No existe una reserva con ese código.' };
    console.error('[businessTools.setPaymentMethod]', err);
    return { ok: false, error: 'No se pudo registrar el método de pago en este momento.' };
  }
}

// El cliente reporta que ya transfirió — NUNCA confirma el pago (sección 14, regla crítica).
// paymentStatus queda en 'submitted', un administrador humano debe verificarlo aparte.
async function reportPaymentTool({ code, amount, reference, bank, date } = {}) {
  try {
    if (!validators.isValidCodeFormat(code)) return { ok: false, error: 'Formato de código inválido.' };
    const missing = validators.missingPaymentReportFields({ amount, reference, bank });
    if (missing.length > 0) {
      return { ok: false, missingFields: missing, error: `Falta información real del comprobante: ${missing.join(', ')}.` };
    }
    const report = {
      amount: Number(amount),
      reference: String(reference).trim(),
      bank: String(bank).trim(),
      date: dateUtil.isValidIsoDate(date) ? date : dateUtil.todayIsoBogota(),
      reportedAt: new Date().toISOString(),
    };
    await fb.reportPayment(code.toUpperCase(), report);
    return { ok: true, paymentStatus: 'submitted' };
  } catch (err) {
    if (err.code === 'not-found') return { ok: false, error: 'No existe una reserva con ese código.' };
    if (err.code === 'invalid') return { ok: false, error: err.message === 'payment-already-reported' ? 'Ya se había reportado un pago para esta reserva.' : 'Esa operación no aplica a este código.' };
    console.error('[businessTools.reportPayment]', err);
    return { ok: false, error: 'No se pudo registrar el reporte de pago en este momento.' };
  }
}

module.exports = {
  searchApartments,
  getApartment,
  checkAvailability: checkAvailabilityTool,
  calculatePrice: calculatePriceTool,
  createReservationHold,
  getReservation: getReservationTool,
  createVisit,
  getPaymentInfo: getPaymentInfoTool,
  setPaymentMethod: setPaymentMethodTool,
  reportPayment: reportPaymentTool,
};
