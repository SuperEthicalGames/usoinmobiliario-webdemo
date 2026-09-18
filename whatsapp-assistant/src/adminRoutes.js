const express = require('express');
const fb = require('./firebase');
const pricing = require('./pricing');
const emailService = require('./emailService');
const reservationBuilder = require('./reservationBuilder');
const whatsapp = require('./whatsapp');
const { generateContractReceiptPdf } = require('./receiptPdf');
const { generateContractDocumentPdf } = require('./contractDocPdf');
const { requireSuperAdmin, requireRole } = require('./adminAuth');

// Staff operativo (dueño incluido) — todo lo que NO es exclusivamente para tareas de un
// empleado. Empleados quedan fuera de dashboard/reservas/pagos/apartamentos/contratos/
// analíticas a propósito (Least Privilege, sección 4 del pedido).
const STAFF = requireRole('owner', 'admin');
// Cualquier cuenta autenticada válida, incluyendo empleados — usado en rutas que ya filtran o
// acotan internamente lo que cada rol puede ver/tocar (aseo, mantenimiento, notificaciones).
const ANY_STAFF = requireRole('owner', 'admin', 'employee');

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
  'checkin-too-early', 'contract-not-active',
]);
function asyncHandler(fn) {
  return (req, res) => fn(req, res).catch((err) => {
    const status = AUTH_ERROR_STATUS[err.code]
      || (err.code === 'not-found' ? 404
      : CLIENT_ERROR_CODES.has(err.code) ? 400
      : err.code === 'conflict' ? 409
      : 500);
    if (status === 500) console.error(`[adminRoutes] ${req.method} ${req.originalUrl}:`, err);
    // missingFields (reservationBuilder, apartment routes) se preserva cuando el error la trae —
    // el panel ya sabe leer este campo (ver Reservations.tsx/ManualReservation), no es nuevo.
    res.status(status).json({ error: err.code || 'internal-error', ...(err.missingFields ? { missingFields: err.missingFields } : {}) });
  });
}

// Correo de actualización de estado (sección 37 del pedido) — SIEMPRE fire-and-forget, nunca
// awaited antes de responder al panel (sección 39: "la reserva no debe fallar simplemente
// porque el servidor de correo está caído"). emailService ya se traga sus propios errores.
function notifyByEmail(sendFn, rec) {
  if (!rec) return;
  Promise.resolve(sendFn(rec, 'es')).catch((err) => console.error('[adminRoutes] Error enviando correo de actualización:', err.message));
}

// Best-effort — normaliza a solo dígitos y asume Colombia (+57) cuando el cliente lo escribió
// sin indicativo (celular local de 10 dígitos, empieza en 3) — el negocio solo opera acá, mismo
// criterio ya usado en el resto del proyecto. rec.phone viene tal cual lo tipeó el cliente en el
// formulario público (validators.isValidPhone solo exige >=7 dígitos, no fuerza un formato).
function toWhatsAppId(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) return null;
  return digits.length === 10 ? `57${digits}` : digits;
}

