const path = require('path');

// Logo real del negocio (mismo PNG que el favicon/ícono del panel y el que aparece en la
// factura real de Carlos) — vive en whatsapp-assistant/assets/ porque el backend es su propio
// deploy en Render, no puede leer archivos del repo del panel en tiempo de ejecución.
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo.png');

// Marca de agua diagonal de baja opacidad en TODAS las páginas — mismo espíritu anti-fraude que
// ya trae la factura real (el logo circular con el ® junto a la firma), aplicado a todo el
// documento. Requiere `bufferPages: true` en el PDFDocument del caller (así se puede volver a
// cada página ya generada, incluidas las que pdfkit creó solo por desbordar el contenido).
function addWatermarkToAllPages(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.save();
    doc.opacity(0.06);
    const size = Math.min(doc.page.width, doc.page.height) * 0.6;
    const cx = doc.page.width / 2;
    const cy = doc.page.height / 2;
    doc.rotate(-28, { origin: [cx, cy] });
    doc.image(LOGO_PATH, cx - size / 2, cy - size / 2, { width: size, height: size });
    doc.restore();
  }
}

// Logo pequeño para el encabezado — junto al nombre del negocio, como en la factura real.
function drawHeaderLogo(doc, x, y, size) {
  doc.image(LOGO_PATH, x, y, { width: size, height: size });
}

module.exports = { LOGO_PATH, addWatermarkToAllPages, drawHeaderLogo };
