# Arquitectura — Uso Inmobiliario

Tres piezas desplegadas por separado, dos repositorios, una sola fuente de verdad de datos.

```
Visitante (navegador)              Cliente (WhatsApp)              Administrador (navegador)
        │                                   │                              │
        ▼                                   ▼                              ▼
index.html                     whatsapp-assistant (Render)      usoinmobiliario-middleware
(GitHub Pages, repo             Express + Gemini/OpenAI          (React/Vite, GitHub Pages,
 usoinmobiliario-webdemo)        function calling                 repo usoinmobiliario-middleware)
  DataProvider: Firebase              │                                    │
  (o Local si Firebase              función de negocio          fetch con Bearer <ID token
   no está disponible)             (businessTools.js)             de Firebase Auth>
        │  │                                │                              │
   lee: │  │ escribe: POST /reservations,    │ Firebase Admin SDK           │
   JS   │  │ /visits, .../payment-method,    │ (cuenta de servicio,         │
   SDK, │  │ .../payment-report — mismo      │ escribe siempre, sin         │
   pasa │  │ reservationBuilder.js que usa   │ pasar por Rules)             │
   por  │  │ el bot (whatsapp-assistant)     │                              │
   Rules▼  ▼                                 ▼                              ▼
                     Firebase Realtime Database (usoinmobiliario-c8e83)
        categories/ apartments/ statusMeta/ settings/ contracts/
        cleaningTasks/ maintenanceTickets/ siteTraffic/
        reservationsManager/{reservations,visits}/ unitBookings/
        bookedNights/ bookedVisitSlots/
                                                        ▲
                                                        │ /admin/api/* (HTTP, no acceso directo)
                                            whatsapp-assistant vuelve a exponer
                                            lecturas/escrituras administrativas
                                            protegidas por requireAdminAuth

email-worker/ (Cloudflare Worker) — construido, NO conectado (EMAIL_WORKER_CONFIG vacío en
  index.html); el correo transaccional real hoy sale de whatsapp-assistant/src/emailService.js
  (SMTP de Gmail), no de este Worker.
```

**Migración de escrituras al backend (2026-09-13):** hasta esta fecha, el sitio público escribía
reservas/citas/pagos DIRECTO a Firebase desde el navegador (JS SDK, sin autenticar), con
`firebase/database.rules.json` como única barrera real (ver hallazgos de
`AUDITORIA_EXTERNA_2026_09.md` §5 y `SECURITY_AUDIT.md`). Ahora el backend es el único que
escribe, para los tres canales (sitio, WhatsApp/chat, panel admin) — `FirebaseDataProvider.js`
sigue leyendo directo (catálogo, calendario de disponibilidad, "Mi reserva" por código); sus tres
funciones de escritura (`createReservation`, `setPaymentMethod`, `reportPayment`) ahora son
`fetch()` a rutas nuevas de `whatsapp-assistant` (`POST /reservations`, `/visits`,
`/reservations/:code/payment-method`, `/reservations/:code/payment-report`), sin autenticar
(igual que antes — el código de 6 caracteres sigue siendo la credencial, ver `SECURITY.md`) pero
ahora validadas/reclamadas server-side, con `Idempotency-Key` real (antes solo cubría rutas
admin). `whatsapp-assistant/src/reservationBuilder.js` es el core compartido (validar → resolver
apartamento → tope de huéspedes → disponibilidad → precio → armar registro) que usan por igual
`businessTools.js` (bot), estas rutas nuevas y `adminRoutes.js`'s `POST /admin/api/reservations`
— una sola implementación, no tres copias. El backend recalcula precio/código/expiración siempre
server-side, nunca confía en lo que mande el cliente. `firebase.js:sweepExpiredHolds()` (barrido
cada 5 min) reemplaza el reclamo oportunista que antes hacía el propio navegador al consultar
disponibilidad — necesario porque, una vez que `database.rules.json` cierre la escritura anónima
(paso manual, ver `DEPLOYMENT.md`), esa escritura del navegador ya no sería posible.