// WhatsApp de actualización de estado, SIEMPRE junto al correo (nunca en su reemplazo) y SIEMPRE
// fire-and-forget igual que notifyByEmail. Es best-effort de verdad: la API de WhatsApp Cloud
// solo deja iniciar un mensaje de texto libre dentro de las 24h desde el último mensaje DEL
// cliente al bot — fuera de esa ventana, Meta exige una plantilla pre-aprobada (trámite manual
// en Meta Business Manager, fuera de alcance de este cambio). Si falla o cae fuera de ventana,
// whatsapp.sendTextMessage ya loguea y no debe tumbar la acción principal.
function notifyByWhatsApp(rec, textEs) {
  if (!rec) return;
  const to = toWhatsAppId(rec.phone);
  if (!to) return;
  Promise.resolve(whatsapp.sendTextMessage(to, textEs)).catch((err) => console.error('[adminRoutes] Error enviando WhatsApp de actualización:', err.message));
}
function fmtCOPForWhatsApp(n) {
  return '$' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

const STATUS_WHATSAPP_TEXT = {
  confirm: (rec) => (rec.type === 'cita'
    ? `✅ Tu cita ${rec.code} fue confirmada. ¡Te esperamos!`
    : `✅ Tu reserva ${rec.code} fue confirmada. Ya no depende de ningún pago pendiente — te esperamos en las fechas acordadas.`),
  reject: (rec) => `❌ No pudimos aceptar tu reserva/cita ${rec.code}. Escríbenos si quieres saber por qué o buscar otra fecha.`,
  cancel: (rec) => `🚫 Tu reserva ${rec.code} fue cancelada. Si no lo esperabas o quieres agendar otra fecha, cuéntanos.`,
  complete: (rec) => `🙏 Marcamos tu reserva ${rec.code} como completada. ¡Gracias por elegirnos!`,
};

// Bitácora — se llama DESPUÉS de que la acción real ya se ejecutó con éxito (nunca antes, nunca
// si la acción falló). fb.logAdminAction ya se traga sus propios errores, así que un fallo de
// log nunca tumba la respuesta real al panel.
function logAction(req, action, target, metadata) {
  return fb.logAdminAction({
    actorUid: req.adminUser.uid,
    actorEmail: req.adminUser.email,
    action,
    target: target || null,
    metadata: metadata || undefined,
  });
}

// --- Lecturas ---

router.get('/dashboard', STAFF, asyncHandler(async (_req, res) => {
  res.json(await fb.getDashboardSummary());
}));

// ANY_STAFF (no solo STAFF): un empleado necesita saber a qué unidad corresponde su tarea de
// aseo/mantenimiento. Nada de esto es sensible — mismas tarifas que ya son públicas en el
// sitio web, sin datos de huéspedes ni financieros.
router.get('/apartments', ANY_STAFF, asyncHandler(async (_req, res) => {
  res.json(await fb.listApartmentsWithEffectiveStatus());
}));

// Crear/editar apartamento — antes esto solo se podía hacer a mano en la consola de Firebase
// (§7-9 del pedido: "el middleware debe convertirse en el CMS real de la página"). Restringido
// al dueño (igual que /users, /payment-info): son los datos que la página pública muestra y
// vende, mismo nivel de sensibilidad de negocio. ADMIN se queda con apartments.read (arriba),
// no con la escritura — coincide con la matriz de permisos del propio pedido (sección 6).
router.post('/apartments', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { typeKey, num } = req.body || {};
  if (!typeKey || !num) return res.status(400).json({ error: 'invalid', missingFields: ['typeKey', 'num'] });
  const created = await fb.createApartment(typeKey, num, req.body);
  await logAction(req, 'apartment.create', fb.unitKeyOf(typeKey, num));
  res.status(201).json(created);
}));
router.put('/apartments/:typeKey/:num', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { typeKey, num } = req.params;
  const updated = await fb.updateApartment(typeKey, num, req.body || {});
  await logAction(req, 'apartment.update', fb.unitKeyOf(typeKey, num), { fields: Object.keys(req.body || {}) });
  res.json(updated);
}));

// priceCheck se calcula acá (no en fb.listReservations, que también usa la IA por
// getReservationByCode) — el panel es el único consumidor que necesita esta alerta; ver
// pricing.priceIntegrityCheck para el porqué (el sitio web calcula el precio en el navegador
// y lo escribe directo a Firebase, sin que ningún backend lo recalculara hasta ahora).
async function attachPriceCheck(records) {
  return Promise.all(records.map(async (r) => {
    if (r.type !== 'reserva' || r.estTotal == null) return r;
    const apt = await fb.getApartment(r.unitType, r.unitNum);
    const priceCheck = pricing.priceIntegrityCheck(r, apt);
    return priceCheck ? { ...r, priceCheck } : r;
  }));
}

router.get('/reservations', STAFF, asyncHandler(async (_req, res) => {
  res.json(await attachPriceCheck(await fb.listReservations()));
}));

router.get('/visits', STAFF, asyncHandler(async (_req, res) => {
  res.json(await fb.listVisits());
}));

