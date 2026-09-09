const admin = require('firebase-admin');
const firebase = require('./firebase');

// Único guardián de /admin/api/* — verifica un ID token real de Firebase Auth (el panel de
// usoinmobiliario-middleware inicia sesión con el mismo Email/Password del único admin, ya
// decidido para el panel que reemplaza a Unity: sin UI de registro en ningún lado, la única
// forma de que exista una cuenta válida es que el dueño la cree a mano en la consola de
// Firebase — misma garantía estructural, ahora protegiendo un panel web en vez de Unity).
//
// Importante: las reglas de firebase/database.rules.json (`auth != null`) NO aplican acá — el
// resto de este backend usa el Admin SDK (cuenta de servicio), que se salta las rules por
// completo. La verificación del token ES el único control de acceso real para estas rutas, no
// una capa adicional sobre las rules.
//
// checkRevoked deliberadamente OMITIDO: costaría una llamada de red extra por request, y para
// una sola cuenta de bajo riesgo no vale la pena — una sesión comprometida expira sola en ≤1h
// (vida del ID token), sin necesitar revocación instantánea.
async function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return res.status(401).json({ error: 'missing-token' });

  try {
    firebase.init(); // asegura que admin.initializeApp() ya corrió antes de usar admin.auth()
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.adminUser = { uid: decoded.uid, email: decoded.email };
    next();
  } catch (err) {
    console.error('[adminAuth] Token inválido o vencido:', err.message);
    res.status(401).json({ error: 'invalid-token' });
  }
}

module.exports = { requireAdminAuth };
