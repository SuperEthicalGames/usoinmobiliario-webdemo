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
        │                                   │                              │
        │ Firebase JS SDK              Firebase Admin SDK                  │
        │ (cliente anónimo)            (cuenta de servicio,                │
        │ pasa por Rules               salta las Rules)                   │
        ▼                                   ▼                              ▼
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

**Reserva desde el sitio web:** catálogo → `AvailabilityService` en vivo → `PricingService`
(client-side) → datos de contacto → `ReservationService.createRecord()` → HOLD de 15 min
(`expiresAt`) → elegir método de pago → transferencia (reporte con comprobante) o efectivo (solo
aviso) → esperar verificación humana desde el panel.

**Reserva por WhatsApp/chat:** mensaje en lenguaje natural → `assistantCore` decide qué función
llamar (nunca inventa datos — `validators.js` bloquea placeholders) → `businessTools.js` valida y
llama a `firebase.js` (Admin SDK, con transacciones atómicas propias) → mismo HOLD de 15 min,
mismo formato de código, misma fórmula de precio que el sitio web.

**Verificación de pago (solo admin):** `Payments.tsx` lista transferencias reportadas/efectivo
pendiente → admin ve `priceCheck` si el total reportado no coincide con la tarifa real
(`pricing.priceIntegrityCheck`, ver `SECURITY_AUDIT.md` P1-03) → `verify`/`reject`/`register-cash`
→ el estado de la RESERVA sigue aparte (`confirm`/`reject`/`cancel`/`complete` en `Reservations.tsx`).

**Anti-doble-reserva:** cada noche/turno se reclama con una transacción atómica sobre
`bookedNights`/`bookedVisitSlots` (Rules para el sitio web, `db.ref().transaction()` para el
Admin SDK) — si dos solicitudes compiten por la misma fecha, solo una gana; la otra recibe
`conflict` y no deja el sistema en un estado a medias (libera lo que sí alcanzó a reclamar).

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

## Decisiones de diseño ya tomadas (no reabrir sin discutirlo)

- Un solo archivo HTML sin build para el sitio — permite deploy sin dependencias, a costa de
  necesitar `'unsafe-inline'` en la CSP (ver `SECURITY_AUDIT.md` P2-02).
- El bot de WhatsApp/chat web nunca tiene funciones administrativas — ninguna herramienta de IA
  puede confirmar pagos ni reservas, por diseño estructural, no por instrucción de prompt.
- `status`/`paymentStatus` son campos directos, no hay una entidad "HOLD" separada — el HOLD es
  derivado (`isHoldExpired`), evita duplicar el registro.
- Sin `customers/` como entidad reutilizable — los datos de contacto viven embebidos en cada
  reserva/cita; crear una entidad cliente es una decisión de negocio pendiente, no un olvido.
