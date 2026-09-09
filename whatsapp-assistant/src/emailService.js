const nodemailer = require('nodemailer');
const config = require('../config');
const fb = require('./firebase');

// Correo transaccional real, $0 (sección "correo gratis" del plan) — reemplaza el Worker de
// Cloudflare + Amazon SES anterior (bloqueado por depender de una cuenta AWS que el usuario no
// controla de forma confiable). Envía por SMTP de Gmail usando la cuenta real del negocio
// (usoinmobiliario@gmail.com + una "contraseña de aplicación", nunca la contraseña normal de
// la cuenta) desde este backend, que ya está siempre encendido en Render — sin dominio que
// verificar, sin cuenta de terceros. Límite real de Gmail: 500 destinatarios/día, de sobra
// para este negocio.
//
// Puerto EXACTO del diseño ya construido en index.html (EmailTemplate.reservationCreatedHtml,
// EmailService.sendReservationCreated, reservationDisplayStatus) — no se rediseña la plantilla,
// solo se traslada a Node porque ahora el envío ocurre en el servidor, no en el navegador.

function isConfigured() {
  return !!(config.email.gmailUser && config.email.gmailAppPassword);
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.email.gmailUser, pass: config.email.gmailAppPassword },
  });
  return transporter;
}

const MONTHS_LONG = {
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};

