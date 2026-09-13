const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/validators');

test('isValidEmail: formato válido pero rechaza placeholders conocidos', () => {
  assert.equal(v.isValidEmail('real.person@gmail.com'), true);
  assert.equal(v.isValidEmail('pendiente@correo.com'), false); // local Y dominio placeholder
  assert.equal(v.isValidEmail('cliente@example.com'), false);
  assert.equal(v.isValidEmail('no-es-un-correo'), false);
});

test('isValidPhone: rechaza dígitos repetidos aunque tengan longitud válida', () => {
  assert.equal(v.isValidPhone('3001234567'), true);
  assert.equal(v.isValidPhone('0000000000'), false);
  assert.equal(v.isValidPhone('123'), false); // muy corto
});

test('isValidDateRange: checkout debe ser estrictamente posterior a checkin', () => {
  assert.equal(v.isValidDateRange('2026-10-01', '2026-10-03'), true);
  assert.equal(v.isValidDateRange('2026-10-03', '2026-10-01'), false);
  assert.equal(v.isValidDateRange('2026-10-01', '2026-10-01'), false); // mismo día, 0 noches
  assert.equal(v.isValidDateRange('2026-02-30', '2026-03-05'), false); // fecha inválida (30 feb)
});

test('isPositiveInt', () => {
  assert.equal(v.isPositiveInt(2), true);
  assert.equal(v.isPositiveInt(0), false);
  assert.equal(v.isPositiveInt(-1), false);
  assert.equal(v.isPositiveInt(1.5), false);
});

test('isValidPaymentReference: rechaza referencias tipo placeholder ("Referencia", muy corta)', () => {
  assert.equal(v.isValidPaymentReference('TX123456'), true);
  assert.equal(v.isValidPaymentReference('Referencia'), false);
  assert.equal(v.isValidPaymentReference('abc'), false); // < 4 caracteres
});

test('isValidBankName: rechaza "Banco" literal como placeholder', () => {
  assert.equal(v.isValidBankName('Bancolombia'), true);
  assert.equal(v.isValidBankName('Banco'), false);
});

test('missingReservationFields: lista exactamente lo que falta, vacío si todo está completo', () => {
  const complete = { num: '09', checkin: '2026-10-01', checkout: '2026-10-03', guests: 2, name: 'Juan Perez', phone: '3001234567', email: 'juan@gmail.com' };
  assert.deepEqual(v.missingReservationFields(complete), []);

  const empty = v.missingReservationFields({});
  assert.ok(empty.includes('apartamento'));
  assert.ok(empty.includes('número de huéspedes'));
  assert.ok(empty.includes('nombre'));
  assert.ok(empty.includes('teléfono'));
  assert.ok(empty.includes('correo electrónico'));
});

test('missingReservationFields: nombre placeholder cuenta como faltante (bug real de la IA)', () => {
  const missing = v.missingReservationFields({
    num: '09', checkin: '2026-10-01', checkout: '2026-10-03', guests: 1,
    name: 'Cliente', phone: '3001234567', email: 'juan@gmail.com',
  });
  assert.ok(missing.includes('nombre'));
});

test('missingPaymentReportFields', () => {
  assert.deepEqual(v.missingPaymentReportFields({ amount: 100000, reference: 'TX998877', bank: 'Bancolombia' }), []);
  const missing = v.missingPaymentReportFields({ amount: 0, reference: 'Referencia', bank: 'Banco' });
  assert.equal(missing.length, 3);
});
