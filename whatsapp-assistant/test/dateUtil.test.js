const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nightsBetween, isValidIsoDate } = require('../src/dateUtil');

test('nightsBetween: un nodo por noche, checkin incluido, checkout excluido', () => {
  assert.deepEqual(nightsBetween('2026-10-01', '2026-10-04'), ['2026-10-01', '2026-10-02', '2026-10-03']);
});

test('nightsBetween: cero noches cuando checkin === checkout', () => {
  assert.deepEqual(nightsBetween('2026-10-01', '2026-10-01'), []);
});

test('isValidIsoDate: rechaza días fuera de rango que Date.UTC normalizaría en silencio', () => {
  // Bug real documentado en dateUtil.js: Date.UTC(2026,1,30) no da NaN, se normaliza a marzo 2.
  assert.equal(isValidIsoDate('2026-02-30'), false);
  assert.equal(isValidIsoDate('2026-02-28'), true);
  assert.equal(isValidIsoDate('2026-13-01'), false);
  assert.equal(isValidIsoDate('not-a-date'), false);
});
