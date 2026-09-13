// firebase.js requiere ../config, que exige varias env vars al cargarse — mismo criterio que
// rbac.test.js. reservationBuilder.js SÍ llama de verdad a fb.getApartment/checkAvailability/
// getReservationByCode/generateCode (a diferencia de sanitizeApartmentPatch/domainForAction, que
// son funciones puras) — este entorno no puede alcanzar el proyecto real de Firebase
// (*.firebaseio.com bloqueado, confirmado en auditorías previas), así que cada test reemplaza
// esos métodos con mock.method() antes de llamar al builder, en vez de dejarlos pegarle a la red.
process.env.FIREBASE_DATABASE_URL = 'https://dummy-project-default-rtdb.firebaseio.com';
process.env.WHATSAPP_TOKEN = 'dummy';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'dummy';
process.env.WHATSAPP_VERIFY_TOKEN = 'dummy';
process.env.GEMINI_API_KEY = 'dummy';
process.env.SUPER_ADMIN_EMAIL = 'owner@example.com';

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fb = require('../src/firebase');
const { buildReservationRecord, buildVisitRecord } = require('../src/reservationBuilder');

const APT = {
  typeKey: 'estudio', num: '09', maxPersons: 2,
  rates: { one: [100000, 85000, 75000, 60000], two: [130000, 100000, 90000, 60000], extra: [50000, 50000, 50000, 50000] },
};

const VALID_ARGS = {
  typeKey: 'estudio', num: '09', checkin: '2027-01-10', checkout: '2027-01-12',
  guests: 2, name: 'Juana Pérez', phone: '3001234567', email: 'juana@gmail.com',
};

afterEach(() => mock.restoreAll());

// --- buildReservationRecord ---

test('buildReservationRecord: campos faltantes -> invalid + missingFields, nunca llega a Firebase', async () => {
  const getApartment = mock.method(fb, 'getApartment', async () => { throw new Error('no debería llamarse'); });
  await assert.rejects(
    () => buildReservationRecord({ ...VALID_ARGS, name: '' }),
    (err) => err.code === 'invalid' && err.missingFields.includes('nombre'),
  );
  assert.equal(getApartment.mock.calls.length, 0);
});

test('buildReservationRecord: apartamento inexistente -> not-found', async () => {
  mock.method(fb, 'getApartment', async () => null);
  await assert.rejects(() => buildReservationRecord(VALID_ARGS), (err) => err.code === 'not-found');
});

test('buildReservationRecord: más huéspedes que maxPersons -> invalid (capacity-exceeded)', async () => {
  mock.method(fb, 'getApartment', async () => APT);
  await assert.rejects(
    () => buildReservationRecord({ ...VALID_ARGS, guests: 5 }),
    (err) => err.code === 'invalid' && err.message === 'capacity-exceeded' && err.maxPersons === 2,
  );
});

test('buildReservationRecord: fechas ocupadas -> conflict, nunca llega a generar código', async () => {
  mock.method(fb, 'getApartment', async () => APT);
  mock.method(fb, 'checkAvailability', async () => ({ available: false, reason: 'confirmed_reservation' }));
  const generateCode = mock.method(fb, 'generateCode', () => { throw new Error('no debería llamarse'); });
  await assert.rejects(
    () => buildReservationRecord(VALID_ARGS),
    (err) => err.code === 'conflict' && err.reason === 'confirmed_reservation',
  );
  assert.equal(generateCode.mock.calls.length, 0);
});

test('buildReservationRecord: arma el registro completo con precio recalculado server-side', async () => {
  mock.method(fb, 'getApartment', async () => APT);
  mock.method(fb, 'checkAvailability', async () => ({ available: true, reason: null }));
  mock.method(fb, 'generateCode', () => 'ABC123');
  mock.method(fb, 'getReservationByCode', async () => null); // código libre, sin colisión
  const rec = await buildReservationRecord(VALID_ARGS);
  assert.equal(rec.code, 'ABC123');
  assert.equal(rec.type, 'reserva');
  assert.equal(rec.status, 'pendiente');
  assert.equal(rec.paymentStatus, 'none');
  assert.equal(rec.nights, 2);
  assert.equal(rec.estTotal, 200000); // 2 huéspedes, 2 noches -> rates.two[1]=100000 * 2
  assert.ok(rec.expiresAt > Date.now());
});

