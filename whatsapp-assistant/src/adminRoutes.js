const express = require('express');
const fb = require('./firebase');
const pricing = require('./pricing');
const dateUtil = require('./dateUtil');
const validators = require('./validators');
const config = require('../config');
const { requireSuperAdmin } = require('./adminAuth');

// Todo lo que expone /admin/api/* — el panel de usoinmobiliario-middleware (React+Vite+TS) es
// el único consumidor. Nunca montado sin adminAuth.requireAdminAuth delante (ver app.js) — acá
// no se vuelve a verificar token, eso ya pasó antes de llegar a estas rutas.
//
// Cada acción de estado (confirmar/rechazar/cancelar/completar, verificar/rechazar/registrar
// pago) es un puerto directo y sin lógica nueva de lo que ya se construyó una vez para Unity
// (ReservationLifecycleService/PaymentService) — ver los métodos ya agregados en firebase.js.

const router = express.Router();

// auth/* son códigos reales que tira el SDK de Firebase Auth (admin.auth().createUser, etc.)
// — email-already-exists/invalid-email/invalid-password son errores del PEDIDO (400), no
// fallas del servidor (500), aunque nunca los hayamos lanzado nosotros mismos con `.code =`.
const AUTH_ERROR_STATUS = {
  'auth/email-already-exists': 409,
  'auth/invalid-email': 400,
  'auth/invalid-password': 400,
  'auth/weak-password': 400,
};
// Códigos que son errores del PEDIDO (400), no fallas del servidor (500) — cualquier código
// nuevo que se lance con e.code = '<algo-descriptivo>' (en vez del genérico 'invalid') tiene
// que sumarse acá, si no cae al 500 por defecto de abajo y se loguea como si fuera una falla
// real (ver el bug encontrado con 'reservation-not-active', que por esto mismo nunca llegaba
// al panel con su código propio).
const CLIENT_ERROR_CODES = new Set([
  'invalid', 'not-a-reservation', 'not-cash-payment', 'reservation-not-active',
  'reservation-not-confirmed', 'already-checked-in', 'not-checked-in-yet', 'already-checked-out',
]);
function asyncHandler(fn) {
  return (req, res) => fn(req, res).catch((err) => {
    const status = AUTH_ERROR_STATUS[err.code]
      || (err.code === 'not-found' ? 404
      : CLIENT_ERROR_CODES.has(err.code) ? 400
      : err.code === 'conflict' ? 409
      : 500);
    if (status === 500) console.error(`[adminRoutes] ${req.method} ${req.originalUrl}:`, err);
    res.status(status).json({ error: err.code || 'internal-error' });
  });
}

// --- Lecturas ---

router.get('/dashboard', asyncHandler(async (_req, res) => {
  res.json(await fb.getDashboardSummary());
}));

router.get('/apartments', asyncHandler(async (_req, res) => {
  res.json(await fb.listApartmentsWithEffectiveStatus());
}));

router.get('/reservations', asyncHandler(async (_req, res) => {
  res.json(await fb.listReservations());
}));

router.get('/visits', asyncHandler(async (_req, res) => {
  res.json(await fb.listVisits());
}));

// Un código puede ser de reserva o de cita — getReservationByCode ya prueba ambos árboles
// (reservationsManager/reservations y /visits), igual que el resto del backend.
router.get('/records/:code', asyncHandler(async (req, res) => {
  const rec = await fb.getReservationByCode(req.params.code.toUpperCase());
  if (!rec) return res.status(404).json({ error: 'not-found' });
  res.json(rec);
}));

router.get('/payment-info', asyncHandler(async (_req, res) => {
  res.json(await fb.getPaymentInfo());
}));

router.get('/categories', asyncHandler(async (_req, res) => {
  res.json(await fb.getCategories());
}));

// El panel usa esto para decidir si mostrar la pantalla de Administradores y el editor de
// datos bancarios — la restricción REAL vive en requireSuperAdmin en cada ruta sensible, esto
// es solo para que la UI sepa qué mostrar sin que el frontend tenga que conocer/hardcodear el
// correo del super admin por su cuenta.
router.get('/me', asyncHandler(async (req, res) => {
  res.json({ uid: req.adminUser.uid, email: req.adminUser.email, isSuperAdmin: req.adminUser.email === config.superAdminEmail });
}));