// Un código puede ser de reserva o de cita — getReservationByCode ya prueba ambos árboles
// (reservationsManager/reservations y /visits), igual que el resto del backend.
router.get('/records/:code', STAFF, asyncHandler(async (req, res) => {
  const rec = await fb.getReservationByCode(req.params.code.toUpperCase());
  if (!rec) return res.status(404).json({ error: 'not-found' });
  const [withPriceCheck] = await attachPriceCheck([rec]);
  res.json(withPriceCheck);
}));

router.get('/payment-info', STAFF, asyncHandler(async (_req, res) => {
  res.json(await fb.getPaymentInfo());
}));

// Solo lectura — categories es puramente navegación/agrupación (nombre "1 Ambiente"/
// "2 Ambientes" para filtrar), sin editor propio. Las fotos/descripciones (antes acá) ahora
// son parte de cada apartamento — ver sanitizeApartmentPatch/rooms en firebase.js.
router.get('/categories', ANY_STAFF, asyncHandler(async (_req, res) => {
  res.json(await fb.getCategories());
}));

// El panel usa esto para decidir qué mostrar en la navegación — la restricción REAL vive en
// requireRole/requireSuperAdmin en cada ruta sensible, esto es solo para que la UI sepa qué
// mostrar sin que el frontend tenga que conocer/hardcodear el correo del dueño por su cuenta.
// isSuperAdmin se conserva (compatibilidad con el panel ya desplegado) — equivale exactamente
// a role === 'owner'.
router.get('/me', asyncHandler(async (req, res) => {
  res.json({
    uid: req.adminUser.uid,
    email: req.adminUser.email,
    role: req.adminUser.role,
    isSuperAdmin: req.adminUser.role === 'owner',
  });
}));

// --- Reserva manual (el admin crea a nombre de un cliente) ---
// MISMA fórmula/forma que businessTools.createReservationHold — status:'pendiente' + HOLD de
// 15 minutos SIEMPRE, sin atajo especial de admin (igual que ReservationService.cs de Unity:
// si se quiere confirmada de una, es un Confirm aparte después, no una tercera ruta inventada).
// Idempotencia (sección 25 del pedido): un doble-click en "Crear reserva" desde el panel, o un
// reintento de red, no debe dejar dos reservas distintas para el mismo intento — el panel manda
// un Idempotency-Key por request real (ver api.ts), un reintento real reusa la misma. TODO el
// trabajo (armar el registro + reclamo de fechas + escritura) vive DENTRO de withIdempotency, no
// solo la escritura final: si building/disponibilidad corriera afuera, un reintento de una
// solicitud que YA tuvo éxito volvería a chequear disponibilidad contra sus propias noches
// recién reclamadas y fallaría con 'conflict' en vez de devolver el resultado cacheado — el
// punto entero de la idempotencia es no rehacer NADA del trabajo, no solo el paso final.
router.post('/reservations', STAFF, asyncHandler(async (req, res) => {
  const created = await fb.withIdempotency(req.headers['idempotency-key'], async () => {
    const rec = await reservationBuilder.buildReservationRecord(req.body || {});
    const rec2 = await fb.createReservation(rec);
    await logAction(req, 'reservation.create_manual', rec2.code, { unitType: rec2.unitType, unitNum: rec2.unitNum });
    return rec2;
  });
  // Fire-and-forget — mismo evento que dispara POST /reservations del sitio público, para que el
  // resto del staff (no solo quien la creó acá) se entere igual.
  fb.notifyAllStaff({
    type: 'reservation', targetCode: created.code,
    message: `Nueva reserva manual ${created.code} — ${created.unitLabel} · ${created.name}`,
  }).catch(() => {});
  res.status(201).json(created);
}));

