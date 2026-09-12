# Respuesta a auditoría externa — "Auditoría técnica a nivel de estudio de software"

**Recibida:** 2026-09-11. **Este documento:** 2026-09-12. **Alcance de la respuesta:** los dos
repos activos (`usoinmobiliario-webdemo`, este repo, y `usoinmobiliario-middleware`) tal como
están HOY en `main`/rama de trabajo — no el ZIP que se auditó externamente, que es un snapshot
de un punto anterior y ya no representa el código real (ver §1).

**Método:** cada uno de los ~50 numerales de la auditoría externa se contrastó contra el código
real (no contra lo que el propio audit afirma) — grep/lectura directa de `database.rules.json`,
`FirebaseDataProvider.js`, `firebase.js`, `adminRoutes.js`, `index.html`, `SECURITY.md` y
`SECURITY_AUDIT.md` (la auditoría interna del 2026-09-10/11, hecha en paralelo y de forma
independiente a la externa). Un hallazgo se probó cuando fue posible (ver §7 para las
limitaciones reales de este entorno); donde no fue posible, se dice explícitamente.

---

## 0. Veredicto corto

La auditoría externa acierta en el diagnóstico general (proyecto que creció de MVP a
plataforma, con partes de madurez desigual) y en **un hallazgo real y crítico que la auditoría
interna previa no había señalado** (§2 abajo — squatting de disponibilidad). El resto de sus
~50 secciones se dividen en: ya corregido en una auditoría interna paralela, ya evaluado y
aceptado como decisión de negocio consciente (documentado con su porqué), parcialmente
inexacto contra el código real de hoy, o roadmap legítimo de arquitectura que requiere su
propia sesión dedicada (no algo que se "parche" sin romper el sitio en producción).

| # | Hallazgo de la auditoría externa | Veredicto | Acción tomada |
|---|---|---|---|
| §3 (credenciales en el ZIP) | 🔴 Crítico | **No aplica a los repos** — ver §1 | Ninguna en código; acción manual pendiente del dueño (rotar si esas claves eran reales) |
| §4-6 (Firebase permite manipular disponibilidad) | 🔴 Crítico | **CONFIRMADO — más grave de lo descrito** | **Corregido**, ver §2 |
| §7 (`unitBookings` escribible anónimo) | 🔴 Crítico | Mismo hallazgo que §4-6 | Corregido junto con §2 |
| §8-9 (concurrencia de reservas) | — | Ya corregido en sesión previa (`claimNightAtomically`) | Sin cambios, ya verificado en `SECURITY_AUDIT.md` |
| §11-12 (privacidad del código de reserva / `unitBookings` público) | 🟡 Medio | Ya evaluado, riesgo residual aceptado | Sin cambios (ver §4) |
| §13-14 (pagos / price snapshot) | 🟡 Medio | Ya mitigado (`priceIntegrityCheck`) | Sin cambios, coincide con `SECURITY_AUDIT.md` P1-03 |
| §17-19 (costos de IA / rate limit en memoria) | 🟡 Medio | Ya documentado como limitación aceptada de MVP | Sin cambios (ver §4) |
| §21-22 (`index.html` monolítico / duplicación de datos) | 🟢 Válido, no urgente | Roadmap de arquitectura | Sin cambios (ver §5) |
| §23 (fallback silencioso a localStorage) | 🟡 Medio | Parcialmente inexacto contra el código actual | Ver §4 (matiz importante) |
| §25 (dos proveedores de correo) | 🟡 Bajo | **Inexacto** — solo uno está vivo | Ver §4 |
| §26 (idempotencia) | 🟡 Medio | Válido | Roadmap (§5) |
| §34 (falta auditoría de acciones) | 🟠 Alto | **CONFIRMADO** | **Corregido**, ver §3 |
| §36-38 (testing) | 🔴 Crítico | Válido | Roadmap (§5) — no se inventó una suite completa en esta sesión, ver por qué |
| Resto (§15-16, §20, §27-33, §39-50) | — | Análisis/recomendaciones de arquitectura, en su mayoría ya alineadas con decisiones ya tomadas o correctas tal como están | Ver §4/§5 según aplique |

