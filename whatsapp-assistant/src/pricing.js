// Puerto exacto de PricingService.priceBreakdown() (index.html) / PricingService.cs (Unity) —
// misma fórmula, mismos índices de tier (0=1 noche, 1=2-6 noches, 2=semanal, 3=mensual), mismo
// criterio de huésped extra (guests > 2). Tercera copia de la MISMA fórmula, no una reinvención.

const { nightsBetween } = require('./dateUtil');

const TIER_LABELS = ['night', '2-6', 'weekly', 'monthly'];

function hasPublishedRates(apartment) {
  return !!(apartment && apartment.rates && Array.isArray(apartment.rates.one) && apartment.rates.one.length > 0);
}

function priceBreakdown(apartment, nights, guests) {
  if (!hasPublishedRates(apartment)) return null;

  let tierIdx;
  if (nights <= 1) tierIdx = 0;
  else if (nights <= 6) tierIdx = 1;
  else if (nights < 30) tierIdx = 2;
  else tierIdx = 3;

  const rates = apartment.rates;
  const baseRate = guests >= 2 ? rates.two[tierIdx] : rates.one[tierIdx];
  const baseTotal = baseRate * nights;
  const extraGuests = Math.max(0, guests - 2);
  const extraRate = extraGuests > 0 && rates.extra && rates.extra.length > tierIdx ? rates.extra[tierIdx] : 0;
  const extraTotal = extraGuests * extraRate * nights;

  return {
    tier: TIER_LABELS[tierIdx],
    nights,
    guests,
    baseRate,
    baseTotal,
    extraGuests,
    extraRate,
    extraTotal,
    discountTotal: 0,
    total: baseTotal + extraTotal,
    currency: 'COP',
  };
}

// El sitio web (index.html) calcula estTotal/priceSnapshot en el NAVEGADOR y los escribe
// directo a Firebase (nunca pasan por este backend) — database.rules.json solo valida que
// sean números positivos, no que el número sea el CORRECTO para ese apartamento/fechas/
// huéspedes. Un cliente que edite el JS en devtools, o que llame a la API de Firebase
// directamente con el SDK real, puede reportar cualquier estTotal que quiera para su propia
// reserva. Hallazgo real de esta auditoría (sección "reservation/payment integrity" del
// pedido) — la mitigación elegida es recalcular acá, en el backend que sí conoce las tarifas
// reales, y darle al admin una alerta explícita ANTES de que decida si el pago recibido
// corresponde, en vez de intentar validar la fórmula completa (tiers + huésped extra) dentro
// de las Realtime Database Rules, donde sería frágil y arriesgaría romper reservas legítimas
// si algo saliera mal (las rules no se pueden probar en vivo desde este entorno).
// Recalcula SIEMPRE con checkin/checkout reales (nunca con el `nights` que trae el registro,
// que es otro dato que el cliente pudo haber escrito a mano) y con las tarifas ACTUALES del
// apartamento — una tarifa que cambió después de la reserva puede producir una diferencia
// legítima, no solo una manipulación; por eso esto es una alerta para revisión humana, no un
// bloqueo automático.
function priceIntegrityCheck(rec, apartment) {
  if (!rec || rec.type !== 'reserva' || rec.estTotal == null || !apartment) return null;
  if (!rec.checkin || !rec.checkout || !rec.guests) return null;
  const nights = nightsBetween(rec.checkin, rec.checkout).length;
  const expected = priceBreakdown(apartment, nights, rec.guests);
  if (!expected) return null;
  return {
    expectedTotal: expected.total,
    reportedTotal: rec.estTotal,
    matchesReported: Math.abs(expected.total - rec.estTotal) < 1,
  };
}

module.exports = { hasPublishedRates, priceBreakdown, priceIntegrityCheck };