// --- Check-in / check-out real — registrado ANTES de /records/:code/:action a propósito:
// Express matchea rutas en orden de registro, y ese comodín de abajo acepta CUALQUIER string
// como :action (cae a 400 'invalid-action' recién DENTRO del handler) — si estas dos rutas más
// específicas quedaran después, nunca se alcanzarían (bug real encontrado probando en vivo:
// "check-in" llegaba como :action al comodín en vez de a esta ruta). ---
router.post('/records/:code/check-in', STAFF, asyncHandler(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const result = await fb.checkInReservation(code);
  await logAction(req, 'reservation.check_in', code);
  notifyByWhatsApp(result, `🔑 Registramos tu check-in para la reserva ${result.code}. ¡Bienvenido!`);
  res.json(result);
}));
router.post('/records/:code/check-out', STAFF, asyncHandler(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const result = await fb.checkOutReservation(code);
  await logAction(req, 'reservation.check_out', code);
  notifyByWhatsApp(result, `👋 Registramos tu check-out para la reserva ${result.code}. ¡Gracias por tu visita!`);
  res.json(result);
}));

// --- Confirmar / rechazar / cancelar / completar — vale para reservas Y citas por igual, es
// la misma máquina de estados (setReservationStatus ya distingue el tipo internamente). ---
const STATUS_ACTIONS = {
  confirm: fb.confirmReservation,
  reject: fb.rejectReservation,
  cancel: fb.cancelReservation,
  complete: fb.completeReservation,
};
// Correo por cada una de las 4 acciones (antes solo cancel lo hacía) — "cualquier cambio de
// estado" del pedido nuevo, no solo cancelación.
const STATUS_EMAIL_FN = {
  confirm: emailService.sendReservationConfirmed,
  reject: emailService.sendReservationRejected,
  cancel: emailService.sendReservationCancelled,
  complete: emailService.sendReservationCompleted,
};
router.post('/records/:code/:action', STAFF, asyncHandler(async (req, res) => {
  const { action } = req.params;
  const fn = STATUS_ACTIONS[action];
  if (!fn) return res.status(400).json({ error: 'invalid-action' });
  const code = req.params.code.toUpperCase();
  const updated = await fn(code);
  if (!updated) return res.status(404).json({ error: 'not-found' });
  await logAction(req, `record.${action}`, code);
  notifyByEmail(STATUS_EMAIL_FN[action], updated);
  notifyByWhatsApp(updated, STATUS_WHATSAPP_TEXT[action](updated));
  res.json(updated);
}));

// Editar datos bancarios — antes de esto solo se podía cambiar a mano en la consola de
// Firebase. Restringido al super admin (no cualquier admin): son los datos donde los clientes
// depositan dinero real, el mismo nivel de sensibilidad que crear/revocar otros admins.
router.put('/payment-info', requireSuperAdmin, asyncHandler(async (req, res) => {
  const updated = await fb.setPaymentInfo(req.body || {});
  await logAction(req, 'payment_info.update', null, { accountHolder: updated.accountHolder });
  res.json(updated);
}));

// --- Usuarios (Administradores + Empleados) — todo detrás de requireSuperAdmin (OWNER): el
// pedido es explícito en que SOLO el dueño puede crear/editar/deshabilitar cuenta alguna, un
// admin normal ni siquiera puede LISTAR a los demás. Reemplaza el antiguo /admins (un solo
// consumidor, el propio panel, actualizado en el mismo cambio — ver Users.tsx). ---
router.get('/users', requireSuperAdmin, asyncHandler(async (_req, res) => {
  res.json(await fb.listUsersWithRoles());
}));

const CREATABLE_ROLES = new Set(['admin', 'employee']);
router.post('/users', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { email, password, role } = req.body || {};
  const missing = [];
  if (!email) missing.push('email');
  if (!password || String(password).length < 6) missing.push('password (mínimo 6 caracteres)');
  if (!CREATABLE_ROLES.has(role)) missing.push("rol ('admin' o 'employee')");
  if (missing.length > 0) return res.status(400).json({ error: 'invalid', missingFields: missing });
  // OWNER nunca se crea por acá — es siempre config.superAdminEmail, no un dato asignable
  // (ver adminAuth.attachRole). CREATABLE_ROLES ya excluye 'owner' por diseño, no por accidente.
  const created = await fb.createStaffUser(email, password, role, req.adminUser.email);
  await logAction(req, 'user.create', created.uid, { email: created.email, role });
  res.status(201).json(created);
}));

