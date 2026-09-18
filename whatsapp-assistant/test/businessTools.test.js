// Mismo criterio que rbac.test.js/reservationBuilder.test.js: variables dummy antes de cualquier
// require real, y fb.getReservationByCode se reemplaza con mock.method() en vez de pegarle a la
// red (este entorno no puede alcanzar el proyecto real de Firebase).
process.env.FIREBASE_DATABASE_URL = 'https://dummy-project-default-rtdb.firebaseio.com';
process.env.WHATSAPP_TOKEN = 'dummy';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'dummy';
process.env.WHATSAPP_VERIFY_TOKEN = 'dummy';
process.env.GEMINI_API_KEY = 'dummy';
process.env.SUPER_ADMIN_EMAIL = 'owner@example.com';

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fb = require('../src/firebase');
const businessTools = require('../src/businessTools');

afterEach(() => mock.restoreAll());

const REC = {
  code: 'ABC123', type: 'reserva', status: 'pendiente', unitLabel: 'Apartamento H09',
  checkin: '2027-01-10', checkout: '2027-01-12', paymentStatus: 'none', paymentMethod: null,
  estTotal: 170000, phone: '3001234567', name: 'Juana Pérez', email: 'juana@gmail.com',
};

// --- getReservation (SEC-004, auditoría 2026-09-16): por WhatsApp, el teléfono verificado del
// remitente (context.verifiedPhone) debe coincidir con el de la reserva antes de revelar nada. ---

test('getReservation: sin context (o canal web) sigue devolviendo el detalle — mismo trade-off ya conocido', async () => {
  mock.method(fb, 'getReservationByCode', async () => REC);
  const result = await businessTools.getReservation({ code: 'ABC123' });
  assert.equal(result.found, true);
  assert.equal(result.code, 'ABC123');
});

test('getReservation: WhatsApp con el MISMO número que la reserva -> devuelve el detalle', async () => {
  mock.method(fb, 'getReservationByCode', async () => REC);
  const result = await businessTools.getReservation({ code: 'ABC123' }, { verifiedPhone: '573001234567' });
  assert.equal(result.found, true);
  assert.equal(result.status, 'pendiente');
});

test('getReservation: WhatsApp con OTRO número -> "no encontrada", nunca confirma que el código es real', async () => {
  mock.method(fb, 'getReservationByCode', async () => REC);
  const result = await businessTools.getReservation({ code: 'ABC123' }, { verifiedPhone: '573009999999' });
  assert.deepEqual(result, { ok: true, found: false });
});

test('getReservation: código inexistente sigue respondiendo found:false igual que antes', async () => {
  mock.method(fb, 'getReservationByCode', async () => null);
  const result = await businessTools.getReservation({ code: 'ZZZ999' }, { verifiedPhone: '573001234567' });
  assert.deepEqual(result, { ok: true, found: false });
});

test('getReservation: nunca revela nombre/correo/notas ni con el teléfono correcto (proyección angosta ya existente)', async () => {
  mock.method(fb, 'getReservationByCode', async () => REC);
  const result = await businessTools.getReservation({ code: 'ABC123' }, { verifiedPhone: '573001234567' });
  assert.equal(result.name, undefined);
  assert.equal(result.email, undefined);
  assert.equal(result.phone, undefined);
});
