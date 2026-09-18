# RBAC — Uso Inmobiliario

Cómo funciona el control de acceso del panel administrativo (`usoinmobiliario-middleware`) desde
que existen tres roles reales (antes solo había admin/super-admin). Para el resto del modelo de
seguridad (autenticación, Rules de Firebase, gestión de secretos), ver `SECURITY.md`.

## Los tres roles

| Rol | Cómo se identifica | Puede |
|---|---|---|
| **OWNER** (dueño) | Su email coincide con `config.superAdminEmail` — comparación de string, no un dato asignable (decisión ya tomada, ver `SECURITY.md`) | Todo. Único rol que puede crear/editar/deshabilitar cuentas (`/users*`), editar apartamentos (`/apartments` POST/PUT), editar datos bancarios, ver la Bitácora |
| **DEVELOPER** (desarrollador) | Su email coincide con `config.developerEmail` (env `DEVELOPER_EMAIL`, por defecto `superethicalgames@gmail.com`; vacío lo desactiva) — mismo mecanismo que OWNER, jamás un dato en `roles/` | Exactamente lo mismo que OWNER: `requireRole` lo deja pasar en toda ruta que permita `owner`. No recibe notificaciones operativas (`notifyAllStaff` solo avisa a owner/admin). Sus acciones quedan en la Bitácora con su correo, y el dueño lo ve en Usuarios y puede revocarlo |
| **ADMIN** | Cuenta de Firebase Auth con `roles/{uid}.role` explícito `'admin'` (sin documento ⇒ 403, ver SEC-002) | Reservas, visitas, pagos, contratos, aseo, mantenimiento, analíticas, catálogo de apartamentos (solo lectura) |
| **EMPLOYEE** (empleado) | Cuenta de Firebase Auth con `roles/{uid}.role === 'employee'` | Solo sus propias tareas de aseo/mantenimiento asignadas, y sus notificaciones |

No existe un rol "super-admin" separado en el código — `isSuperAdmin` (en `/me` y en el
`AuthContext` del panel) es `role === 'owner' || role === 'developer'`, mantenido por compatibilidad con el
panel ya desplegado antes de que existiera esta matriz completa.

## Dónde vive la aplicación real de esto

**Server-side, siempre** (`whatsapp-assistant/src/adminAuth.js` + `adminRoutes.js`) — nunca solo
en React:

```
requireAdminAuth   → verifica el ID token de Firebase Auth (ya existía)
attachRole         → resuelve req.adminUser.role (owner por email, si no roles/{uid}, si no 'admin')
requireRole(...)   → 403 si el rol no está en la lista permitida
```

Montado en `app.js`: `app.use('/admin/api', allowAdminOrigin, adminLimiter, requireAdminAuth, attachRole, adminRoutes)`
— `attachRole` corre en TODAS las rutas antes de llegar a `adminRoutes.js`, así que cualquier
ruta nueva que se agregue ya tiene `req.adminUser.role` disponible sin tener que repetir lógica.

Dos grupos reusables en `adminRoutes.js`:

```js
const STAFF = requireRole('owner', 'admin');            // todo lo operativo, sin empleados
const ANY_STAFF = requireRole('owner', 'admin', 'employee'); // + aseo/mantenimiento/notificaciones
```

**Frontend** (`usoinmobiliario-middleware`): `Layout.tsx` muestra un menú distinto por rol y
`App.tsx` (`StaffOnlyRoute`) redirige a un empleado que intente navegar directo (por URL) a una
pantalla que no le corresponde. Esto es solo UX — quitar estos guards del frontend no abre
ningún acceso real, porque el backend nunca confía en lo que el cliente diga que es.

## Matriz de rutas (`/admin/api/*`)