---

## 1. Sobre "credenciales reales dentro del ZIP" (§3)

Verificado de nuevo en esta sesión (no solo reusando la verificación de `SECURITY_AUDIT.md`):

```
git ls-files | grep -i env          → whatsapp-assistant/.env.example (vacío, plantilla)
                                       whatsapp-assistant/.env.usoinmobiliario-c8e83 (NO
                                       sensible, ver su propio encabezado — solo
                                       FIREBASE_DATABASE_URL/modelo de IA/SITE_BASE_URL)
git log --all --diff-filter=A -- '*.env' '**/.env'   → sin resultados, nunca se trackeó
```

Ningún repo (`usoinmobiliario-webdemo`, `usoinmobiliario-middleware`) tiene ni tuvo nunca un
`.env` real commiteado. El hallazgo de la auditoría externa es sobre el **artefacto ZIP** que
se le entregó a esa auditoría (`usoinmobiliario-webdemo(3).zip`), que por definición es un
snapshot de un directorio de trabajo local en algún momento — si ese ZIP se generó con
`zip -r` sobre la carpeta del proyecto sin excluir `.env`, el `.env` real del desarrollador
(que sí vive fuera de git, solo local) habría quedado adentro. Esto es un problema de **cómo
se generó ese ZIP para compartirlo**, no del repositorio.

**Acción manual pendiente (no es código, no se puede resolver desde una sesión de Claude Code):**
si las claves de OpenAI/Gemini/WhatsApp que estaban en ese ZIP específico eran reales y
siguen activas, rotarlas en sus respectivos paneles (OpenAI Platform, Google AI Studio, Meta
for Developers) como ya indica `SECURITY.md` §"Gestión de secretos". Ningún cambio de código
puede confirmar o descartar esto — solo el dueño del proyecto sabe si ese ZIP en particular
tenía un `.env` real adentro.

---

## 2. CORREGIDO — Firebase permitía crear candados permanentes de disponibilidad (§4-7)

Este es el hallazgo real más importante de la auditoría externa, y es más grave de lo que su
propio texto describe.

**Lo que decía la auditoría externa:** un visitante anónimo puede escribir directo a
`bookedNights/{unidad}/{fecha}` (la regla solo pedía `!data.exists()`), bloqueando fechas
falsas — "Business Logic DoS".

**Lo que se confirmó leyendo el código (más grave que "DoS temporal"):** una fecha bloqueada
así no tiene ningún `unitBookings` real detrás con `expiresAt`. Todo el mecanismo que libera
un HOLD vencido —`reclaimExpiredHold()` en `FirebaseDataProvider.js`/`firebase.js`, y la propia
condición de reclamo dentro de la regla de `bookedNights`— depende de leer
`unitBookings/{unidad}/{código}/status|expiresAt|paymentStatus`. Si ese código no existe en
`unitBookings` (porque el atacante escribió `bookedNights` solo, sin nada detrás), esa lectura
da `null`, la condición de reclamo nunca se cumple, y la fecha queda bloqueada **para
siempre** — no hasta que expire un HOLD, porque nunca hubo un HOLD real. Lo mismo aplica a
`bookedVisitSlots` (sin mecanismo de reclamo, así que ahí ya era igual de grave incluso con un
`unitBookings` real detrás — ver limitación residual abajo).

**Corrección aplicada** (`firebase/database.rules.json`): dentro del mismo `update()`
multi-ruta que ya usa el flujo real de creación (que escribe `reservationsManager/{reservations
|visits}/{code}` + `unitBookings/{unitKey}/{code}` + `bookedNights`/`bookedVisitSlots` en una
sola llamada atómica), las reglas ahora exigen que:

