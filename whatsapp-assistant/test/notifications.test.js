process.env.FIREBASE_DATABASE_URL = 'https://dummy-project-default-rtdb.firebaseio.com';
process.env.WHATSAPP_TOKEN = 'dummy';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'dummy';
process.env.WHATSAPP_VERIFY_TOKEN = 'dummy';
process.env.GEMINI_API_KEY = 'dummy';
process.env.SUPER_ADMIN_EMAIL = 'owner@example.com';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pushPayloadFor, cleanNotificationMeta } = require('../src/firebase');

// --- cleanNotificationMeta: RTDB rechaza `undefined` en set(), un solo campo vacío tumbaría la
// creación entera de la notificación (y con ella el aviso al staff). ---

test('cleanNotificationMeta: descarta undefined/null/vacío y conserva 0 y el resto', () => {
  const out = cleanNotificationMeta({ unit: 'Apartamento H09', person: undefined, bank: null, reference: '', guests: 0, amount: 170000 });
  assert.deepEqual(out, { unit: 'Apartamento H09', guests: 0, amount: 170000 });
});

test('cleanNotificationMeta: sin datos útiles devuelve null (no se guarda un objeto vacío)', () => {
  assert.equal(cleanNotificationMeta({ a: undefined, b: '' }), null);
  assert.equal(cleanNotificationMeta(undefined), null);
  assert.equal(cleanNotificationMeta('texto'), null);
});

// --- pushPayloadFor: el título distingue el tipo a simple vista y `type` viaja para que el
// service worker del panel sepa a qué pantalla llevar al hacer clic. ---

test('pushPayloadFor: título por tipo + unidad, y type/targetCode para el clic', () => {
  const p = pushPayloadFor({ type: 'reservation', message: 'Nueva reserva ABC123', targetCode: 'ABC123', meta: { unit: 'Apartamento H09' } });
  assert.deepEqual(p, { title: 'Nueva reserva · Apartamento H09', body: 'Nueva reserva ABC123', type: 'reservation', targetCode: 'ABC123' });
});

test('pushPayloadFor: cada tipo conocido tiene su propio título', () => {
  const titles = ['reservation', 'payment', 'visit', 'cleaning', 'maintenance'].map((type) => pushPayloadFor({ type, message: 'x' }).title);
  assert.equal(new Set(titles).size, 5);
});

test('pushPayloadFor: tipo desconocido o sin meta cae a un título genérico, nunca lanza', () => {
  assert.equal(pushPayloadFor({ type: 'algo-nuevo', message: 'x' }).title, 'Uso Inmobiliario');
  assert.equal(pushPayloadFor({ type: 'payment', message: 'x' }).title, 'Pago por verificar');
  assert.equal(pushPayloadFor({ type: 'payment', message: 'x' }).targetCode, null);
});
