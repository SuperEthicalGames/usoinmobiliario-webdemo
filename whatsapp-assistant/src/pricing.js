// Puerto exacto de PricingService.priceBreakdown() (index.html) / PricingService.cs (Unity) —
// misma fórmula, mismos índices de tier (0=1 noche, 1=2-6 noches, 2=semanal, 3=mensual), mismo
// criterio de huésped extra (guests > 2). Tercera copia de la MISMA fórmula, no una reinvención.

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

module.exports = { hasPublishedRates, priceBreakdown };