1. `unitBookings/{unitKey}/{code}` solo puede crearse si existe (en el MISMO update) una
   `reservationsManager/reservations/{code}` (o `/visits/{code}` según el tipo) real, con
   `unitType_unitNum` coincidiendo con `$unitKey` — o sea, ya no se puede crear un
   `unitBookings` huérfano.
2. `bookedNights/{unitKey}/{fecha}` solo puede crearse si el código que referencia corresponde
   a un `unitBookings` real de tipo `reserva` cuyo rango `checkin`/`checkout` cubre esa fecha.
3. `bookedVisitSlots/{unitKey}/{turno}` solo puede crearse si el código que referencia
   corresponde a un `unitBookings` real de tipo `cita` con el mismo `visitDate_visitTime`.

Firebase evalúa `.validate` de TODAS las rutas de un `update()` multi-ruta contra el estado
final propuesto (`root`/`newData` ven el resultado completo de la operación, no solo la ruta
individual) — por eso esto se puede exigir sin romper el flujo legítimo, que ya escribe las
tres rutas juntas en una sola llamada (`FirebaseDataProvider.js:249-265`, comentario ya
existente en el archivo que documenta esto). El costo de squatting ahora es exactamente el
mismo que ya tenía crear una reserva real falsa (nombre/teléfono/correo inventados) — que SÍ
expira y SÍ se libera, a diferencia del candado permanente que esto cierra.