// --- Reserva manual (el admin crea a nombre de un cliente) ---
// MISMA fórmula/forma que businessTools.createReservationHold — status:'pendiente' + HOLD de
// 15 minutos SIEMPRE, sin atajo especial de admin (igual que ReservationService.cs de Unity:
// si se quiere confirmada de una, es un Confirm aparte después, no una tercera ruta inventada).
router.post('/reservations', asyncHandler(async (req, res) => {
  const { typeKey, num, checkin, checkout, guests, name, phone, email, notes } = req.body || {};
  const missing = validators.missingReservationFields({ num, checkin, checkout, guests, name, phone, email });
  if (missing.length > 0) return res.status(400).json({ error: 'invalid', missingFields: missing });

  const apt = await fb.getApartment(typeKey, num);
  if (!apt) return res.status(404).json({ error: 'apartment-not-found' });

  const nights = dateUtil.nightsBetween(checkin, checkout).length;
  const snapshot = pricing.priceBreakdown(apt, nights, guests);
  const rec = {
    code: fb.generateCode(),
    type: 'reserva',
    createdAt: new Date().toISOString(),
    unitType: apt.typeKey,
    unitNum: apt.num,
    unitLabel: `Apartamento H${apt.num}`,
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
  if (snapshot) { rec.estTotal = snapshot.total; rec.priceSnapshot = snapshot; }

  const created = await fb.createReservation(rec);
  res.status(201).json(created);
}));

// --- Check-in / check-out real — registrado ANTES de /records/:code/:action a propósito:
// Express matchea rutas en orden de registro, y ese comodín de abajo acepta CUALQUIER string
// como :action (cae a 400 'invalid-action' recién DENTRO del handler) — si estas dos rutas más
// específicas quedaran después, nunca se alcanzarían (bug real encontrado probando en vivo:
// "check-in" llegaba como :action al comodín en vez de a esta ruta). ---
router.post('/records/:code/check-in', asyncHandler(async (req, res) => {
  res.json(await fb.checkInReservation(req.params.code.toUpperCase()));
}));
router.post('/records/:code/check-out', asyncHandler(async (req, res) => {
  res.json(await fb.checkOutReservation(req.params.code.toUpperCase()));
}));

// --- Confirmar / rechazar / cancelar / completar — vale para reservas Y citas por igual, es
// la misma máquina de estados (setReservationStatus ya distingue el tipo internamente). ---
const STATUS_ACTIONS = {
  confirm: fb.confirmReservation,
  reject: fb.rejectReservation,
  cancel: fb.cancelReservation,
  complete: fb.completeReservation,
};
router.post('/records/:code/:action', asyncHandler(async (req, res) => {
  const fn = STATUS_ACTIONS[req.params.action];
  if (!fn) return res.status(400).json({ error: 'invalid-action' });
  const updated = await fn(req.params.code.toUpperCase());
  if (!updated) return res.status(404).json({ error: 'not-found' });
  res.json(updated);
}));

// Editar datos bancarios — antes de esto solo se podía cambiar a mano en la consola de
// Firebase. Restringido al super admin (no cualquier admin): son los datos donde los clientes
// depositan dinero real, el mismo nivel de sensibilidad que crear/revocar otros admins.
router.put('/payment-info', requireSuperAdmin, asyncHandler(async (req, res) => {
  res.json(await fb.setPaymentInfo(req.body || {}));
}));

// --- Administradores (todo detrás de requireSuperAdmin — un admin normal ni siquiera puede
// LISTAR a los demás, no solo crear/revocar) ---
router.get('/admins', requireSuperAdmin, asyncHandler(async (_req, res) => {
  res.json(await fb.listAdminUsers());
}));

router.post('/admins', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || String(password).length < 6) {
    return res.status(400).json({ error: 'invalid', missingFields: ['email', 'password (mínimo 6 caracteres)'] });
  }
  const created = await fb.createAdminUser(email, password);
  res.status(201).json(created);
}));

// Deshabilitar/rehabilitar en vez de borrar — reversible, y ningún dato de reservas/pagos que
// ese admin haya tocado queda huérfano (esta cuenta nunca fue dueña de nada, solo actuaba).
// No se puede revocar a sí mismo: evita que el super admin quede fuera por accidente.
router.post('/admins/:uid/disable', requireSuperAdmin, asyncHandler(async (req, res) => {
  if (req.params.uid === req.adminUser.uid) return res.status(400).json({ error: 'cannot-disable-self' });
  res.json(await fb.setAdminUserDisabled(req.params.uid, true));
}));
router.post('/admins/:uid/enable', requireSuperAdmin, asyncHandler(async (req, res) => {
  res.json(await fb.setAdminUserDisabled(req.params.uid, false));
}));

