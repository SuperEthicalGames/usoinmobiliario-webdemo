# Modelo de seguridad — Uso Inmobiliario

Este documento describe cómo el ecosistema completo (sitio público, backend, panel
administrativo) protege datos y operaciones hoy. Para hallazgos, evidencia y correcciones
puntuales, ver `SECURITY_AUDIT.md`. Para cómo encajan las piezas, ver `ARCHITECTURE.md`.

## Actores

| Actor | Cómo se identifica | Qué puede hacer |
|---|---|---|
| Visitante anónimo (sitio web) | Nada — sin login | Ver catálogo/tarifas/contenido legal público, crear su propia reserva/cita (HOLD), reportar el pago de SU PROPIA reserva, consultar una reserva por código exacto |
| Cliente por WhatsApp/chat web | Su número de WhatsApp o un `sessionId` opaco de navegador | Lo mismo que el visitante anónimo, a través de lenguaje natural (IA) — nunca más que eso, ver "Superficie de la IA" abajo |
| Administrador | Cuenta de Firebase Auth (Email/Password) creada a mano por el super admin | Ver/gestionar reservas, visitas, pagos, apartamentos, contratos, aseo, mantenimiento, analítica del sitio |
| Super administrador | La MISMA autenticación de administrador, pero su email coincide con `SUPER_ADMIN_EMAIL` | Todo lo anterior + crear/deshabilitar otros administradores + editar los datos bancarios reales del negocio |
| Sistema (Admin SDK) | Cuenta de servicio de Firebase (`whatsapp-assistant`) | Acceso total a la Realtime Database — las Rules no aplican a este actor; toda garantía que las Rules dan al cliente web se reimplementa a mano en `firebase.js` para este camino |

No existe "cliente autenticado": el sitio público nunca pide login. `authenticated == authorized`
no es una suposición válida aquí — cada operación administrativa exige además que el email del
token coincida con el rol correcto (`requireSuperAdmin`), nunca solo `auth != null`.

## Autenticación

- **Panel administrativo:** Firebase Authentication, Email/Password. Sin UI de registro en
  ningún lado — la única forma de que exista una cuenta es que el super admin la cree desde
  `Admins.tsx` (o el dueño, a mano en la consola de Firebase, para la primera cuenta). El panel
  pide un ID token fresco en cada llamada (`user.getIdToken()`, nunca cacheado) y lo manda como
  `Authorization: Bearer <token>`.
- **Backend (`/admin/api/*`):** verifica ese token con `admin.auth().verifyIdToken()` en cada
  request (`adminAuth.js`) — la verificación del token ES el control de acceso real, no una capa
  extra sobre las Realtime Database Rules (el backend usa el Admin SDK, que se las salta por
  completo).
- **Sitio público y WhatsApp/chat:** sin autenticación, por diseño — el negocio no pide cuenta
  para reservar. La integridad de esas operaciones depende de las Rules (sitio) o de la
  reimplementación en `firebase.js` (bot), no de quién es el remitente.

## Autorización

- `requireAdminAuth`: cualquier cuenta de administrador válida y no deshabilitada.
- `requireSuperAdmin`: además, el email del token debe ser exactamente `config.superAdminEmail`
  — comparación de string, no un custom claim (decisión consciente: una sola cuenta principal
  conocida de antemano no justifica el paso extra de bootstrap de custom claims). Un admin nuevo
  creado por el super admin **nunca** puede convertirse en super admin él mismo — depende
  únicamente de qué email tiene, algo que quien lo crea no controla.
- Reglas de Firebase (`firebase/database.rules.json`): ver la tabla completa en
  `SECURITY_AUDIT.md` §"matriz de reglas" (implícita en el archivo mismo, comentado línea por
  línea). Resumen: catálogo/contenido de solo lectura pública; reservas/citas de creación pública
  pero modificación solo por admin (`auth != null || !data.exists()`); pagos con una única
  transición pública permitida (`'none' → 'submitted'`); todo lo demás, `auth != null`.

## Gestión de secretos

- **Nunca en el repositorio:** `.env` (whatsapp-assistant) está en `.gitignore` y jamás fue
  trackeado — confirmado con `git log --all -S` sobre los patrones reales de cada tipo de
  credencial (ver `SECURITY_AUDIT.md` §3).
- **`.env.usoinmobiliario-c8e83`** SÍ está en git, a propósito — es la convención de Firebase
  Functions para variables no sensibles (`FIREBASE_DATABASE_URL`, nombre de modelo de IA, URL
  del sitio) — releído en cada auditoría para confirmar que sigue sin contener secretos reales.
- **`firebase/firebase-config.js`** (apiKey web de Firebase) está en git a propósito — no es
  secreto por diseño de Firebase (la protección real son las Rules, no ocultar esta clave).
  `usoinmobiliario-middleware/src/config.ts` sigue el mismo criterio para el panel.
- **Secretos reales** (tokens de WhatsApp, claves de Gemini/OpenAI, contraseña de aplicación de
  Gmail, credencial de servicio de Firebase) viven solo en `.env` local (nunca commiteado) y en
  variables de entorno marcadas `sync: false` en `render.yaml` (se llenan a mano en el dashboard
  de Render, nunca en el repo).
- **Si una credencial llega a exponerse alguna vez:** rotarla en su proveedor (Meta for
  Developers, Google AI Studio/OpenAI Platform, consola de Firebase) y actualizar el valor en
  Render — nunca reemplazarla directamente en el código.

## Reporte de vulnerabilidades

Este es un proyecto de portafolio de un solo desarrollador/dueño — no hay un programa formal de
bug bounty. Si se encuentra un problema de seguridad, reportarlo directamente al dueño del
proyecto (contacto del negocio: `usoinmobiliario@gmail.com`) en vez de abrirlo como issue
público, hasta que se confirme y corrija.

## Qué NO cubre este modelo (limitaciones explícitas)

- No hay Firebase App Check — un cliente que reconstruya el `firebaseConfig` real (no es
  secreto) puede llamar a la Realtime Database directamente sin pasar por el sitio ni por
  ninguna app "genuina". Las Rules son la única barrera real para ese camino, y están escritas
  asumiendo exactamente eso (ver Regla B en `SECURITY_AUDIT.md`).
- No hay verificación de identidad del cliente final (nombre/teléfono/correo de una reserva son
  auto-declarados, nunca verificados contra un documento real) — es una decisión de negocio ya
  tomada (el modelo de reserva no la requiere), no un descuido.
- La integridad del precio de una reserva creada desde el sitio web depende de una alerta al
  administrador, no de un bloqueo automático — ver P1-03 en `SECURITY_AUDIT.md` para el porqué y
  la limitación reconocida.
