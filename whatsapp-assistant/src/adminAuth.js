const admin = require('firebase-admin');
const firebase = require('./firebase');
const config = require('../config');

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

// Tercera puerta (RBAC) — SIEMPRE montada después de requireAdminAuth, resuelve el rol UNA vez
// por request y lo deja en req.adminUser.role para que el resto de la cadena (requireRole) solo
// lea, nunca vuelva a decidir. OWNER sigue siendo exactamente la misma comparación de string ya
// documentada en SECURITY.md (decisión consciente, no reabierta acá) — nunca un dato que se
// pueda crear ni asignar desde ninguna ruta. Cualquier otra cuenta autenticada es 'admin' por
// defecto (compatibilidad hacia atrás: los admins creados antes de que existiera `roles/` no
// tienen ningún documento ahí y deben seguir funcionando exactamente igual que hoy) salvo que
// `roles/{uid}` diga explícitamente 'employee'.
async function attachRole(req, res, next) {
  if (req.adminUser.email === config.superAdminEmail) {
    req.adminUser.role = 'owner';
    return next();
  }
  try {
    firebase.init();
    const role = await firebase.getUserRole(req.adminUser.uid);
    req.adminUser.role = role === 'employee' ? 'employee' : 'admin';
    next();
  } catch (err) {
    console.error('[adminAuth] Error resolviendo rol:', err.message);
    res.status(500).json({ error: 'internal-error' });
  }
}

// Gate genérico: requireRole('owner','admin') dentro de una ruta ya montada detrás de
// requireAdminAuth+attachRole. Nunca se llama antes de attachRole (req.adminUser.role no
// existiría todavía) — ver el orden de montaje en app.js.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.adminUser || !allowedRoles.includes(req.adminUser.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

// Alias — mismo nombre exportado de siempre (usado por /payment-info, /audit-log desde antes de
// que existiera RBAC), ahora expresado en términos de rol en vez de repetir la comparación de
// email por su cuenta. Ningún caller existente necesita cambiar.
const requireSuperAdmin = requireRole('owner');

module.exports = { requireAdminAuth, attachRole, requireRole, requireSuperAdmin };