// Deshabilitar/rehabilitar en vez de borrar — reversible, y ningún dato de reservas/pagos/
// tareas que esa cuenta haya tocado queda huérfano (nunca fue dueña de nada, solo actuaba). No
// se puede desactivar a sí mismo: evita que el dueño quede fuera por accidente (y, de paso, que
// un futuro cambio de rol de la propia cuenta del dueño tenga sentido — hoy es imposible porque
// el dueño nunca aparece en este listado con un uid editable vía esta ruta más que el suyo).
router.post('/users/:uid/disable', requireSuperAdmin, asyncHandler(async (req, res) => {
  if (req.params.uid === req.adminUser.uid) return res.status(400).json({ error: 'cannot-disable-self' });
  const updated = await fb.setAdminUserDisabled(req.params.uid, true);
  await logAction(req, 'user.disable', req.params.uid, { email: updated.email });
  res.json(updated);
}));
router.post('/users/:uid/enable', requireSuperAdmin, asyncHandler(async (req, res) => {
  const updated = await fb.setAdminUserDisabled(req.params.uid, false);
  await logAction(req, 'user.enable', req.params.uid, { email: updated.email });
  res.json(updated);
}));

// Cambiar admin<->employee — nunca 'owner' (ver CREATABLE_ROLES). Ya detrás de
// requireSuperAdmin, así que ni un admin ni un empleado pueden alcanzar esta ruta para
// elevarse a sí mismos — la única cuenta que puede llamarla es la que YA es dueña de todo.
router.put('/users/:uid/role', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { role } = req.body || {};
  if (!CREATABLE_ROLES.has(role)) return res.status(400).json({ error: 'invalid-role' });
  const updated = await fb.setUserRole(req.params.uid, role, req.adminUser.email);
  await logAction(req, 'user.set_role', req.params.uid, { role });
  res.json(updated);
}));

// --- Pagos ---
router.post('/payments/:code/verify', STAFF, asyncHandler(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const result = await fb.verifyPayment(code);
  await logAction(req, 'payment.verify', code);
  notifyByEmail(emailService.sendPaymentVerified, result);
  notifyByWhatsApp(result, `✅ Confirmamos tu pago de la reserva ${result.code}. Sigue el proceso normal de confirmación — te avisamos en cuanto quede confirmada.`);
  res.json(result);
}));
router.post('/payments/:code/reject', STAFF, asyncHandler(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const result = await fb.rejectPayment(code);
  await logAction(req, 'payment.reject', code);
  notifyByEmail(emailService.sendPaymentRejected, result);
  notifyByWhatsApp(result, `⚠️ No pudimos verificar el pago reportado para tu reserva ${result.code}. Escríbenos por acá para resolverlo.`);
  res.json(result);
}));
router.post('/payments/:code/register-cash', STAFF, asyncHandler(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const result = await fb.registerCashPayment(code);
  await logAction(req, 'payment.register_cash', code);
  res.json(result);
}));