// --- Pagos ---
router.post('/payments/:code/verify', asyncHandler(async (req, res) => {
  res.json(await fb.verifyPayment(req.params.code.toUpperCase()));
}));
router.post('/payments/:code/reject', asyncHandler(async (req, res) => {
  res.json(await fb.rejectPayment(req.params.code.toUpperCase()));
}));
router.post('/payments/:code/register-cash', asyncHandler(async (req, res) => {
  res.json(await fb.registerCashPayment(req.params.code.toUpperCase()));
}));

// --- Contratos ---
router.get('/contracts', asyncHandler(async (_req, res) => {
  res.json(await fb.listContracts());
}));
router.post('/contracts', asyncHandler(async (req, res) => {
  const { unitType, unitNum, unitLabel, tenantName, startDate, endDate, monthlyRent } = req.body || {};
  const missing = [];
  if (!unitType || !unitNum) missing.push('apartamento');
  if (!tenantName || !String(tenantName).trim()) missing.push('nombre del inquilino');
  if (!startDate || !endDate) missing.push('fecha de inicio/fin');
  if (!monthlyRent || Number(monthlyRent) <= 0) missing.push('renta mensual');
  if (missing.length > 0) return res.status(400).json({ error: 'invalid', missingFields: missing });
  const created = await fb.createContract({ ...req.body, unitLabel: unitLabel || `Apartamento H${unitNum}`, createdBy: req.adminUser.email });
  res.status(201).json(created);
}));
const CONTRACT_STATUSES = new Set(['activo', 'finalizado', 'cancelado']);
router.post('/contracts/:code/status', asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  if (!CONTRACT_STATUSES.has(status)) return res.status(400).json({ error: 'invalid-status' });
  res.json(await fb.setContractStatus(req.params.code.toUpperCase(), status));
}));

// --- Aseo ---
router.get('/cleaning', asyncHandler(async (_req, res) => {
  res.json(await fb.listCleaningTasks());
}));
router.post('/cleaning', asyncHandler(async (req, res) => {
  const { unitType, unitNum, unitLabel, scheduledDate } = req.body || {};
  const missing = [];
  if (!unitType || !unitNum) missing.push('apartamento');
  if (!scheduledDate) missing.push('fecha programada');
  if (missing.length > 0) return res.status(400).json({ error: 'invalid', missingFields: missing });
  const created = await fb.createCleaningTask({ ...req.body, unitLabel: unitLabel || `Apartamento H${unitNum}` });
  res.status(201).json(created);
}));
const CLEANING_STATUSES = new Set(['pendiente', 'en-progreso', 'completado']);
router.post('/cleaning/:code/status', asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  if (!CLEANING_STATUSES.has(status)) return res.status(400).json({ error: 'invalid-status' });
  res.json(await fb.setCleaningStatus(req.params.code.toUpperCase(), status));
}));

// --- Mantenimiento ---
router.get('/maintenance', asyncHandler(async (_req, res) => {
  res.json(await fb.listMaintenanceTickets());
}));
router.post('/maintenance', asyncHandler(async (req, res) => {
  const { unitType, unitNum, unitLabel, title } = req.body || {};
  const missing = [];
  if (!unitType || !unitNum) missing.push('apartamento');
  if (!title || !String(title).trim()) missing.push('título');
  if (missing.length > 0) return res.status(400).json({ error: 'invalid', missingFields: missing });
  const created = await fb.createMaintenanceTicket({ ...req.body, unitLabel: unitLabel || `Apartamento H${unitNum}`, reportedBy: req.adminUser.email });
  res.status(201).json(created);
}));
const MAINTENANCE_STATUSES = new Set(['abierto', 'en-progreso', 'resuelto']);
router.post('/maintenance/:code/status', asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  if (!MAINTENANCE_STATUSES.has(status)) return res.status(400).json({ error: 'invalid-status' });
  res.json(await fb.setMaintenanceStatus(req.params.code.toUpperCase(), status));
}));

// --- Tráfico del sitio público (solo lectura acá — la escritura la hace /track/pageview en
// app.js, público y sin requireAdminAuth, ver ahí el porqué). ---
router.get('/site-traffic', asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
  res.json(await fb.getSiteTraffic(days));
}));

module.exports = router;