## Componentes

### 1. Sitio público (`usoinmobiliario-webdemo/index.html`)

Un solo archivo HTML (~4000 líneas), sin build step, con todo el CSS/JS embebido — decisión de
diseño explícita del proyecto, no una limitación a corregir. Módulos internos (funciones/objetos
dentro de un único IIFE, no archivos separados):

- **`ApartmentService`/render\*** — catálogo, ficha de unidad, recorrido 360° (three.js).
- **`PricingService`** — calcula el precio de una estadía (client-side; ver `SECURITY_AUDIT.md`
  P1-03 para la limitación de esto).
- **`AvailabilityService`** — disponibilidad real contra `bookedNights`/`bookedVisitSlots`.
- **`BOOKING`** — modal de reserva/cita de 4 pasos, "Mi reserva", reporte de pago.
- **`PaymentProvider`** — abstracción delgada sobre transferencia/efectivo.
- **`CHATWIDGET`** — chat en vivo que habla con el MISMO cerebro de IA que WhatsApp
  (`POST /chat/web/message`), un canal más, no una IA distinta.
- **`PANO`** — visor 360°; el hero además arma un panorama real de Street View pegando tiles de
  `streetviewpixels-pa.googleapis.com` directamente en un canvas (sin API key, sin iframe).

Persistencia: `FirebaseDataProvider.js` si Firebase responde, `LocalDataProvider` (localStorage)
como respaldo — misma interfaz para ambos, la UI no sabe cuál está activo.

### 2. Backend (`usoinmobiliario-webdemo/whatsapp-assistant/`)

Express + Node 20, desplegado en Render (`usoinmobiliario-whatsapp-bot`, plan gratuito).

```
src/app.js            — rutas Express, CORS por prefijo, rate limits
src/whatsapp.js        — único lugar que habla con WhatsApp Cloud API (firma, envío, parseo)
src/assistantCore.js   — system prompt + declaración de herramientas (agnóstico de proveedor)
src/geminiProvider.js  — loop de function calling contra Gemini (REST directo)
src/openaiProvider.js  — mismo loop contra OpenAI (mismo contrato, mismo límite de 6 turnos)
src/businessTools.js   — las 10 únicas funciones que la IA puede invocar (sin ninguna administrativa)
src/firebase.js        — único lugar que toca el Admin SDK; reimplementa a mano las garantías
                          que las Rules le dan gratis al sitio web (atomicidad, anti-doble-reserva)
src/adminAuth.js       — verificación de ID token + gate de super admin
src/adminRoutes.js     — todo lo que consume el panel (usoinmobiliario-middleware)
src/emailService.js    — correo transaccional real (SMTP de Gmail)
src/conversationStore.js — memoria de conversación en proceso, con TTL
src/validators.js      — anti-datos-inventados (placeholders) + formato
src/pricing.js         — misma fórmula de precio que index.html, más priceIntegrityCheck()
```

Tres puntos de entrada distintos reusan la misma `app.js`: `server.js` (local, `app.listen`),
`index.js` en la raíz (`exports.api = onRequest(app)` para Cloud Functions — preparado, no
desplegado, requiere plan Blaze de Firebase).

### 3. Panel administrativo (`usoinmobiliario-middleware`)

React 19 + Vite + TypeScript + Tailwind, GitHub Pages, `HashRouter` (evita 404 en refresh/deep-link
en hosting estático). Nunca toca Firebase Realtime Database directamente — todo pasa por
`/admin/api/*` del backend de Render. Firebase Auth solo se usa para login (`firebase.ts`).

```
src/AuthContext.tsx   — sesión de Firebase Auth, isSuperAdmin decidido por el backend (/me)
src/api.ts            — cliente HTTP hacia /admin/api/*, token fresco en cada llamada
src/pages/*.tsx        — Dashboard, Reservations, Visits, Payments, Apartments, Contracts,
                          Cleaning, Maintenance, Analytics, Admins, Settings, ManualReservation
src/components/RecordDetail.tsx — panel deslizante con el detalle de una reserva/cita
```