// --- Contratos (remake completo — sección 5 del pedido nuevo, ver el comentario grande arriba
// de la sección de Contratos en firebase.js para el porqué del modelo) ---
router.get('/contracts', STAFF, asyncHandler(async (_req, res) => {
  res.json(await fb.listContracts());
}));
router.post('/contracts', STAFF, asyncHandler(async (req, res) => {
  const { unitType, unitNum, unitLabel, tenants, startDate, endDate, monthlyRent } = req.body || {};
  const missing = [];
  if (!unitType || !unitNum) missing.push('apartamento');
  if (!Array.isArray(tenants) || tenants.filter((t) => t?.name && t?.documentId).length === 0) missing.push('arrendatario(s)');
  if (!startDate || !endDate) missing.push('fecha de inicio/fin');
  if (!monthlyRent || Number(monthlyRent) <= 0) missing.push('renta mensual (canon)');
  if (missing.length > 0) return res.status(400).json({ error: 'invalid', missingFields: missing });
  const created = await fb.createContract({ ...req.body, unitLabel: unitLabel || `Apartamento H${unitNum}`, createdBy: req.adminUser.email });
  await logAction(req, 'contract.create', created.code, { unitType, unitNum });

  // Correo con el CONTRATO real (documento legal completo, ver contractDocPdf.js) — se manda una
  // sola vez, al crearlo, distinto del recibo de cada abono (ese se manda en /contracts/:code/
  // payments). Igual que el resto de este archivo: un fallo acá nunca revierte el contrato ya
  // creado, que es la acción real y ya tuvo éxito.
  let documentEmailSent = false;
  try {
    const pdfBuffer = await generateContractDocumentPdf(created);
    documentEmailSent = (await emailService.sendContractDocument(created, pdfBuffer)).sent;
  } catch (err) {
    console.error('[adminRoutes] No se pudo generar/enviar el documento del contrato:', err.message);
  }
  const tenantPhone = (created.tenants || []).find((t) => t.phone)?.phone;
  if (tenantPhone) {
    notifyByWhatsApp({ phone: tenantPhone, code: created.code },
      `📄 Registramos tu contrato ${created.code} — ${created.unitLabel}. Te enviamos el documento completo por correo.`);
  }
  res.status(201).json({ ...created, documentEmailSent });
}));
const CONTRACT_STATUSES = new Set(['activo', 'finalizado', 'cancelado']);
router.post('/contracts/:code/status', STAFF, asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  if (!CONTRACT_STATUSES.has(status)) return res.status(400).json({ error: 'invalid-status' });
  const code = req.params.code.toUpperCase();
  const result = await fb.setContractStatus(code, status);
  await logAction(req, 'contract.set_status', code, { status });
  res.json(result);
}));

// Registrar un abono — a diferencia de las demás acciones de este archivo, ESTA sí espera a que
// el correo con el PDF adjunto termine de intentar mandarse antes de responder (no es
// fire-and-forget como notifyByEmail): el PDF hay que generarlo síncronamente para adjuntarlo, y
// como ya estamos ahí, más vale confirmarle al panel si el correo salió o no en vez de dejarlo
// adivinando. Un fallo de correo/WhatsApp NUNCA revierte el abono ya guardado — eso ya pasó con
// éxito antes de intentar notificar, mismo criterio de "la acción real nunca depende del envío"
// del resto del archivo.
router.post('/contracts/:code/payments', STAFF, asyncHandler(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { lines, date } = req.body || {};
  const { contract, payment } = await fb.addContractPayment(code, { lines, date });
  await logAction(req, 'contract.add_payment', code, { receiptNumber: payment.receiptNumber });

  let emailResult = { sent: false };
  try {
    const [receiptPdfBuffer, contractPdfBuffer] = await Promise.all([
      generateContractReceiptPdf(contract, payment),
      generateContractDocumentPdf(contract),
    ]);
    emailResult = await emailService.sendContractReceipt(contract, payment, receiptPdfBuffer, contractPdfBuffer);
  } catch (err) {
    console.error('[adminRoutes] No se pudo generar/enviar el contrato+recibo del abono:', err.message);
  }
  const tenantPhone = (contract.tenants || []).find((t) => t.phone)?.phone;
  if (tenantPhone) {
    notifyByWhatsApp({ phone: tenantPhone, code: contract.code },
      `🧾 Registramos tu abono del contrato ${contract.code} — recibo N.° ${payment.receiptNumber}. Saldo pendiente del período: ${fmtCOPForWhatsApp(payment.balanceAfter)}.`);
  }
  res.status(201).json({ contract, payment, emailSent: emailResult.sent });
}));

// Descarga bajo demanda — el PDF nunca se guarda, se regenera siempre a partir de los mismos
// datos ya persistidos del contrato/abono (mismo criterio que el resto del proyecto: nunca
// duplicar una fuente de verdad que ya existe en Firebase).
router.get('/contracts/:code/payments/:receiptNumber/pdf', STAFF, asyncHandler(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const contracts = await fb.listContracts();
  const contract = contracts.find((c) => c.code === code);
  if (!contract) return res.status(404).json({ error: 'not-found' });
  const payment = (contract.payments || []).find((p) => String(p.receiptNumber) === req.params.receiptNumber);
  if (!payment) return res.status(404).json({ error: 'not-found' });
  const pdfBuffer = await generateContractReceiptPdf(contract, payment);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="recibo-${contract.code}-${payment.receiptNumber}.pdf"`);
  res.send(pdfBuffer);
}));

// El documento del contrato en sí (no un abono) — mismo criterio de "nunca se guarda, se
// regenera on-demand" que el recibo de arriba.
router.get('/contracts/:code/document/pdf', STAFF, asyncHandler(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const contracts = await fb.listContracts();
  const contract = contracts.find((c) => c.code === code);
  if (!contract) return res.status(404).json({ error: 'not-found' });
  const pdfBuffer = await generateContractDocumentPdf(contract);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="contrato-${contract.code}.pdf"`);
  res.send(pdfBuffer);
}));

