// adminAuth.js/firebase.js requieren ../config, que exige varias env vars al cargarse (ver
// config/index.js: required()) — se fijan valores dummy ANTES de cualquier require real, mismo
// criterio que ya usan las auditorías previas para arrancar el servidor con variables dummy.
process.env.FIREBASE_DATABASE_URL = 'https://dummy-project-default-rtdb.firebaseio.com';
process.env.WHATSAPP_TOKEN = 'dummy';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'dummy';
process.env.WHATSAPP_VERIFY_TOKEN = 'dummy';
process.env.GEMINI_API_KEY = 'dummy';
process.env.SUPER_ADMIN_EMAIL = 'owner@example.com';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireRole } = require('../src/adminAuth');
const { sanitizeApartmentPatch, domainForAction } = require('../src/firebase');

// --- requireRole: el corazón de la matriz de permisos (STAFF/ANY_STAFF en adminRoutes.js) ---

function mockReqRes(role) {
  const req = { adminUser: role ? { uid: 'u1', role } : null };
  let statusCode = null, body = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(b) { body = b; return this; },
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  return { req, res, next, result: () => ({ statusCode, body, nextCalled }) };
}

test('requireRole: deja pasar un rol permitido', () => {
  const mw = requireRole('owner', 'admin');
  const { req, res, next, result } = mockReqRes('admin');
  mw(req, res, next);
  assert.deepEqual(result(), { statusCode: null, body: null, nextCalled: true });
});

test('requireRole: rechaza con 403 un rol NO permitido (ej. employee en ruta STAFF)', () => {
  const mw = requireRole('owner', 'admin');
  const { req, res, next, result } = mockReqRes('employee');
  mw(req, res, next);
  const r = result();
  assert.equal(r.nextCalled, false);
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, 'forbidden');
});

test('requireRole: rechaza si req.adminUser no tiene rol resuelto todavía (nunca "abre por accidente")', () => {
  const mw = requireRole('owner');
  const { req, res, next, result } = mockReqRes(null);
  mw(req, res, next);
  assert.equal(result().statusCode, 403);
});

test('requireRole("owner") no deja pasar admin — un admin normal no puede llegar a rutas owner-only', () => {
  const mw = requireRole('owner');
  const { req, res, next, result } = mockReqRes('admin');
  mw(req, res, next);
  assert.equal(result().statusCode, 403);
});

// --- sanitizeApartmentPatch: CMS de apartamentos (Fase 2) — nunca debe aceptar un status fuera
// del enum, ni dejar pasar campos no reconocidos sin normalizar. ---

const EXISTING = { typeKey: 'estudio', num: '09', status: 'disponible', isVisible: true, area: 20, maxPersons: 2, baths: 1, beds: [] };

test('sanitizeApartmentPatch: status fuera del enum lanza, nunca se guarda silenciosamente', () => {
  assert.throws(() => sanitizeApartmentPatch({ status: 'no-existe' }, EXISTING), (err) => err.code === 'invalid');
});

test('sanitizeApartmentPatch: campos ausentes en el patch conservan el valor existente', () => {
  const out = sanitizeApartmentPatch({ area: 25 }, EXISTING);
  assert.equal(out.area, 25);
  assert.equal(out.status, 'disponible'); // no tocado, se conserva
  assert.equal(out.isVisible, true);
});

test('sanitizeApartmentPatch: isVisible se normaliza a booleano explícito', () => {
  const out = sanitizeApartmentPatch({ isVisible: 0 }, EXISTING);
  assert.equal(out.isVisible, false);
  assert.equal(typeof out.isVisible, 'boolean');
});

test('sanitizeApartmentPatch: rates solo incluye los tramos que vienen en el patch', () => {
  const out = sanitizeApartmentPatch({ rates: { one: [1, 2, 3, 4] } }, EXISTING);
  assert.deepEqual(out.rates.one, [1, 2, 3, 4]);
  assert.equal(out.rates.two, undefined);
});

// --- domainForAction: separación reserva/financiero de la bitácora (secciones 18-19) ---

test('domainForAction: agrupa por el prefijo real de cada acción registrada', () => {
  assert.equal(domainForAction('reservation.create_manual'), 'reservation');
  assert.equal(domainForAction('record.confirm'), 'reservation');
  assert.equal(domainForAction('payment.verify'), 'financial');
  assert.equal(domainForAction('payment_info.update'), 'financial');
  assert.equal(domainForAction('apartment.update'), 'apartment');
  assert.equal(domainForAction('user.create'), 'admin');
  assert.equal(domainForAction('cleaning.set_status'), 'operations');
  assert.equal(domainForAction('algo.desconocido'), 'other');
});
