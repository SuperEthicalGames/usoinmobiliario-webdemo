const PDFDocument = require('pdfkit');

// Recibo de abono de contrato — sección 5 del pedido nuevo ("nuevos datos sobre los contratos
// reales... este contrato es enviado al correo"). Diseño propio en la identidad del proyecto
// (grafito/dorado, mismos tonos que BRAND en emailService.js), NO una réplica pixel-perfecta de
// la plantilla de Excel real que se mandó como referencia — pero SÍ con todos los mismos campos
// legales/de negocio que trae esa factura real (canon, período, cada línea de pago por separado,
// saldo pendiente, arrendatario(s), NIT/matrícula del arrendador).
const BRAND = { forest: '#23262b', clay: '#a5761c', ink: '#1a1d21', muted: '#6b6f76', line: '#d8d3c8' };

// Identidad legal fija del arrendador — un solo negocio, un solo arrendador, nunca varía por
// contrato (a diferencia de los datos bancarios en settings/paymentInfo, que sí son editables
// desde el panel). Extraído del contrato real de referencia (CONTRATO C351 PENSIÓN).
const LANDLORD = {
  name: 'Carlos Alberto Zapata Mesa',
  business: 'USOINMOBILIARIO',
  nit: '71687033-1',
  matricula: 'Matrícula de arrendador de vivienda urbana No. 0049/15',
  address: 'Laureles, Medellín',
};

const METHOD_LABELS = { transferencia: 'Transferencia', efectivo: 'Efectivo', otro: 'Otro concepto' };
const TERM_LABELS = { semanal: 'Semanal', quincenal: 'Quincenal', mensual: 'Mensual' };

function fmtCOP(n) {
  const value = Math.round(Number(n) || 0);
  return '$' + String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function row(doc, x, y, label, value, opts = {}) {
  doc.font('Helvetica').fontSize(9.5).fillColor(BRAND.muted).text(label, x, y, { continued: false });
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(BRAND.ink)
    .text(value, x + 150, y, { width: 300 });
}

// Genera el PDF en memoria (Buffer) — nunca toca disco, se adjunta directo al correo (Resend
// acepta el attachment en base64) y se sirve igual on-demand desde el endpoint de descarga, sin
// necesidad de guardarlo en ningún lado.
function generateContractReceiptPdf(contract, payment) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // --- Encabezado ---
    doc.rect(0, 0, doc.page.width, 90).fill(BRAND.forest);
    doc.fillColor('#f8f4ea').font('Helvetica-Bold').fontSize(10).text('USOINMOBILIARIO', 50, 28, { characterSpacing: 1.5 });
    doc.fontSize(18).text('Recibo de abono', 50, 44);
    doc.font('Helvetica').fontSize(9).fillColor('#f8f4ea').text(`Recibo N.° ${payment.receiptNumber}`, 50, 68);
    doc.text(`Fecha: ${fmtDate(payment.date)}`, doc.page.width - 250, 68, { width: 200, align: 'right' });

    let y = 112;
    doc.fillColor(BRAND.ink).font('Helvetica-Bold').fontSize(11).text('Arrendador', 50, y);
    y += 16;
    row(doc, 50, y, 'Nombre', LANDLORD.name); y += 14;
    row(doc, 50, y, 'Negocio', LANDLORD.business); y += 14;
    row(doc, 50, y, 'NIT', LANDLORD.nit); y += 14;
    row(doc, 50, y, 'Matrícula', LANDLORD.matricula); y += 14;
    row(doc, 50, y, 'Dirección', LANDLORD.address); y += 24;

    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor(BRAND.line).stroke(); y += 16;

    doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND.ink).text('Contrato', 50, y); y += 16;
    row(doc, 50, y, 'Código', contract.code, { bold: true }); y += 14;
    row(doc, 50, y, 'Unidad', `${contract.unitLabel} · ${contract.roomCode || '—'}`); y += 14;
    row(doc, 50, y, 'Ocupación máxima', `${contract.maxOccupancy || 1} persona(s)`); y += 14;
    row(doc, 50, y, 'Canon mensual', fmtCOP(contract.monthlyRent)); y += 14;
    row(doc, 50, y, 'Término de pago', TERM_LABELS[contract.paymentTerm] || contract.paymentTerm); y += 14;
    row(doc, 50, y, 'Vigencia', `${fmtDate(contract.startDate)} — ${fmtDate(contract.endDate)}`); y += 24;

    doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND.ink).text('Arrendatario(s) solidario(s)', 50, y); y += 16;
    for (const tenant of contract.tenants || []) {
      row(doc, 50, y, tenant.name, `CC ${tenant.documentId}${tenant.phone ? ` · ${tenant.phone}` : ''}`); y += 14;
    }
    if (contract.jointDebtor && contract.jointDebtor.name) {
      y += 4;
      row(doc, 50, y, 'Deudor solidario', `${contract.jointDebtor.name} · CC ${contract.jointDebtor.documentId}`); y += 14;
    }
    y += 10;

    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor(BRAND.line).stroke(); y += 16;

    doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND.ink)
      .text(`Período: ${fmtDate(payment.periodStart)} — ${fmtDate(payment.periodEnd)}`, 50, y);
    y += 22;

    // --- Tabla de líneas de pago (una fila por línea del abono, igual que la factura real:
    // transferencia + efectivo como líneas separadas de un mismo abono — 'otro' además imprime
    // su descripción libre, para comisiones de referidos u otros acuerdos no monetarios). ---
    const colX = { method: 50, desc: 180, amount: doc.page.width - 150 };
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#f8f4ea');
    doc.rect(50, y, doc.page.width - 100, 20).fill(BRAND.forest);
    doc.fillColor('#f8f4ea').text('Concepto', colX.method, y + 6);
    doc.text('Descripción', colX.desc, y + 6);
    doc.text('Monto', colX.amount, y + 6, { width: 100, align: 'right' });
    y += 24;

    let total = 0;
    doc.font('Helvetica').fontSize(9.5).fillColor(BRAND.ink);
    for (const line of payment.lines || []) {
      total += Number(line.amount) || 0;
      doc.text(METHOD_LABELS[line.method] || line.method, colX.method, y, { width: 120 });
      doc.text(line.description || '—', colX.desc, y, { width: 180 });
      doc.text(fmtCOP(line.amount), colX.amount, y, { width: 100, align: 'right' });
      y += 16;
    }
    y += 6;
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor(BRAND.line).stroke(); y += 12;

    doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND.ink);
    doc.text('Total abono', colX.desc, y, { width: 180 });
    doc.text(fmtCOP(total), colX.amount, y, { width: 100, align: 'right' });
    y += 18;

    doc.font('Helvetica-Bold').fontSize(11).fillColor(payment.balanceAfter > 0 ? '#b3541e' : BRAND.clay);
    doc.text('Saldo pendiente del período', colX.desc, y, { width: 180 });
    doc.text(fmtCOP(payment.balanceAfter), colX.amount, y, { width: 100, align: 'right' });
    y += 30;

    doc.font('Helvetica').fontSize(8).fillColor(BRAND.muted)
      .text('Uso Inmobiliario · Laureles, Medellín — recibo generado automáticamente por el panel administrativo.', 50, doc.page.height - 60, {
        width: doc.page.width - 100, align: 'center',
      });

    doc.end();
  });
}

module.exports = { generateContractReceiptPdf };