**Limitación reconocida (no oculta):** esto NO resuelve que cualquiera pueda seguir creando
reservas/citas con datos de contacto inventados — esa es una decisión de negocio ya tomada y
documentada en `SECURITY.md` ("no hay verificación de identidad... decisión de negocio ya
tomada"). Lo que se cierra es específicamente el candado permanente e irrecuperable; el
squatting temporal vía reservas falsas sigue siendo posible y se autolimpia con el mecanismo
de HOLD ya existente (reservas) — las citas (`bookedVisitSlots`) siguen sin un mecanismo de
expiración propio incluso para una cita "legítima" falsa, así que un turno ocupado con una cita
inventada sigue quedando bloqueado hasta que un admin lo cancele a mano; antes de esta
corrección un turno podía quedar bloqueado SIN que existiera ningún registro que un admin
pudiera siquiera encontrar para cancelarlo — ahora al menos aparece en el panel como una cita
pendiente real, revisable y cancelable.

**Verificación realizada:**
- JSON válido (`node -e "JSON.parse(...)"`) tras el cambio.
- Trazado a mano de los 5 escritores reales de estas rutas en `FirebaseDataProvider.js`
  (`createReservation` para reserva/cita específica/visita general, `reclaimExpiredHold`,
  `setReservationStatus`, `reportPayment`) contra la regla nueva — ninguno queda bloqueado
  (los `null` de cancelación/reclamo no corren `.validate`, ver nota de §7 abajo; las
  escrituras de creación siguen escribiendo las tres rutas juntas).
- Se intentó levantar el emulador de Realtime Database (`firebase-tools`, vía
  `@firebase/rules-unit-testing`) para probar en vivo cuatro escenarios (creación legítima,
  ataque de `bookedNights` solo, ataque de `unitBookings`+`bookedNights` sin reserva real
  detrás, reclamo legítimo de HOLD vencido) — el emulador de este proyecto necesita alcanzar
  `firebase-public.firebaseio.com`, bloqueado por la política de red de este entorno (403 en el
  proxy, confirmado con `curl $HTTPS_PROXY/__agentproxy/status`). Siguiendo la misma regla que
  ya aplica el resto de esta sesión (no reintentar denegaciones de política de red), no se
  insistió con esa vía.

**Acción manual pendiente:** publicar `firebase/database.rules.json` en la consola real de
Firebase (Realtime Database → Reglas) — este entorno no tiene el CLI de Firebase autenticado
contra el proyecto real, así que el archivo del repo y lo publicado pueden no coincidir hasta
que se haga a mano (mismo punto ya pendiente en `SECURITY_AUDIT.md` §6, no es nuevo). **Antes
de publicar, se recomienda probar la regla nueva contra el proyecto real** (o con el emulador,
desde un entorno sin esta restricción de red) con al menos: crear una reserva real desde el
sitio (debe funcionar exactamente igual que hoy), y confirmar que una escritura directa a
`bookedNights` sin nada detrás ahora se rechaza.

---

## 3. CORREGIDO — Bitácora de acciones administrativas (§34)

La auditoría externa señala correctamente que no existía ningún registro de quién hizo qué
sobre reservas/pagos/contratos. Se agregó:

- `whatsapp-assistant/src/firebase.js`: `logAdminAction()` (escribe a `auditLog/` con
  `push()`, mejor esfuerzo — un fallo de log nunca tumba la acción real que registra) y
  `listAuditLog(limit)` (lee las últimas N con `orderByKey().limitToLast()`, no todo el árbol
  — a diferencia de `listReservations()`/`listContracts()`, este árbol crece sin cota).
- `whatsapp-assistant/src/adminRoutes.js`: las 17 rutas que cambian estado real (crear/
  confirmar/rechazar/cancelar/completar reserva, check-in/out, verificar/rechazar/registrar
  pago, crear/revocar admin, editar datos bancarios, crear/cambiar estado de contrato/aseo/
  mantenimiento) ahora llaman `logAction(req, accion, objetivo, metadata)` tras el éxito real
  de la operación — nunca antes, nunca si la operación falló.
- Nueva ruta `GET /admin/api/audit-log` (`requireSuperAdmin` — mismo nivel de sensibilidad que
  `/admins` y `/payment-info`, no cualquier admin operativo).
- `usoinmobiliario-middleware`: nueva pantalla "Bitácora" (`src/pages/AuditLog.tsx`), visible
  solo para el admin principal (mismo criterio que `Admins.tsx` — restricción real en backend,
  esto solo evita mostrar un link que el servidor rechazaría).
- No se tocó `database.rules.json` para `auditLog/` — cae bajo el `$other: {read:false,
  write:false}` ya existente (nadie más que el Admin SDK debe tocar esto, igual que
  `contracts`/`cleaningTasks`/`maintenanceTickets`, que tampoco tienen regla propia).

**Verificación realizada:** `node --check` sobre ambos archivos de backend modificados;
arranque real del servidor (`node src/server.js` con variables dummy, igual que la auditoría
interna previa) — `/health` respondió `200` y `GET /admin/api/audit-log` sin token respondió
`401 missing-token` (no `500`), confirmando que la ruta nueva está bien montada. En el panel:
`tsc -b && vite build` completo sin errores nuevos (el chunk `AuditLog-*.js` se generó
correctamente); `oxlint` sin advertencias nuevas más allá del mismo patrón `set-state-in-effect`
que ya existe idéntico en las otras 12 pantallas del panel.

---

## 4. Ya evaluado / decisión de negocio ya tomada / inexacto contra el código de hoy

Puntos donde la auditoría externa señala algo real pero que ya fue evaluado antes (con su
razón documentada) o que ya no describe el código actual con precisión:

- **§11-12, códigos de reserva de 6 caracteres / `unitBookings` público:** ya evaluado en
  `SECURITY_AUDIT.md` §3 ("IDOR en códigos de reserva") — sin capacidad de listar
  (`reservationsManager/reservations` en sí exige `auth != null` para listar, solo se puede
  consultar un código YA conocido), ~13.8 millones de combinaciones, riesgo residual bajo ya
  aceptado. No se reabrió.
- **§13-14, integridad de precio:** exactamente lo que `SECURITY_AUDIT.md` P1-03 ya documentó
  como "mitigado, no bloqueado" — recalcular la fórmula completa dentro de Rules se evaluó y
  se descartó por el riesgo de romper reservas legítimas sin poder probarlo en vivo contra el
  proyecto real (mismo entorno con la misma restricción de red que limitó la prueba del punto
  2). Sigue siendo la recomendación correcta para una sesión con acceso real a la consola.
- **§17-19, costos de IA / rate limit en memoria:** ya documentado como limitación aceptada de
  MVP (un solo proceso en Render hoy, no una flota) — válido como roadmap si el negocio crece a
  múltiples instancias, no urgente al tamaño actual.
- **§23, fallback silencioso a LocalStorage:** el matiz importante que la auditoría externa no
  capta: `FirebaseDataProvider.js` NO empieza en Firebase y cae a Local si falla — empieza en
  `LocalDataProvider` (línea 1462 de `index.html`) y solo se ACTIVA (reemplaza a Local) una vez
  que `categories`/`apartments`/`statusMeta` cargaron con éxito desde Firebase (`maybeActivate()`,
  `FirebaseDataProvider.js:419-428`). Si Firebase nunca responde, el sitio se queda en modo
  local — mismo comportamiento, pero "nunca se activó" es distinto de "se cayó a mitad de una
  reserva real". El riesgo que señala la auditoría externa (un cliente cree que su reserva es
  real cuando solo vive en su navegador) sigue siendo válido en el escenario de Firebase caído
  desde el principio de la sesión del visitante — pero cambiar esto a un bloqueo duro
  ("servicio no disponible") es una decisión de producto (el modo local también sirve para
  demos/portfolio sin Firebase configurado, uso real y documentado de este proyecto), no algo
  para decidir unilateralmente en esta sesión. Se deja como recomendación, no como corrección.