// Fechas de estadía (solo fecha, sin hora): se parsean como UTC para no arrastrar el desfase
// de zona horaria de quien procesa el envío — mismo criterio que nightsBetween en dateUtil.js.
function fmtLongDate(isoDateStr, lang) {
  const [y, m, d] = String(isoDateStr).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${date.getUTCDate()} de ${MONTHS_LONG[lang][date.getUTCMonth()]} de ${date.getUTCFullYear()}`;
}

// expiresAt sí es un instante real (epoch ms) — se muestra en hora de Colombia (Bogotá,
// UTC-5 todo el año, sin horario de verano), la zona del negocio.
function fmtBogotaDateTime(epochMs, lang) {
  try {
    return new Date(epochMs).toLocaleString(lang === 'es' ? 'es-CO' : 'en-US', {
      timeZone: 'America/Bogota', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return new Date(epochMs).toISOString();
  }
}

function fmtCOP(n) {
  if (n === 0) return '$0';
  return '$' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function esc(s) {
  return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Puerto de reservationDisplayStatus() (index.html) — solo las ramas de 'reserva' (esta
// función nunca se llama para citas, ver el guard por tipo en sendReservationConfirmation),
// mismos textos ES/EN ya usados en el resto del sitio.
const STATUS_LABELS = {
  es: {
    holdPendiente: 'Reserva temporal · pago pendiente',
    pagoReportado: 'Pago reportado · en verificación',
    pagoVerificado: 'Pago verificado · confirmando tu reserva',
    pagoRechazado: 'Pago rechazado · escríbenos por WhatsApp',
    confirmada: 'Reserva confirmada',
    rechazada: 'Reserva rechazada',
    expirada: 'Reserva expirada',
    cancelada: 'Reserva cancelada',
    completada: 'Reserva completada',
  },
  en: {
    holdPendiente: 'Temporary hold · payment pending',
    pagoReportado: 'Payment reported · under review',
    pagoVerificado: 'Payment verified · confirming your booking',
    pagoRechazado: 'Payment rejected · message us on WhatsApp',
    confirmada: 'Booking confirmed',
    rechazada: 'Booking rejected',
    expirada: 'Booking expired',
    cancelada: 'Booking cancelled',
    completada: 'Booking completed',
  },
};

function isHoldExpired(rec) {
  return rec.type === 'reserva' && rec.status === 'pendiente' && !!rec.expiresAt
    && rec.paymentStatus !== 'submitted' && rec.expiresAt < Date.now();
}

function reservationDisplayStatus(rec, lang) {
  const L = STATUS_LABELS[lang];
  if (rec.status === 'cancelada') return L.cancelada;
  if (rec.status === 'rechazada') return L.rechazada;
  if (rec.status === 'completada') return L.completada;
  if (rec.status === 'confirmada') return L.confirmada;
  if (isHoldExpired(rec)) return L.expirada;
  if (rec.paymentStatus === 'rejected') return L.pagoRechazado;
  if (rec.paymentStatus === 'verified') return L.pagoVerificado;
  if (rec.paymentStatus === 'submitted') return L.pagoReportado;
  return L.holdPendiente;
}

// Tabla HTML con estilos inline (nada de flex/grid ni fuentes externas obligatorias) para que
// se vea razonablemente bien en Gmail/Outlook/Apple Mail/móviles sin depender de soporte
// moderno de CSS en el cliente de correo — mismo diseño exacto que ya existía en index.html.
function reservationCreatedHtml(rec, categoryLabel, lang) {
  const isEs = lang === 'es';
  const statusLine = reservationDisplayStatus(rec, lang);
  const holdRow = (rec.expiresAt && rec.paymentStatus !== 'submitted') ? (
    `<tr><td style="padding:6px 0;color:#6b6b60;">${isEs ? 'HOLD válido hasta' : 'Hold valid until'}</td>`
    + `<td style="padding:6px 0;text-align:right;font-weight:700;">${esc(fmtBogotaDateTime(rec.expiresAt, lang))}</td></tr>`
  ) : '';
  const totalRow = (rec.estTotal != null) ? (
    `<tr><td style="padding:6px 0;color:#6b6b60;">${isEs ? 'Valor' : 'Total'}</td>`
    + `<td style="padding:6px 0;text-align:right;font-weight:700;">${esc(fmtCOP(rec.estTotal))}</td></tr>`
  ) : '';
  // El método de pago suele elegirse justo DESPUÉS de este primer correo (crear reserva ->
  // enviar correo -> mostrar confirmación -> ahí elegir pago) — casi nunca hay un método
  // definido todavía, así que mostrar datos bancarios acá sería prematuro.
  const nextStepHtml = rec.paymentMethod === 'bank_transfer'
    ? (isEs ? 'Realiza el pago con los datos que se muestran en tu reserva y luego reporta el pago (con el comprobante) desde ahí o por WhatsApp.' : 'Pay using the details shown on your booking page, then report the payment (with proof) from there or via WhatsApp.')
    : rec.paymentMethod === 'cash'
      ? (isEs ? 'El pago se realiza en efectivo de forma presencial, según las instrucciones de tu reserva.' : 'Payment is made in person, in cash, following the instructions on your booking page.')
      : (isEs ? 'Entra a tu reserva para elegir cómo prefieres pagar (transferencia o efectivo) y ver las instrucciones.' : "Open your booking to choose how you'd like to pay (bank transfer or cash) and see the instructions.");

  const manageUrl = `${config.siteBaseUrl}/#/mi-reserva?code=${encodeURIComponent(rec.code)}`;
  const waUrl = 'https://wa.me/573003848517?text=' + encodeURIComponent(isEs
    ? `Hola, tengo una pregunta sobre mi reserva ${rec.code}.`
    : `Hi, I have a question about my booking ${rec.code}.`);

  return ''
    + `<div style="background:#efe7d8;padding:24px 12px;font-family:Georgia,'Times New Roman',serif;color:#20241f;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#f5f0e6;border-radius:14px;overflow:hidden;">`
    + `<tr><td style="background:#33513f;padding:20px 28px;">`
    + `<div style="color:#f5f0e6;font-size:13px;letter-spacing:2px;text-transform:uppercase;">USO INMOBILIARIO</div>`
    + `<div style="color:#f5f0e6;font-size:20px;font-weight:700;margin-top:4px;">${isEs ? 'Reserva creada' : 'Booking created'}</div>`
    + `</td></tr>`
    + `<tr><td style="padding:24px 28px 8px;">`
    + `<p style="margin:0 0 14px;font-size:15px;">${isEs ? 'Hola, ' : 'Hi '}${esc(rec.name)}${isEs ? '. Hemos registrado tu solicitud de reserva.' : ". We've registered your booking request."}</p>`
    + `</td></tr>`
    + `<tr><td style="padding:0 28px;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e4d8c3;border-radius:12px;">`
    + `<tr><td style="padding:16px 20px;text-align:center;">`
    + `<div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#9c7b3f;">${isEs ? 'Código de reserva' : 'Booking code'}</div>`
    + `<div style="font-size:34px;font-weight:700;letter-spacing:4px;color:#33513f;margin-top:4px;">${esc(rec.code)}</div>`
    + `</td></tr>`
    + `</table>`
    + `</td></tr>`
    + `<tr><td style="padding:20px 28px 4px;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">`
    + `<tr><td style="padding:6px 0;color:#6b6b60;">${isEs ? 'Apartamento' : 'Apartment'}</td><td style="padding:6px 0;text-align:right;font-weight:700;">${esc(rec.unitLabel)}</td></tr>`
    + `<tr><td style="padding:6px 0;color:#6b6b60;">${isEs ? 'Tipo' : 'Type'}</td><td style="padding:6px 0;text-align:right;">${esc(categoryLabel || '—')}</td></tr>`
    + `<tr><td style="padding:6px 0;color:#6b6b60;">Check-in</td><td style="padding:6px 0;text-align:right;">${esc(fmtLongDate(rec.checkin, lang))}</td></tr>`
    + `<tr><td style="padding:6px 0;color:#6b6b60;">Check-out</td><td style="padding:6px 0;text-align:right;">${esc(fmtLongDate(rec.checkout, lang))}</td></tr>`
    + `<tr><td style="padding:6px 0;color:#6b6b60;">${isEs ? 'Noches' : 'Nights'}</td><td style="padding:6px 0;text-align:right;">${esc(rec.nights)}</td></tr>`
    + `<tr><td style="padding:6px 0;color:#6b6b60;">${isEs ? 'Huéspedes' : 'Guests'}</td><td style="padding:6px 0;text-align:right;">${esc(rec.guests)}</td></tr>`
    + totalRow
    + `<tr><td style="padding:6px 0;color:#6b6b60;">${isEs ? 'Estado' : 'Status'}</td><td style="padding:6px 0;text-align:right;font-weight:700;">${esc(statusLine)}</td></tr>`
    + holdRow
    + `</table>`
    + `</td></tr>`
    + `<tr><td style="padding:16px 28px;">`
    + `<div style="border-top:1px solid #b6603c33;padding-top:14px;font-size:13.5px;color:#6b6b60;text-transform:uppercase;letter-spacing:1px;">${isEs ? 'Siguiente paso' : 'Next step'}</div>`
    + `<p style="margin:8px 0 0;font-size:14.5px;">${esc(nextStepHtml)}</p>`
    + `</td></tr>`
    + `<tr><td style="padding:8px 28px 24px;">`
    + `<a href="${esc(manageUrl)}" style="display:inline-block;background:#33513f;color:#f5f0e6;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;font-size:14px;margin-right:8px;">${isEs ? 'Ver mi reserva' : 'View my booking'}</a>`
    + `<a href="${esc(waUrl)}" style="display:inline-block;background:#e4d8c3;color:#20241f;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;font-size:14px;">WhatsApp</a>`
    + `</td></tr>`
    + `<tr><td style="padding:16px 28px;background:#e4d8c3;text-align:center;font-size:12px;color:#6b6b60;">`
    + `Uso Inmobiliario · Laureles, Medellín`
    + `</td></tr>`
    + `</table>`
    + `</div>`;
}