// Un empleado solo ve/actúa sobre lo que se le asignó (Least Privilege, sección 4 del pedido);
// owner/admin ven todo. `assignedTo` guarda un uid real desde que existe el picker de empleados
// en el panel — tareas viejas con texto libre en ese campo simplemente no calzan con ningún uid
// y quedan invisibles para empleados (correcto: nunca fueron asignadas a una cuenta real).
function scopeToEmployee(req, list) {
  if (req.adminUser.role !== 'employee') return list;
  return list.filter((t) => t.assignedTo === req.adminUser.uid);
}
// Ídem para una sola tarea/ticket: un empleado que intenta actuar sobre algo que no es suyo
// recibe 404, no 403 — no le confirmamos ni siquiera que el código existe (mismo criterio que
// el resto del backend usa para no filtrar existencia a quien no tiene por qué saberla).
function assertOwnedByEmployeeOrStaff(req, record) {
  if (!record) { const e = new Error('not-found'); e.code = 'not-found'; throw e; }
  if (req.adminUser.role === 'employee' && record.assignedTo !== req.adminUser.uid) {
    const e = new Error('not-found'); e.code = 'not-found'; throw e;
  }
}
async function notifyAssignee(assignedTo, { type, message, targetCode }) {
  if (!assignedTo) return;
  try { await fb.createNotification(assignedTo, { type, message, targetCode }); }
  catch (err) { console.error('[adminRoutes] No se pudo crear la notificación:', err.message); }
}

// Lista mínima de empleados para el selector de "asignar a" en Aseo/Mantenimiento — un admin
// operativo (no solo el dueño) necesita saber a quién puede asignarle una tarea, pero NO debe
// poder crear/deshabilitar/cambiar el rol de nadie (eso sigue exclusivamente en /users, detrás
// de requireSuperAdmin). STAFF, no ANY_STAFF: un empleado no necesita ver a otros empleados.
router.get('/employees', STAFF, asyncHandler(async (_req, res) => {
  const users = await fb.listUsersWithRoles();
  res.json(users.filter((u) => u.role === 'employee' && !u.disabled).map((u) => ({ uid: u.uid, email: u.email })));
}));

// --- Aseo ---
router.get('/cleaning', ANY_STAFF, asyncHandler(async (req, res) => {
  res.json(scopeToEmployee(req, await fb.listCleaningTasks()));
}));
router.post('/cleaning', STAFF, asyncHandler(async (req, res) => {
  const { unitType, unitNum, unitLabel, scheduledDate, assignedTo } = req.body || {};
  const missing = [];
  if (!unitType || !unitNum) missing.push('apartamento');
  if (!scheduledDate) missing.push('fecha programada');
  if (missing.length > 0) return res.status(400).json({ error: 'invalid', missingFields: missing });
  const created = await fb.createCleaningTask({ ...req.body, unitLabel: unitLabel || `Apartamento H${unitNum}` });
  await logAction(req, 'cleaning.create', created.code, { unitType, unitNum, assignedTo: assignedTo || null });
  await notifyAssignee(assignedTo, { type: 'cleaning', message: `Aseo asignado — ${created.unitLabel} (${created.scheduledDate})`, targetCode: created.code });
  res.status(201).json(created);
}));
const CLEANING_STATUSES = new Set(['pendiente', 'en-progreso', 'completado']);
router.post('/cleaning/:code/status', ANY_STAFF, asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  if (!CLEANING_STATUSES.has(status)) return res.status(400).json({ error: 'invalid-status' });
  const code = req.params.code.toUpperCase();
  assertOwnedByEmployeeOrStaff(req, await fb.getCleaningTaskByCode(code));
  const result = await fb.setCleaningStatus(code, status);
  await logAction(req, 'cleaning.set_status', code, { status });
  res.json(result);
}));