test('buildReservationRecord: descarta cualquier code/status/estTotal que mande el cliente', async () => {
  mock.method(fb, 'getApartment', async () => APT);
  mock.method(fb, 'checkAvailability', async () => ({ available: true, reason: null }));
  mock.method(fb, 'generateCode', () => 'XYZ999');
  mock.method(fb, 'getReservationByCode', async () => null);
  const rec = await buildReservationRecord({ ...VALID_ARGS, code: 'HACKED1', status: 'confirmada', estTotal: 1 });
  assert.equal(rec.code, 'XYZ999');
  assert.equal(rec.status, 'pendiente');
  assert.notEqual(rec.estTotal, 1);
});

// Regresión real: el sitio público (FirebaseDataProvider.js) arma su payload con
// unitType/unitNum (nombres de los campos ya guardados en Firebase), NO con typeKey/num (la
// convención del bot/panel admin) — sin este alias, toda reserva creada desde el sitio público
// habría fallado con apartment-not-found porque typeKey/num llegarían undefined.
test('buildReservationRecord: acepta unitType/unitNum (convención del sitio público), no solo typeKey/num', async () => {
  mock.method(fb, 'getApartment', async (typeKey, num) => (typeKey === 'estudio' && num === '09' ? APT : null));
  mock.method(fb, 'checkAvailability', async () => ({ available: true, reason: null }));
  mock.method(fb, 'generateCode', () => 'PUB001');
  mock.method(fb, 'getReservationByCode', async () => null);
  const { typeKey, num, ...rest } = VALID_ARGS;
  const rec = await buildReservationRecord({ ...rest, unitType: typeKey, unitNum: num });
  assert.equal(rec.code, 'PUB001');
  assert.equal(rec.unitType, 'estudio');
});

test('buildReservationRecord: colisión de código real reintenta con uno nuevo', async () => {
  mock.method(fb, 'getApartment', async () => APT);
  mock.method(fb, 'checkAvailability', async () => ({ available: true, reason: null }));
  let call = 0;
  mock.method(fb, 'generateCode', () => (++call === 1 ? 'DUP001' : 'FREE02'));
  mock.method(fb, 'getReservationByCode', async (code) => (code === 'DUP001' ? { code } : null));
  const rec = await buildReservationRecord(VALID_ARGS);
  assert.equal(rec.code, 'FREE02');
});

// --- buildVisitRecord ---

test('buildVisitRecord: sin typeKey/num arma una visita general, sin tocar fb.getApartment', async () => {
  const getApartment = mock.method(fb, 'getApartment', async () => { throw new Error('no debería llamarse'); });
  mock.method(fb, 'generateCode', () => 'GEN001');
  mock.method(fb, 'getReservationByCode', async () => null);
  const { rec, isGeneral } = await buildVisitRecord({
    name: 'Juan', phone: '3001234567', email: 'juan@gmail.com', visitDate: '2027-01-10', visitTime: '10:00',
  });
  assert.equal(isGeneral, true);
  assert.equal(rec.appointmentType, 'general_visit');
  assert.equal(rec.unitType, null);
  assert.equal(getApartment.mock.calls.length, 0);
});

test('buildVisitRecord: con typeKey/num resuelve el apartamento y arma visita específica', async () => {
  mock.method(fb, 'getApartment', async () => APT);
  mock.method(fb, 'generateCode', () => 'SPE001');
  mock.method(fb, 'getReservationByCode', async () => null);
  const { rec, isGeneral } = await buildVisitRecord({
    typeKey: 'estudio', num: '09', name: 'Juan', phone: '3001234567', email: 'juan@gmail.com',
    visitDate: '2027-01-10', visitTime: '10:00',
  });
  assert.equal(isGeneral, false);
  assert.equal(rec.appointmentType, 'specific_visit');
  assert.equal(rec.unitType, 'estudio');
});

test('buildVisitRecord: acepta unitType/unitNum (convención del sitio público)', async () => {
  mock.method(fb, 'getApartment', async (typeKey, num) => (typeKey === 'estudio' && num === '09' ? APT : null));
  mock.method(fb, 'generateCode', () => 'PUB002');
  mock.method(fb, 'getReservationByCode', async () => null);
  const { rec } = await buildVisitRecord({
    unitType: 'estudio', unitNum: '09', name: 'Juan', phone: '3001234567', email: 'juan@gmail.com',
    visitDate: '2027-01-10', visitTime: '10:00',
  });
  assert.equal(rec.unitType, 'estudio');
});

test('buildVisitRecord: campos faltantes -> invalid + missingFields', async () => {
  await assert.rejects(
    () => buildVisitRecord({ name: '', phone: '', email: '', visitDate: '', visitTime: '' }),
    (err) => err.code === 'invalid' && Array.isArray(err.missingFields) && err.missingFields.length > 0,
  );
});