// Límite básico por código — defensa adicional detrás de la verificación de correo de abajo.
// En memoria (se reinicia si el proceso se reinicia), igual que conversationStore.js —
// aceptable para este volumen, no es la protección principal.
const sendAttempts = new Map(); // code -> [timestamps]
const MAX_SENDS_PER_CODE_PER_HOUR = 5;
function rateLimited(code) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const attempts = (sendAttempts.get(code) || []).filter((t) => t > hourAgo);
  attempts.push(now);
  sendAttempts.set(code, attempts);
  return attempts.length > MAX_SENDS_PER_CODE_PER_HOUR;
}

// Único punto real de envío del correo de confirmación — lo llaman tanto la ruta HTTP nueva
// (index.html: envío inicial y reenvío desde "Mi reserva") como, en proceso y sin esperar
// (fire-and-forget), businessTools.createReservationHold cuando el bot crea una reserva.
//
// SIEMPRE busca el registro completo del lado del servidor por código — nunca confía en datos
// que mande el cliente, a diferencia del Worker de Cloudflare anterior — y EXIGE que el correo
// recibido coincida con el guardado en la reserva antes de mandar nada: los códigos son de
// lectura pública por diseño (database.rules.json), así que sin esto cualquiera que supiera/
// adivinara un código habría podido hacer que se le mandaran correos ilimitados a un
// desconocido (hallazgo real de la revisión de arquitectura de este plan, no una ocurrencia
// tardía) — el flujo de reenvío en index.html ya pedía el correo escrito por esta misma razón;
// este endpoint mantiene esa barrera para AMBOS casos de uso, no solo el reenvío.
async function sendReservationConfirmation({ code, email, lang }) {
  const language = lang === 'en' ? 'en' : 'es';
  const upperCode = String(code || '').trim().toUpperCase();
  const trimmedEmail = String(email || '').trim();
  if (!upperCode || !trimmedEmail) {
    const e = new Error('missing-code-or-email'); e.code = 'invalid'; throw e;
  }
  if (!isConfigured()) {
    const e = new Error('email-not-configured'); e.code = 'not-configured'; throw e;
  }
  if (rateLimited(upperCode)) {
    const e = new Error('rate-limited'); e.code = 'rate-limited'; throw e;
  }

  const rec = await fb.getReservationByCode(upperCode);
  if (!rec) { const e = new Error('reservation-not-found'); e.code = 'not-found'; throw e; }
  if (rec.type !== 'reserva') { const e = new Error('not-a-reservation'); e.code = 'invalid'; throw e; }
  if (!rec.email || String(rec.email).trim().toLowerCase() !== trimmedEmail.toLowerCase()) {
    const e = new Error('email-mismatch'); e.code = 'forbidden'; throw e;
  }

  const categories = await fb.getCategories();
  const category = categories[rec.unitType];
  const categoryLabel = category && category.catLabel ? category.catLabel[language] : '';

  const html = reservationCreatedHtml(rec, categoryLabel, language);
  const subject = (language === 'es' ? 'Tu reserva ' : 'Your booking ') + rec.code + (language === 'es' ? ' fue creada' : ' was created');

  const info = await getTransporter().sendMail({
    from: `"Uso Inmobiliario" <${config.email.gmailUser}>`,
    to: rec.email,
    subject,
    html,
  });
  return { sent: true, messageId: info.messageId };
}

module.exports = { sendReservationConfirmation, reservationCreatedHtml, reservationDisplayStatus, isConfigured };