| Ruta | Owner | Admin | Employee |
|---|---|---|---|
| `GET /me` | ✅ | ✅ | ✅ (única ruta abierta a los tres, es "quién soy") |
| `GET/POST /apartments`, `PUT /apartments/:t/:n` | ✅ | GET solo | ❌ |
| `GET /categories` | ✅ | ✅ | ✅ (dato público, sin riesgo) |
| `GET/POST /reservations`, `/visits`, `/records/*`, `/payments/*`, `/contracts*`, `/site-traffic` | ✅ | ✅ | ❌ |
| `GET/POST /cleaning`, `/maintenance` | ✅ | ✅ | GET/status solo, **acotado a lo que le asignaron** |
| `GET /employees` (picker para asignar tareas) | ✅ | ✅ | ❌ |
| `GET/POST/PUT /users*` (crear/editar/deshabilitar cuentas, cambiar rol) | ✅ | ❌ | ❌ |
| `PUT /payment-info` | ✅ | ❌ | ❌ |
| `GET /audit-log` | ✅ | ❌ | ❌ |
| `GET/POST /notifications*` | ✅ | ✅ | ✅ (solo las suyas — el uid sale del token, nunca de la URL) |

## Least Privilege para empleados — cómo se acota, no solo se oculta

- `GET /cleaning` y `GET /maintenance`: si `role === 'employee'`, el backend filtra el array
  ANTES de responder (`scopeToEmployee`) — nunca se manda la lista completa para que el
  frontend decida qué mostrar.
- `POST /cleaning/:code/status` y `/maintenance/:code/status`: `assertOwnedByEmployeeOrStaff`
  compara `record.assignedTo === req.adminUser.uid`; si no coincide, responde `404` (no `403`) —
  un empleado ni siquiera puede confirmar que el código de otra tarea existe.
- `assignedTo` guarda el **uid real** de la cuenta (no texto libre) desde que existe el picker
  de empleados en `Cleaning.tsx`/`Maintenance.tsx` — tareas creadas antes de este cambio, con
  texto libre en ese campo, simplemente no calzan con ningún uid y quedan invisibles para
  empleados (correcto: nunca fueron asignadas a una cuenta real).

## Crear/gestionar cuentas

Solo el dueño, desde **Usuarios** (`usuarios.tsx`, reemplaza a la antigua pantalla
"Administradores"):
- Crear cuenta → `POST /users` (`{email, password, role}`) → crea el usuario de Firebase Auth
  (igual que siempre) + escribe `roles/{uid}` si el rol es `employee` (para `admin` no hace
  falta escribir nada, ausencia de documento ya significa admin).
- Cambiar rol → `PUT /users/:uid/role` (admin↔employee, nunca `owner` — el enum
  `CREATABLE_ROLES` ni siquiera acepta ese valor).
- Deshabilitar/reactivar → `POST /users/:uid/disable|enable` (reusa `admin.auth().updateUser`,
  igual que ya existía para admins) — un dueño no puede desactivarse a sí mismo.

Ninguna de estas rutas puede ser alcanzada por un admin o empleado (`requireSuperAdmin`), así que
la restricción "solo el dueño puede crear administradores/empleados" (sección 2-3 del pedido) es
estructural, no una casilla de UI.

## Qué NO se implementó (alcance deliberado)

- Permisos "por recurso" configurables por el dueño (ej. "este admin sí puede ver Contratos pero
  no Pagos") — el pedido pide una jerarquía de 3 niveles con un conjunto fijo de capacidades por
  rol, no un editor de permisos granular. Los dos grupos (`STAFF`/`ANY_STAFF`) cubren la matriz
  tal como está especificada; si en el futuro hace falta granularidad por admin individual, el
  punto de extensión ya existe (`roles/{uid}` puede crecer con más campos sin romper nada).
- Revocación instantánea de sesión al deshabilitar una cuenta — mismo criterio ya documentado en
  `SECURITY.md` para `requireSuperAdmin` (`checkRevoked` deliberadamente omitido): deshabilitar
  impide un login NUEVO, pero un token ya emitido sigue siendo válido hasta que expira solo
  (≤1 hora). No se cambió este comportamiento para no introducir una llamada de red extra por
  request en todo el panel solo para este caso de borde de bajo riesgo.