## Flujos principales

**Reserva desde el sitio web:** catálogo → `AvailabilityService` en vivo (lectura directa a
Firebase) → `PricingService` (client-side, solo para mostrarle un estimado al cliente ANTES de
enviar — el precio real y definitivo lo recalcula el backend) → datos de contacto →
`ReservationService.createRecord()` → `FirebaseDataProvider.createReservation()` hace un
`POST /reservations` (o `/visits`) al backend → `reservationBuilder.js` valida, resuelve el
apartamento, revisa el tope de huéspedes, chequea disponibilidad, recalcula el precio y arma el
registro final (código, `estTotal`, `expiresAt` — todo server-side, nunca lo que mandó el
navegador) → `firebase.js.createReservation()` reclama las noches con transacciones reales →
HOLD de 15 min → elegir método de pago (`POST .../payment-method`) → transferencia (reporte con
comprobante, `POST .../payment-report`) o efectivo (solo aviso) → esperar verificación humana
desde el panel.

**Reserva por WhatsApp/chat:** mensaje en lenguaje natural → `assistantCore` decide qué función
llamar (nunca inventa datos — `validators.js` bloquea placeholders) → `businessTools.js` llama al
MISMO `reservationBuilder.js` que usa la ruta pública de arriba → `firebase.js` (Admin SDK, con
transacciones atómicas propias) → mismo HOLD de 15 min, mismo formato de código, misma fórmula de
precio que el sitio web — desde 2026-09-13, literalmente la misma función, no solo "la misma
fórmula portada dos veces".

**Verificación de pago (solo admin):** `Payments.tsx` lista transferencias reportadas/efectivo
pendiente → admin ve `priceCheck` si el total reportado no coincide con la tarifa real
(`pricing.priceIntegrityCheck`, ver `SECURITY_AUDIT.md` P1-03) → `verify`/`reject`/`register-cash`
→ el estado de la RESERVA sigue aparte (`confirm`/`reject`/`cancel`/`complete` en `Reservations.tsx`).

**Anti-doble-reserva:** cada noche/turno se reclama con una transacción real
(`db.ref().transaction()`, `firebase.js:claimNightAtomically`/`claimSlotAtomically`) — desde
2026-09-13 esto corre SIEMPRE en el backend (Admin SDK), para los tres canales; ya no hay un
camino donde el navegador reclama directo contra las Rules. Si dos solicitudes compiten por la
misma fecha, solo una gana; la otra recibe `conflict` y no deja el sistema en un estado a medias
(libera lo que sí alcanzó a reclamar, ver `releaseNights`).

**HOLD abandonado (nunca pagado):** `firebase.js:sweepExpiredHolds()` corre cada 5 minutos y
libera cualquier HOLD vencido en `bookedNights`/`bookedVisitSlots`, para toda la base — antes
(hasta el 2026-09-13) esto era un efecto secundario de que ALGÚN visitante consultara
disponibilidad para esa unidad exacta (`reclaimExpiredHold`, disparado desde el navegador); ese
mecanismo dejó de ser viable en cuanto el navegador dejó de tener permiso de escritura para
reclamar, así que el barrido del backend es ahora la única fuente de reclamo, no solo una mejora.

**Bug real corregido (2026-09-13) — pago/reserva "exitoso" que nunca llegaba al panel:** el
hallazgo original (una sesión que se quedaba en `LocalDataProvider` sin que la reserva/pago
llegara nunca a Firebase) llevó primero a un chequeo previo a cada escritura
(`window.__uso_assertConnected()`), y más tarde — misma sesión de trabajo, ver "Migración de
escrituras al backend" arriba — a mover la escritura misma al backend, cerrando la causa de raíz
en vez de solo detectarla. `assertConnected()` ahora también confirma que el backend (Render)
responde antes de dejar escribir (`GET /health`) — un cold-start o una caída de Render es una
falla nueva que el viejo camino directo-a-Firebase no tenía, así que necesitaba su propia
señal. Un fallo real sigue quedando trazado en `clientErrors/` vía `POST /track/client-error`.

