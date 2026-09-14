const PDFDocument = require('pdfkit');

// Documento de CONTRATO real — a diferencia de receiptPdf.js (que genera el recibo de cada
// ABONO), esto genera el contrato de arrendamiento en sí, una sola vez al crear el contrato.
// Pedido explícito del dueño tras revisar el primer diseño: "el correo del contrato no tiene el
// contrato como el original de carlos... automatizar el real... manteniendo lo real, lo de
// carlos" — así que el texto de las cláusulas de abajo es una transcripción VERBATIM del
// contrato real (CONTRATO C351 PENSIÓN.docx) que se pasó como referencia, con solo los datos
// variables de cada contrato sustituidos (arrendatario(s), documento(s), unidad, canon, fechas,
// deudor solidario, contacto). El resto del texto legal — incluida la dirección del inmueble
// (Circular 5 #69-51, San Joaquín) tal como aparece en el original — se deja tal cual: no hay un
// campo de dirección por apartamento en el sistema hoy, y todas las unidades son parte del mismo
// edificio/operación, así que se asume la misma dirección para todos los contratos.
const BRAND = { forest: '#23262b', clay: '#a5761c', ink: '#1a1d21', muted: '#6b6f76', line: '#d8d3c8' };

const LANDLORD = {
  name: 'CARLOS ALBERTO ZAPATA MESA',
  cedula: '71.687.033 DE MEDELLÍN',
  business: 'USOINMOBILIARIO',
  matricula: '0049/15',
  propertyAddress: 'CIRCULAR 5 #69-51',
  neighborhood: 'SAN JOAQUIN',
  noticeAddress: 'circular 5 carrera 69-53, interior 300',
  email: 'usoinmobiliario@gmail.com',
  billingEmail: 'cartera.usoinmobiliario@gmail.com',
  phone: '3136496615',
};

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function fmtDateLong(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return `día ${String(d).padStart(2, '0')} del mes de ${MONTHS_ES[m - 1].toUpperCase()} del año ${y}`;
}
function fmtCOP(n) {
  return '$' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
function monthsBetween(startIso, endIso) {
  const [sy, sm] = startIso.split('-').map(Number);
  const [ey, em] = endIso.split('-').map(Number);
  return Math.max(1, (ey - sy) * 12 + (em - sm));
}
function tenantListText(tenants) {
  const parts = tenants.map((t) => `${(t.name || '').toUpperCase()} con documento CÉDULA DE CIUDADANÍA número ${t.documentId}`);
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + ' Y ' + parts[parts.length - 1];
}
const TERM_LABELS = { semanal: 'SEMANAL', quincenal: 'QUINCENAL (15 días)', mensual: 'MENSUAL' };

// Arma el texto completo de las 24 cláusulas — verbatim del contrato real, con los `${...}`
// como los únicos puntos que cambian por contrato.
function buildClauses(contract) {
  const tenantsIntro = tenantListText(contract.tenants);
  const solidarios = contract.tenants.length > 1 ? 'LOS ARRENDATARIOS SOLIDARIOS' : 'EL ARRENDATARIO SOLIDARIO';
  const months = monthsBetween(contract.startDate, contract.endDate);
  const termText = `${months} (${String(months).padStart(2, '0')}) mes${months === 1 ? '' : 'es'}, contados a partir del ${fmtDateLong(contract.startDate)}`;
  const primaryTenant = contract.tenants.find((t) => t.email) || contract.tenants[0];

  return [
    { label: 'PRIMERA', title: 'OBJETO DEL CONTRATO', body:
      `El ARRENDADOR da en arrendamiento, y ${solidarios} declara(n) haber recibido a título y en forma solidaria el siguiente inmueble: ${contract.unitLabel}, amoblado por temporada, identificado con el código ${contract.roomCode || contract.unitLabel}, dado en los productos o servicios de la página web http://usoinmobiliario.com y de acuerdo al bosquejo o esquema adjunto de linderos dado en la notificación circular y bienvenida de acuerdo al correo electrónico suscrito por ${solidarios} y que hace(n) parte de este contrato; con la dirección ${LANDLORD.propertyAddress} en el barrio ${LANDLORD.neighborhood} del municipio de Medellín. Ocupación máxima autorizada: ${contract.maxOccupancy} persona(s).` },
    { label: 'SEGUNDA', title: 'TÉRMINO', body:
      `El TÉRMINO de duración del contrato será de ${termText}; si al vencimiento de este plazo ninguna de las partes ha manifestado la prórroga, el contrato podrá darse por terminado antes del vencimiento del plazo por cualquiera de las partes previo aviso de diez (10) días, sin indemnización alguna. Siempre que ${solidarios} haya(n) cumplido las obligaciones a su cargo y se avenga(n) a los reajustes del canon autorizado por las normas legales.` },
    { label: 'TERCERA', title: 'CANON', body:
      `El canon de arrendamiento será la suma de ${fmtCOP(contract.monthlyRent)} M/L, pagadero con periodicidad ${TERM_LABELS[contract.paymentTerm] || contract.paymentTerm}, en las oficinas de la entidad ARRENDADORA en esta ciudad, o a su orden, dentro del primer (1) día de cada periodo de acuerdo a la fecha del contrato. PARÁGRAFO PRIMERO: la mera tolerancia del ARRENDADOR en aceptar el pago del precio del arrendamiento con posterioridad a su vencimiento no se entenderá como ánimo de novación o de modificación del término establecido para el pago en este contrato.` },
    { label: 'CUARTA', title: '', body:
      `Sin previo permiso escrito del ARRENDADOR no podrán ${solidarios} subarrendar, ni ceder el arriendo, ni entregar el inmueble a otra persona diferente a la(s) registrada(s) en este contrato, ni cambiar la destinación del inmueble, que será exclusivamente la de VIVIENDA URBANA.` },
    { label: 'QUINTA', title: '', body:
      `${solidarios} declara(n) haber recibido el inmueble en buen estado de conservación, en perfectas condiciones de uso e higiene de acuerdo al objeto del contrato según aparece en el inventario detallado suscrito entre las partes, el cual puede consultarse también por medio de imágenes y video en http://usoinmobiliario.blogspot.com.co y/o http://usoinmobiliario.com. El mobiliario, dotación de cocina y equipos fijos entregados serán utilizados exclusivamente por ${solidarios} y bajo ninguna circunstancia se podrán destinar a usos diferentes al servicio contratado; el mantenimiento preventivo o correctivo del mobiliario se hará únicamente por personal autorizado por ${LANDLORD.name}. El mobiliario será entregado a título de comodato precario mediante acta de entrega inventario. ${solidarios} no tiene(n) derecho de retención sobre el mobiliario entregado por ${LANDLORD.business} y responderá(n) por todo daño o deterioro que tales bienes sufran, salvo el deterioro natural, por el precio definido por ${LANDLORD.business} para reponerlos, valor que autoriza(n) incluir en la factura correspondiente. ${solidarios} se obliga(n) a devolver el inmueble en el mismo estado, salvo los deterioros naturales por el goce legítimo del bien arrendado.` },
    { label: 'SEXTA', title: 'OBLIGACIONES DEL ARRENDATARIO', body:
      `EL ARRENDATARIO se obliga a: A) pagar el precio del arrendamiento dentro del plazo estipulado. B) cuidar el inmueble y las cosas recibidas en arrendamiento. C) pagar a tiempo los servicios, cosas y usos conexos y adicionales. D) cumplir las normas del código de conducta: https://www.usoinmobiliario.com/blog/codigo-de-conducta-o-convivencia?lang=es. E) reparar los daños y faltantes a plena satisfacción del ARRENDADOR. F) cuidar las zonas y servicios de uso común y efectuar por su cuenta las reparaciones o sustituciones necesarias cuando sean atribuibles a su propia culpa o a la de sus dependientes, y cumplir el reglamento interno: https://www.usoinmobiliario.com/blog/reglamento?lang=es. G) las demás obligaciones consagradas para los arrendatarios en el Capítulo III, Título XXVI, Libro 4 del Código Civil.` },
    { label: 'SÉPTIMA', title: '', body:
      `${solidarios} deja(n) constancia de haber recibido el bien arrendado para los fines propuestos y no podrá(n) sin permiso escrito del ARRENDADOR efectuar mejoras, reformas adicionales o cambios en el mismo, ni exigir reembolso por mejoras o reparaciones no autorizadas expresamente por escrito. ${solidarios} renuncia(n) desde ahora al derecho de retención que establecen las leyes colombianas.` },
    { label: 'OCTAVA', title: '', body:
      `Estarán a cargo del ARRENDADOR los servicios públicos domiciliarios y el servicio adicional de Internet wifi; ${solidarios} tendrá(n) derecho de goce sobre las áreas comunes del inmueble. EL ARRENDADOR no se hace responsable por deficiencias en la prestación de los servicios referidos.` },
    { label: 'NOVENA', title: 'SOLIDARIDAD', body:
      `Los derechos y obligaciones derivadas del presente contrato son solidarios, tanto entre ARRENDATARIOS SOLIDARIOS como entre estos y los DEUDORES SOLIDARIOS.` },
    { label: 'DÉCIMA', title: 'SANCIÓN PENAL', body:
      `El incumplimiento de cualquiera de las cláusulas de este contrato dará derecho al ARRENDADOR para cobrar a ${solidarios} o a sus deudores, a título de pena, el monto de tres cánones de arrendamiento vigentes al momento del incumplimiento; el pago de la pena no exime del pago de la obligación principal y es independiente de indemnizaciones por perjuicios, gastos de abogado, costas judiciales, cobro de arrendamientos pendientes hasta el vencimiento del término o su prórroga, y daños o faltantes en el mobiliario.` },
    { label: 'DÉCIMA PRIMERA', title: '', body:
      `${solidarios} renuncia(n) al derecho a ser requerido(s) judicial o privadamente para ser constituido(s) en mora y dar por terminado el contrato, y renuncia(n) igualmente al derecho de oponerse a la cesación del arriendo conforme al artículo 26 de la Ley 820 de 2003.` },
    { label: 'DÉCIMA SEGUNDA', title: '', body:
      `${solidarios} acepta(n) desde ahora cualquier cesión que EL ARRENDADOR haga del presente contrato, o de las sumas u obligaciones constituidas a su favor y a cargo de aquellos.` },
    { label: 'DÉCIMA TERCERA', title: '', body:
      `${solidarios} se constituye(n) deudor(es) solidario(s) del ARRENDADOR por el monto total de los cánones que se adeuden a la fecha de restitución del inmueble, conforme al artículo 7 de la Ley 820 de 2003, por la pena establecida en este contrato, costas judiciales y honorarios de abogado si hubiere lugar, y por daños o faltantes del mobiliario. El presente contrato presta mérito ejecutivo para el cobro de estos conceptos.` },
    { label: 'DÉCIMA CUARTA', title: '', body:
      `${solidarios} se obliga(n) a reconocer a favor del ARRENDADOR intereses a la tasa máxima permitida por la ley sobre los saldos que se adeuden por razón del presente contrato, desde el día en que se constituyan en mora hasta el día del pago.` },
    { label: 'DÉCIMA QUINTA', title: '', body:
      `Transcurridos doce (12) meses después de la firma del contrato, EL ARRENDADOR podrá incrementar el canon de arrendamiento en la cuantía autorizada por la ley, informando al arrendatario el monto y la fecha de efectividad del incremento por el mecanismo de notificación establecido en este contrato. El pago de un reajuste del canon no dará derecho a reintegro alegando falta de comunicación.` },
    { label: 'DÉCIMA SEXTA', title: '', body:
      `${solidarios} autoriza(n) expresamente al ARRENDADOR para agregar unilateralmente a este documento, con plena validez legal, los cambios de nomenclatura que se puedan presentar, así como los linderos del bien arrendado.` },
    { label: 'DÉCIMA SÉPTIMA', title: '', body:
      `EL ARRENDADOR podrá solicitar la restitución del inmueble al vencimiento del contrato o sus prórrogas, en los casos del numeral octavo (8) del artículo 22 de la Ley 820 de 2003.` },
    { label: 'DÉCIMA OCTAVA', title: 'EXENCIÓN DE RESPONSABILIDAD', body:
      `EL ARRENDADOR no asume responsabilidad alguna por daños o perjuicios que ${solidarios} pueda(n) sufrir por causas atribuibles a terceros u otros arrendatarios, ni por robos, daños o eventualidades de cualquier naturaleza en el inmueble arrendado, lesiones a su persona o pertenencias, ni por fuerza mayor, caso fortuito, incendio, inundación o terrorismo; las medidas de seguridad del bien serán a cargo de ${solidarios}. ${solidarios} es consciente de que la garantía del inmueble se limita a los días previamente especificados en la tarjeta de registro / contrato de arriendo.` },
    { label: 'DÉCIMA NOVENA', title: '', body:
      `En caso de mora por falta de pago del canon o incumplimiento de las obligaciones de EL ARRENDATARIO, EL ARRENDADOR quedará facultado para hacer cesar el arriendo y disponer del inmueble para otro arrendatario, y podrá exigir, aún por vía judicial, la restitución del inmueble conforme al artículo 14 de la Ley 820 de 2003.` },
    { label: 'VIGÉSIMA', title: 'EXIGIBILIDAD Y MÉRITO EJECUTIVO', body:
      `Las obligaciones de pagar sumas de dinero a cargo de cualquiera de las partes serán exigibles ejecutivamente con base en el presente contrato, conforme a los Códigos Civil y de Procedimiento Civil. Respecto de deudas por daños, faltantes o expensas comunes, EL ARRENDADOR podrá repetir lo pagado contra EL ARRENDATARIO por vía ejecutiva mediante la presentación de las facturas o recibos correspondientes.` },
    { label: 'VIGÉSIMA PRIMERA', title: 'CAUSALES DE TERMINACIÓN', body:
      `1) La no cancelación de las rentas y reajustes dentro del término estipulado. 2) La no cancelación de los servicios públicos que cause su desconexión, o de las expensas comunes cuando su pago esté a cargo del arrendatario. 3) El subarriendo total o parcial, la cesión del contrato o del goce del inmueble, o el cambio de destinación, sin autorización expresa del ARRENDADOR. 4) Proceder que afecte la tranquilidad de los vecinos, el Código Nacional de Policía, o la destinación del inmueble para actos delictivos. 5) Mejoras, cambios o ampliaciones sin autorización, o destrucción total o parcial del inmueble o su mobiliario. 6) La violación al código de conducta o convivencia en apartamento compartido.` },
    { label: 'VIGÉSIMA SEGUNDA', title: '', body:
      `${solidarios} se compromete(n) a la entrega del inmueble de acuerdo al check-out, para el chequeo del mobiliario y el estado de cuentas a paz y salvo, al ARRENDADOR o a quien este designe. Con la firma del presente contrato, manifiesta(n) su voluntad de recibir el comprobante de pago del contrato de arrendamiento a través de la dirección electrónica registrada en este contrato.` },
    { label: 'VIGÉSIMA TERCERA', title: '', body:
      `${solidarios} autoriza(n) al establecimiento de comercio ${LANDLORD.business} para reportar, consultar, registrar y circular información a las entidades de consulta de bases de datos (Data Crédito, Covinoc, Procrédito, etc.) sobre los saldos a su cargo, operaciones de crédito, estado de sus obligaciones y manejo de sus créditos.` },
    { label: 'VIGÉSIMA CUARTA', title: 'NOTIFICACIONES', body:
      `El domicilio para efectos de notificación personal de las partes es: el arrendador ${LANDLORD.business}, ${LANDLORD.noticeAddress}, teléfono ${LANDLORD.phone}, correo ${LANDLORD.email} / ${LANDLORD.billingEmail}; ${solidarios.toLowerCase() === 'el arrendatario solidario' ? 'el arrendatario solidario' : 'los arrendatarios solidarios'} correo ${primaryTenant?.email || '—'}, teléfono ${(contract.tenants.map((t) => t.phone).filter(Boolean).join(' y ')) || '—'}. En caso de cambio de dirección, ${solidarios.toLowerCase()} informará(n) por escrito a ${LANDLORD.business}; de no hacerlo, se entenderá surtida cualquier notificación en el inmueble objeto del contrato. Para constancia y señal de aceptación se firma este contrato en Medellín, ${fmtDateLong(contract.startDate)}.` },
  ];
}

function generateContractDocumentPdf(contract) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.rect(0, 0, doc.page.width, 86).fill(BRAND.forest);
    doc.fillColor('#f8f4ea').font('Helvetica-Bold').fontSize(10).text('USOINMOBILIARIO', 56, 26, { characterSpacing: 1.5 });
    doc.fontSize(16).text('Contrato de arrendamiento de vivienda urbana', 56, 42);
    doc.font('Helvetica').fontSize(9).text(`Contrato N.° ${contract.code} · ${contract.unitLabel}${contract.roomCode ? ' · ' + contract.roomCode : ''}`, 56, 66);

    doc.moveDown(2.5);
    doc.font('Helvetica').fontSize(9.5).fillColor(BRAND.ink).text(
      `ENTRE LOS SUSCRITOS A SABER: ${LANDLORD.name}, mayor de edad, vecino de Medellín, identificado con cédula de ciudadanía No. ${LANDLORD.cedula}, obrando en su calidad de propietario del establecimiento comercial con domicilio en Medellín denominado ${LANDLORD.business}, que posee matrícula de arrendador de vivienda urbana No. ${LANDLORD.matricula} concedida por la Secretaría de Gobierno y Derechos Humanos de la ciudad de Medellín, quien en adelante y para efectos del presente contrato se denominará EL ARRENDADOR, por una parte, y por otra parte ${tenantListText(contract.tenants)}, obrando en su(s) propio(s) nombre(s), quien(es) proceden y se obligan solidariamente y se denominarán ${contract.tenants.length > 1 ? 'LOS ARRENDATARIOS SOLIDARIOS' : 'EL ARRENDATARIO SOLIDARIO'}` +
      (contract.jointDebtor && contract.jointDebtor.name ? `, junto con ${contract.jointDebtor.name.toUpperCase()}, identificado con cédula de ciudadanía número ${contract.jointDebtor.documentId}, quien actúa como DEUDOR SOLIDARIO,` : ',') +
      ' se ha celebrado el presente contrato de arrendamiento contenido en las siguientes cláusulas:',
      { align: 'justify' }
    );

    for (const clause of buildClauses(contract)) {
      doc.moveDown(0.9);
      const heading = clause.title ? `${clause.label}: ${clause.title}. ` : `${clause.label}: `;
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BRAND.clay).text(heading, { continued: true });
      doc.font('Helvetica').fillColor(BRAND.ink).text(clause.body, { align: 'justify' });
    }

    doc.moveDown(2);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BRAND.ink).text('Firmas', { underline: false });
    doc.moveDown(1.5);
    doc.font('Helvetica').fontSize(9).text('Firma: ______________________________  Huella');
    doc.text(`Nombre: ${LANDLORD.name}`);
    doc.text(`C.C. ${LANDLORD.cedula}`);
    doc.text('ARRENDADOR');
    for (const tenant of contract.tenants) {
      doc.moveDown(1.2);
      doc.text('Firma: ______________________________  Huella');
      doc.text(`Nombre: ${tenant.name}`);
      doc.text(`Documento: ${tenant.documentId}`);
      doc.text('ARRENDATARIO SOLIDARIO');
    }
    if (contract.jointDebtor && contract.jointDebtor.name) {
      doc.moveDown(1.2);
      doc.text('Firma: ______________________________  Huella');
      doc.text(`Nombre: ${contract.jointDebtor.name}`);
      doc.text(`Documento: ${contract.jointDebtor.documentId}`);
      doc.text('DEUDOR SOLIDARIO');
    }

    doc.moveDown(1.5);
    doc.fontSize(8).fillColor(BRAND.muted).text('Documento generado automáticamente por el panel administrativo de Uso Inmobiliario, a partir de la plantilla real del contrato de arrendamiento del negocio.', { align: 'center' });

    doc.end();
  });
}

module.exports = { generateContractDocumentPdf };
