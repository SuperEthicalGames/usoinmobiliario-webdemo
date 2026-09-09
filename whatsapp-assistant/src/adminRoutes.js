const express = require('express');
const fb = require('./firebase');
const pricing = require('./pricing');
const dateUtil = require('./dateUtil');
const validators = require('./validators');
const config = require('../config');

// Todo lo que expone /admin/api/* — el panel de usoinmobiliario-middleware (React+Vite+TS) es
// el único consumidor. Nunca montado sin adminAuth.requireAdminAuth delante (ver app.js) — acá
// no se vuelve a verificar token, eso ya pasó antes de llegar a estas rutas.
//
// Cada acción de estado (confirmar/rechazar/cancelar/completar, verificar/rechazar/registrar
// pago) es un puerto directo y sin lógica nueva de lo que ya se construyó una vez para Unity
// (ReservationLifecycleService/PaymentService) — ver los métodos ya agregados en firebase.js.

const router = express.Router();

function asyncHandler(fn) {
  return (req, res) => fn(req, res).catch((err) => {
    const status = err.code === 'not-found' ? 404
      : err.code === 'invalid' || err.code === 'not-a-reservation' || err.code === 'not-cash-payment' ? 400
      : err.code === 'conflict' ? 409
      : 500;
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

module.exports = router;
