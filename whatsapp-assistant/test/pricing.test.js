const { test } = require('node:test');
const assert = require('node:assert/strict');
const { priceBreakdown, priceIntegrityCheck, hasPublishedRates } = require('../src/pricing');

const APT = {
  typeKey: 'estudio', num: '09', maxPersons: 3,
  rates: { one: [100000, 85000, 75000, 60000], two: [130000, 100000, 90000, 60000], extra: [50000, 50000, 50000, 50000] },
};

test('hasPublishedRates false sin rates.one', () => {
  assert.equal(hasPublishedRates(null), false);
  assert.equal(hasPublishedRates({ rates: {} }), false);
  assert.equal(hasPublishedRates(APT), true);
});

test('priceBreakdown: tramo de 1 noche, 1 huésped usa rates.one[0]', () => {
  const p = priceBreakdown(APT, 1, 1);
  assert.equal(p.tier, 'night');
  assert.equal(p.baseRate, 100000);
  assert.equal(p.total, 100000);
});

test('priceBreakdown: 2+ huéspedes usa rates.two, no rates.one', () => {
  const p = priceBreakdown(APT, 3, 2);
  assert.equal(p.tier, '2-6');
  assert.equal(p.baseRate, 100000); // rates.two[1]
  assert.equal(p.extraGuests, 0);
});

test('priceBreakdown: huésped extra (>2) se cobra aparte, por noche y por tramo', () => {
  const p = priceBreakdown(APT, 3, 3);
  assert.equal(p.extraGuests, 1);
  assert.equal(p.extraRate, 50000); // rates.extra[1]
  assert.equal(p.extraTotal, 1 * 50000 * 3);
  assert.equal(p.total, p.baseTotal + p.extraTotal);
});

test('priceBreakdown: tramos por número de noches (0/1/2/3)', () => {
  assert.equal(priceBreakdown(APT, 1, 1).tier, 'night');
  assert.equal(priceBreakdown(APT, 6, 1).tier, '2-6');
  assert.equal(priceBreakdown(APT, 7, 1).tier, 'weekly');
  assert.equal(priceBreakdown(APT, 29, 1).tier, 'weekly');
  assert.equal(priceBreakdown(APT, 30, 1).tier, 'monthly');
});

test('priceBreakdown: sin tarifas publicadas devuelve null (nunca inventa un precio)', () => {
  assert.equal(priceBreakdown({ typeKey: 'x', num: '1' }, 3, 1), null);
});

test('priceIntegrityCheck: coincide cuando el cliente reportó el total correcto', () => {
  const rec = { type: 'reserva', checkin: '2026-10-01', checkout: '2026-10-04', guests: 1, estTotal: 85000 * 3 };
  const check = priceIntegrityCheck(rec, APT);
  assert.equal(check.matchesReported, true);
  assert.equal(check.expectedTotal, 85000 * 3);
});

test('priceIntegrityCheck: detecta un estTotal manipulado (bug real que motivó P1-03)', () => {
  const rec = { type: 'reserva', checkin: '2026-10-01', checkout: '2026-10-04', guests: 1, estTotal: 1000 };
  const check = priceIntegrityCheck(rec, APT);
  assert.equal(check.matchesReported, false);
  assert.equal(check.reportedTotal, 1000);
  assert.ok(check.expectedTotal > 1000);
});

test('priceIntegrityCheck: null para citas (nunca aplica a type !== reserva)', () => {
  assert.equal(priceIntegrityCheck({ type: 'cita' }, APT), null);
});

test('priceIntegrityCheck: recalcula SIEMPRE con checkin/checkout reales, nunca con nights del registro', () => {
  // rec.nights miente (dice 1) — el cálculo real debe usar checkin/checkout (3 noches), no confiar en rec.nights
  const rec = { type: 'reserva', checkin: '2026-10-01', checkout: '2026-10-04', nights: 1, guests: 1, estTotal: 85000 * 3 };
  const check = priceIntegrityCheck(rec, APT);
  assert.equal(check.matchesReported, true);
});