- **§25, "dos sistemas de correo":** verificado contra el código real — `email-worker/`
  (Cloudflare Worker + SES) **no está referenciado desde ningún lado** (`grep` sobre
  `index.html` y `whatsapp-assistant/src/*.js` no encuentra ninguna llamada a él); el único
  camino de correo real y activo es `whatsapp-assistant/src/emailService.js` vía Gmail SMTP.
  No son "dos soluciones semi-activas", es una viva y un directorio sin usar. Se corrige la
  imprecisión aquí; no se borró `email-worker/` en esta sesión (borrar código no es parte de
  responder una auditoría de seguridad, y no se confirmó con el dueño si tiene planes de
  retomarlo).
- **§27, tamaño del ZIP de entrega:** no aplica a los repos — es sobre cómo se empaquetó el
  ZIP que se le compartió a la auditoría externa (`.git`/`node_modules` incluidos), no algo
  que un cambio de código en el repo pueda resolver.
- **§33, super admin por comparación de email:** ya es una decisión consciente documentada en
  `SECURITY.md` ("comparación de string, no un custom claim — decisión consciente: una sola
  cuenta principal conocida de antemano no justifica el paso extra de bootstrap de custom
  claims"). La auditoría externa la señala como si fuera un descuido; no lo es.

---

## 5. Roadmap real (fuera de alcance de esta sesión, no un descuido)

Estos son recomendaciones legítimas de la auditoría externa que representan cambios de
arquitectura reales, no bugs puntuales corregibles sin riesgo en una sesión que además debe
mantener el sitio funcionando en producción:

- **§7 del pedido original / arquitectura central:** mover la creación de reservas del
  navegador a un backend que sea el único dueño de la lógica de negocio. Es la recomendación
  más grande de la auditoría y la correcta a mediano plazo, pero es un cambio de arquitectura
  mayor (reescribir `FirebaseDataProvider.js` completo, mover `pricing.js` a un servicio
  compartido, cambiar cómo el sitio público habla con el backend) que no se puede hacer de
  forma segura sin acceso a probar contra el proyecto real de Firebase y sin arriesgar romper
  el flujo de reservas en producción a medio camino. Requiere su propia sesión, con plan de
  migración explícito y sin cambios a medias (nada de "la mitad de las reservas ahora pasan
  por el backend, la otra mitad todavía escribe directo a Firebase").
- **§11 (separar reservationPublic/reservationPrivate):** mismo criterio — toca todos los
  puntos que leen `reservationsManager/{reservations,visits}` (sitio, bot de WhatsApp, panel),
  necesita migrar datos existentes, y solo tiene sentido si se hace junto con el punto
  anterior (un backend que medie el acceso, no Rules más complejas sobre la estructura actual).
- **§21-22, migración a TypeScript/Vite/componentización del sitio público:** válido y
  reconocido en `SECURITY_AUDIT.md`/`ARCHITECTURE.md` como la razón por la que la CSP del
  sitio necesita `unsafe-inline` hoy. Es la inversión de mantenibilidad correcta a mediano
  plazo, no algo que deba mezclarse con una respuesta a auditoría de seguridad.
- **§26, idempotency keys en `/admin/api/reservations` y equivalentes del sitio:** válido —
  hoy un doble-click o un retry de red podría, en teoría, crear dos registros con datos
  iguales pero códigos distintos (no una doble-reserva de la misma fecha, eso ya está
  protegido por `claimNightAtomically`/las Rules, sino un duplicado administrativo). Se deja
  como recomendación concreta para una próxima sesión: header `Idempotency-Key` en el POST,
  guardado junto al registro, rechazar un reintento con la misma clave devolviendo el registro
  ya creado.
- **§36-38, suite de tests:** el hallazgo más importante que esta sesión NO intentó resolver
  de fondo. Escribir un suite real (`pricing`, `reservations`, `availability`, `payments`,
  `concurrencia`, `seguridad`) es trabajo legítimo de varias sesiones, y el emulador de
  Firebase — la única forma real de probar Rules y transacciones contra un backend real, no
  solo funciones puras — está bloqueado por la política de red de ESTE entorno específico (ver
  §2 y §7). Se puede escribir la parte pura (pricing, validators, dateUtil) sin ese bloqueo;
  la parte de Rules/transacciones necesita un entorno sin esa restricción, o acceso al CLI de
  Firebase autenticado contra el proyecto real.
- **§39-44, observabilidad/métricas de negocio/reducir superficie de despliegue:** recomendaciones
  correctas de madurez de producto, ninguna es una vulnerabilidad — se dejan como roadmap, no
  se implementó nada de esto ahora para no diluir el foco de una respuesta de seguridad con
  features nuevas no pedidas.

---

## 6. Lo que la auditoría externa reconoce que ya está bien (§45) — reconfirmado

Se releyeron los 12 puntos de "lo que no cambiaría" (function calling, IA sin permisos
administrativos, backend separado de IA, Firebase como datastore, price snapshot, HOLD
temporal, transacciones para disponibilidad, ID token server-side, separación admin/super-admin,
validación de URLs, timeouts, rate limiting) contra el código real — todos siguen así hoy, sin
regresión introducida por los cambios de esta sesión (los únicos archivos tocados fueron
`database.rules.json`, `firebase.js`, `adminRoutes.js`, y las piezas nuevas del panel; ninguno
de los 12 puntos depende de algo modificado).

---

## 7. Limitaciones de esta respuesta (declaradas, no ocultas)

- **No se pudo levantar el emulador de Firebase Realtime Database en este entorno** — necesita
  alcanzar `firebase-public.firebaseio.com`, bloqueado por la política de red de este sandbox
  (confirmado con el endpoint de diagnóstico del proxy, no una suposición). La corrección de
  §2 se verificó con JSON válido + trazado manual de cada escritor real contra la regla nueva
  (mismo nivel de rigor que ya usó `SECURITY_AUDIT.md` para su propio hallazgo de precios en
  Rules, P1-03, que tampoco se pudo probar en vivo) — pero **no reemplaza probarla contra el
  proyecto real antes de publicarla**, ver acción manual en §2.
- **No se tocó ningún dato en la Firebase real** (no hay credenciales de ese proyecto en este
  entorno) — todo lo de este documento es análisis de código + verificación local (sintaxis,
  arranque de servidor con variables dummy, build/lint del panel).
- **No se implementó nada del §5 (roadmap)** — son cambios de arquitectura reales que merecen
  su propia sesión con su propio plan, no algo para mezclar con esta respuesta.