## Infraestructura — qué está activo hoy

| Pieza | Estado | Notas |
|---|---|---|
| GitHub Pages (sitio) | ✅ Activo | `usoinmobiliario-webdemo` → `.github/workflows/pages.yml` en cada push a `main` |
| GitHub Pages (panel) | ✅ Activo | `usoinmobiliario-middleware` → `.github/workflows/deploy.yml` |
| Render (backend) | ✅ Activo | Plan gratuito — cold start de 20-30s tras inactividad |
| Firebase Realtime Database | ✅ Activo | Única base de datos del proyecto — sin Firestore, sin Storage |
| Firebase Hosting | ❌ Configurado, no desplegado | `firebase.json`/`.firebaserc` listos, requiere `firebase deploy` manual |
| Firebase Cloud Functions | ❌ Preparado, no desplegable | Requiere plan Blaze (pago por uso) — por eso el bot vive en Render |
| Cloudflare Worker (`email-worker/`) | ⚠️ Construido, no conectado | `EMAIL_WORKER_CONFIG` vacío en `index.html`; el correo real ya sale de `emailService.js` en su lugar |

## Roles (RBAC) — desde 2026-09-13

Tres roles reales en `/admin/api/*` (antes solo admin/super-admin): **OWNER** (dueño, sigue
siendo `config.superAdminEmail`), **ADMIN** (operativo, sin gestión de usuarios) y **EMPLOYEE**
(solo sus tareas de aseo/mantenimiento asignadas + notificaciones). Aplicado server-side en
`adminAuth.js` (`attachRole`/`requireRole`), nunca solo ocultando botones en React. Detalle
completo, matriz de rutas y qué se dejó fuera de alcance: ver `RBAC.md`.

## Apartamentos — CMS real desde 2026-09-13

`Apartments.tsx` dejó de ser un dashboard de solo lectura: `POST/PUT /admin/api/apartments`
(dueño únicamente) permite crear/editar tarifas, área, capacidad, camas, característica
destacada y **visibilidad** (`isVisible`) sin tocar la consola de Firebase. Un apartamento
oculto (`isVisible: false`) desaparece del catálogo público (`apartmentsByCategory()` en
`FirebaseDataProvider.js`) pero sigue completo en el panel. Fotos/recorrido 360° siguen siendo
archivos en `media/` del sitio público, fuera de Firebase — no hay editor de imágenes (este
proyecto no usa Firebase Storage, por diseño).

## Decisiones de diseño ya tomadas (no reabrir sin discutirlo)

- Un solo archivo HTML sin build para el sitio — permite deploy sin dependencias, a costa de
  necesitar `'unsafe-inline'` en la CSP (ver `SECURITY_AUDIT.md` P2-02).
- El bot de WhatsApp/chat web nunca tiene funciones administrativas — ninguna herramienta de IA
  puede confirmar pagos ni reservas, por diseño estructural, no por instrucción de prompt.
- `status`/`paymentStatus` son campos directos, no hay una entidad "HOLD" separada — el HOLD es
  derivado (`isHoldExpired`), evita duplicar el registro.
- Sin `customers/` como entidad reutilizable — los datos de contacto viven embebidos en cada
  reserva/cita; crear una entidad cliente es una decisión de negocio pendiente, no un olvido.
- El badge de estado operativo (disponible/en-uso/reservado) YA NO bloquea la solicitud de
  reserva en el sitio público (`isUnitBookable` en `index.html` siempre devuelve `true`, desde
  2026-09-13) — la única protección real contra doble-reserva es `checkAvailability()` por
  rango de fechas exacto, sin cambios. Una unidad "en uso" hoy puede tener fechas futuras
  perfectamente libres; el badge y la disponibilidad futura son preguntas distintas a propósito.