// --- Mantenimiento ---
router.get('/maintenance', ANY_STAFF, asyncHandler(async (req, res) => {
  res.json(scopeToEmployee(req, await fb.listMaintenanceTickets()));
}));
router.post('/maintenance', STAFF, asyncHandler(async (req, res) => {
  const { unitType, unitNum, unitLabel, title, assignedTo } = req.body || {};
  const missing = [];
  if (!unitType || !unitNum) missing.push('apartamento');
  if (!title || !String(title).trim()) missing.push('título');
  if (missing.length > 0) return res.status(400).json({ error: 'invalid', missingFields: missing });
  const created = await fb.createMaintenanceTicket({ ...req.body, unitLabel: unitLabel || `Apartamento H${unitNum}`, reportedBy: req.adminUser.email });
  await logAction(req, 'maintenance.create', created.code, { unitType, unitNum, assignedTo: assignedTo || null });
  await notifyAssignee(assignedTo, { type: 'maintenance', message: `Mantenimiento asignado — ${created.unitLabel}: ${created.title}`, targetCode: created.code });
  res.status(201).json(created);
}));
const MAINTENANCE_STATUSES = new Set(['abierto', 'en-progreso', 'resuelto']);
router.post('/maintenance/:code/status', ANY_STAFF, asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  if (!MAINTENANCE_STATUSES.has(status)) return res.status(400).json({ error: 'invalid-status' });
  const code = req.params.code.toUpperCase();
  assertOwnedByEmployeeOrStaff(req, await fb.getMaintenanceTicketByCode(code));
  const result = await fb.setMaintenanceStatus(code, status);
  await logAction(req, 'maintenance.set_status', code, { status });
  res.json(result);
}));

// --- Tráfico del sitio público (solo lectura acá — la escritura la hace /track/pageview en
// app.js, público y sin requireAdminAuth, ver ahí el porqué). ---
router.get('/site-traffic', STAFF, asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
  res.json(await fb.getSiteTraffic(days));
}));

// --- Notificaciones — cada cuenta (owner/admin/employee) solo lee/marca las suyas, nunca las
// de otro; no hace falta requireSuperAdmin acá porque el propio uid del token ya delimita el
// alcance (mismo criterio que "reservación por código exacto" en el sitio público: el acceso lo
// da SER el dueño del recurso, no un rol adicional). ---
router.get('/notifications', ANY_STAFF, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  res.json(await fb.listNotificationsForUser(req.adminUser.uid, limit));
}));
router.post('/notifications/:id/read', ANY_STAFF, asyncHandler(async (req, res) => {
  await fb.markNotificationRead(req.adminUser.uid, req.params.id);
  res.json({ ok: true });
}));

// Suscripción push del navegador/dispositivo actual — mismo criterio de acceso que
// /notifications (el propio uid del token ya delimita el alcance, cualquier staff gestiona la
// suya). El body es el objeto PushSubscription tal cual lo entrega el navegador
// (PushSubscription.toJSON(): {endpoint, keys:{p256dh,auth}}).
router.post('/push/subscribe', ANY_STAFF, asyncHandler(async (req, res) => {
  await fb.savePushSubscription(req.adminUser.uid, req.body || {});
  res.status(201).json({ ok: true });
}));
router.post('/push/unsubscribe', ANY_STAFF, asyncHandler(async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'invalid' });
  await fb.removePushSubscription(req.adminUser.uid, endpoint);
  res.json({ ok: true });
}));

// --- Bitácora de acciones administrativas — mismo nivel de sensibilidad que /admins y
// /payment-info (quién hizo qué le importa sobre todo al dueño, no a cualquier admin operativo).
router.get('/audit-log', requireSuperAdmin, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  res.json(await fb.listAuditLog(limit));
}));

module.exports = router;
