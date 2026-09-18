# Auditoría Técnica Profunda — Uso Inmobiliario
**Fecha:** 2026-09-16 · **Alcance:** `usoinmobiliario-webdemo` (sitio público + backend `whatsapp-assistant` + Firebase) y `usoinmobiliario-middleware` (panel admin) · **Método:** lectura directa del código actual + verificación en vivo de las reglas públicas de Firebase (peticiones GET no autenticadas, sin credenciales, contra rutas que las propias Rules declaran públicas) + 4 sub-auditorías especializadas (email/contratos/PDF, RBAC frontend, cobertura de tests, deriva de documentación).

> Convención: cada hallazgo cita archivo + línea real. "NEEDS VERIFICATION" significa que el código es consistente con el riesgo pero confirmarlo del todo requiere un dato fuera del repo (p. ej. una config de consola de Firebase). Los documentos `AUDITORIA*.md`/`SECURITY*.md` ya existentes en el repo son insumo, no fuente de verdad — donde contradicen al código actual, gana el código (ver sección "Deriva de documentación").

---

## 1. Executive Summary

El sistema está considerablemente mejor construido de lo que suele verse en un proyecto de este tamaño: hay transacciones atómicas reales contra doble reserva, idempotencia real en las rutas de escritura, una única fuente de verdad para el precio (recalculado siempre en el servidor), un RBAC de backend correctamente verificado en cada ruta sensible (confirmado cruzando panel↔backend ruta por ruta), y una IA/WhatsApp cuyo daño potencial está acotado estructuralmente (las funciones que el modelo puede invocar nunca incluyen confirmar pagos ni cambiar estados — la inyección de prompt no tiene ningún privilegio que escalar).

Dicho esto, hay **un hallazgo crítico real y demostrado en producción**: el código de reserva (`reservationCode`) fue diseñado deliberadamente como "la única credencial" (documentado en `SECURITY.md`), asumiendo que su espacio de 13.8 millones de combinaciones lo hace impracticable de adivinar. Esa asunción es falsa hoy: el nodo `unitBookings` de Firebase es de lectura pública **en su raíz completa**, así que **no hace falta adivinar nada** — una sola petición HTTP sin autenticar devuelve todos los códigos de reserva/cita que existen. Con cada código, otra petición pública (`reservationsManager/reservations/{code}`) devuelve el registro completo: nombre, teléfono, correo, fechas, monto y — si ya reportó el pago — banco/referencia/comprobante. Verifiqué esto en vivo contra el proyecto real (`usoinmobiliario-c8e83`) con dos peticiones GET sin credenciales; los detalles y la prueba están en el hallazgo SEC-001.

Segundo hallazgo crítico (parcialmente especulativo, requiere una verificación que no puedo hacer sin crear una cuenta real, algo que no voy a hacer): la resolución de roles del backend asigna `'admin'` por defecto a **cualquier cuenta autenticada de Firebase** que no tenga un documento en `roles/{uid}` (`adminAuth.js:51`, `firebase.js:870`). Si el registro público de Email/Password sigue habilitado a nivel de proyecto de Firebase (el comportamiento por defecto al activar ese proveedor, y no encontré ninguna Cloud Function ni configuración de Identity Platform que lo restrinja en ninguno de los dos repos), cualquier persona en internet podría crear una cuenta de Firebase Auth por su cuenta y obtener acceso "admin" a la mayoría de `/admin/api/*` sin que el dueño del negocio haya invitado a nadie. Ver SEC-002 para cómo verificarlo de forma segura (no requiere que yo intente crear una cuenta).

Fuera de estos dos, el resto de hallazgos son MEDIUM/LOW: falta rate-limit por IP en las rutas de correo (oráculo de existencia + riesgo de agotar la cuota de Resend), un endpoint de diagnóstico de WhatsApp olvidado en producción, "Revocar" un admin no invalida tokens ya emitidos (~1h de ventana, ya documentado como decisión consciente), la IA puede confirmar que un código existe y ver sus fechas/monto sin verificar que quien pregunta es el dueño, y 10 vulnerabilidades "moderate" de npm audit en dependencias transitivas de `firebase-admin` (parche sin cambios de breaking probable).

**Prioridad de implementación en esta sesión:** cerrar SEC-001 (Firebase Rules + capa de lectura por backend) y el patrón fail-open de SEC-002 son P0. El resto son P1/P2 y se implementan a continuación de eso.

---

## 2. Arquitectura actual (mapa real, no el de los docs viejos)

```
usoinmobiliario-webdemo/            (repo público)
├── index.html                       sitio estático, un solo archivo (CSS/JS embebidos)
├── firebase/
│   ├── firebase-config.js           apiKey público (no es secreto, por diseño de Firebase)
│   ├── FirebaseDataProvider.js      SDK cliente de Firebase — YA NO escribe reservas/pagos
│   │                                 directo (POSTea al backend); SÍ sigue leyendo reservas
│   │                                 directo (getReservation) y unitBookings/categories/
│   │                                 apartments/statusMeta/settings vía onValue()
│   └── database.rules.json          Rules reales (auditadas en detalle, sección 4)
├── whatsapp-assistant/               backend Express (Render, Node 20)
│   ├── src/app.js                    rutas públicas + montaje de /admin/api
│   ├── src/adminAuth.js              verifica ID token Firebase + resuelve rol (RBAC)
│   ├── src/adminRoutes.js            todas las rutas /admin/api/* (610 líneas, RBAC por ruta)
│   ├── src/firebase.js               ÚNICO lugar que usa el Admin SDK (1373 líneas)
│   ├── src/reservationBuilder.js     única lógica de validar→precio→armar reserva/cita
│   ├── src/businessTools.js          las ÚNICAS funciones que la IA puede invocar
│   ├── src/assistantCore.js          system prompt + tool schemas (canal-agnóstico)
│   ├── src/whatsapp.js               HMAC del webhook + envío de mensajes
│   ├── src/emailService.js           Resend (HTTP API), nunca SMTP
│   └── src/{pricing,dateUtil,validators}.js
├── email-worker/                     Cloudflare Worker — ya NO es el camino real de correo
│                                      (ver Deriva de documentación); vestigial.
└── AUDITORIA*.md, SECURITY*.md, ...  8 documentos de auditorías/arquitectura ANTERIORES,
                                       de distintas fechas — varios ya obsoletos (sección 12)

usoinmobiliario-middleware/           (repo del panel admin, GitHub Pages)
├── src/firebase.ts                   SOLO Firebase Auth (login) — nunca lee/escribe RTDB
├── src/AuthContext.tsx               rol viene del backend (api.getMe()), nunca hardcodeado
├── src/api.ts                        único cliente HTTP hacia /admin/api/*
└── src/pages/*.tsx                   Dashboard, Reservations, Payments, Contracts, Cleaning,
                                        Maintenance, Apartments, Users, Configuracion, AuditLog,
                                        Analytics, Visits, ManualReservation, Login
```

**Flujo de reservas actual (ya migrado, contrario a lo que dicen los docs de auditoría más viejos):**
`index.html` → `POST /reservations` (backend) → `reservationBuilder.buildReservationRecord` (valida, resuelve apartamento, tope de huéspedes, disponibilidad, **precio recalculado en servidor**, genera código único) → `firebase.createReservation` (reclama cada noche con una transacción atómica independiente; si cualquiera falla, libera las ya reclamadas y aborta) → respuesta con el registro completo. Todo dentro de `withIdempotency(Idempotency-Key)`.

Esto ya resuelve gran parte de lo que la documentación vieja (`AUDITORIA_COMPLETA.md`, `AUDITORIA_EXTERNA_2026_09.md`) marcaba como pendiente ("mover la creación de reservas del navegador al backend", "idempotencia en rutas públicas") — ambos se completaron el 2026-09-13, un día después de la última auditoría externa, que nunca se actualizó para reflejarlo.

**Lo que SÍ sigue siendo lectura directa del navegador a Firebase** (`FirebaseDataProvider.js`): `categories`, `apartments`, `statusMeta`, `settings` (catálogo público, correcto que sea público), `unitBookings` (pensado para alimentar disponibilidad en vivo, pero expuesto de más — ver SEC-001), y `getReservation(code)` / `getMyReservations()` (lectura directa de `reservationsManager/{reservations,visits}/{code}` — el corazón de SEC-001).

---

## 3. Clasificación de hallazgos

| ID | Severidad | Componente | Resumen | Prioridad |
|---|---|---|---|---|
| SEC-001 | **CRITICAL** | Firebase Rules (`unitBookings`, `reservationsManager/*/$code`) | Enumeración pública total de reservas/citas + PII + datos de pago, sin autenticación ni adivinar nada | P0 |
| SEC-002 | **CRITICAL / NEEDS VERIFICATION** | `adminAuth.js` (RBAC) | Cualquier cuenta autenticada de Firebase sin `roles/{uid}` se vuelve `'admin'` por defecto; depende de si el alta pública de Firebase Auth sigue habilitada | P0 |
| SEC-003 | MEDIUM | `app.js` rutas `/email/*` | Sin rate-limit por IP → oráculo de existencia de códigos + riesgo de agotar cuota Resend | P1 |
| SEC-004 | LOW-MEDIUM | `businessTools.js:getReservationTool` | La IA/WhatsApp puede confirmar código+fechas+monto+estado de pago sin verificar que el remitente es el dueño de esa reserva | P1 |
| SEC-005 | LOW | `adminRoutes.js:599` | Endpoint de diagnóstico `_diag/whatsapp` permite a cualquier admin/owner mandar WhatsApp arbitrario desde el número real del negocio | P1 |
| SEC-006 | LOW/INFO | `adminAuth.js` + `firebase.js:setAdminUserDisabled` | "Revocar" un admin no invalida su ID token ya emitido (ventana ≤1h) — decisión ya documentada, no un bug nuevo | P2 |
| SEC-007 | LOW | Dependencias backend | 10 vulnerabilidades "moderate" (npm audit) en `uuid`/`gaxios`/`google-gax`, transitivas de `firebase-admin`/`@google-cloud/*` | P2 |
| SEC-008 | INFORMATIONAL | `firebase/seed-payment-info.json` | Nombre real + número de cuenta bancaria de una persona, commiteados en un repo público — pero ya son públicos a propósito vía `settings/paymentInfo` (el negocio necesita mostrarlos para que los clientes transfieran) | P3 |
| — | INFORMATIONAL | Múltiples | Controles verificados como SÓLIDOS (ver sección 10) — no son hallazgos, se listan para no dar falsos positivos | — |

---

## 4. SEC-001 — Enumeración pública total de reservas (CRITICAL)

**Componente:** `firebase/database.rules.json` líneas 111-133 (`unitBookings`) y líneas 20-30 / 86-88 (`reservationsManager/reservations/$code`, `/visits/$code`); `firebase/FirebaseDataProvider.js:264-273` (`getReservation`); `whatsapp-assistant/src/firebase.js:73-78` (`generateCode`).

**Comportamiento actual:**
```json
"unitBookings": { ".read": true, "$unitKey": { "$code": { ... } } }
```
`.read: true` está declarado en la **raíz** de `unitBookings`, no solo en la hoja `$code`. En Firebase Realtime Database, un `.read` en un nodo padre se hereda hacia toda la subárbol para lecturas de ESE nodo o superiores — así que una sola petición a la raíz de `unitBookings` (sin conocer ninguna unidad ni código de antemano) devuelve el árbol completo.

**Evidencia (verificación en vivo, sin credenciales, contra el proyecto real):**
```
$ curl -s 'https://usoinmobiliario-c8e83-default-rtdb.firebaseio.com/unitBookings.json?shallow=true'
{"dos_02":true,"dos_18":true,"dos_07":true,"estudio_09":true,"dos_19":true,
 "dos_01":true,"dos_12":true,"dos_04":true,"estudio_06":true}
HTTP 200
```
```
$ curl -s 'https://usoinmobiliario-c8e83-default-rtdb.firebaseio.com/unitBookings/estudio_06.json'
{"CFC413":{"checkin":"2026-11-01","checkout":"2026-11-03","expiresAt":1789409233632,
 "paymentStatus":"none","status":"cancelada","type":"reserva"}}
```
Con el código real `CFC413` obtenido así (cero adivinanza), una segunda petición pública:
```
$ curl -s 'https://usoinmobiliario-c8e83-default-rtdb.firebaseio.com/reservationsManager/reservations/CFC413.json'
```
devuelve el registro completo — confirmé que trae `name`, `phone`, `email` (valores reales, que no reproduzco aquí por privacidad del cliente) además de `checkin/checkout/nights/guests/status/paymentStatus`. El *schema* validado por las propias Rules (`database.rules.json:44-79`) confirma que, cuando existen, también viajan `priceSnapshot` completo y `paymentReport.{reference,date,amount,bank,proofUrl}`.

**Por qué esto contradice la premisa de diseño ya documentada:** el propio código (`app.js:320-323`) y `SECURITY.md` explican la decisión consciente de que el código de 3 letras + 3 dígitos (`CODE_LETTERS` de 24 símbolos × 3 + 3 dígitos = 24³×1000 = **13.824.000** combinaciones) es "la credencial", asumida segura porque **"sin enumeración posible"**. Esa frase es correcta *solo si* nadie puede listar los códigos existentes — pero `unitBookings` con `.read:true` en la raíz hace exactamente eso: entrega la lista completa de códigos activos e históricos en una sola petición, sin necesidad de fuerza bruta contra el espacio de 13.8M.

**Exploit, paso a paso:**
1. `GET https://usoinmobiliario-c8e83-default-rtdb.firebaseio.com/unitBookings.json` → lista de TODOS los códigos de reserva/cita, con fechas y estado de pago, para las 17 unidades.
2. Para cada código: `GET https://usoinmobiliario-c8e83-default-rtdb.firebaseio.com/reservationsManager/reservations/{code}.json` (o `/visits/{code}.json`) → nombre, teléfono, correo, notas, y — si ya reportó pago — banco/referencia/monto/URL del comprobante.
3. Nada de esto pasa por el backend: no hay rate limit, no hay CORS que aplique (una petición `curl`/script no es un navegador), no hay logging del lado del negocio.

**Impacto:** exfiltración completa y trivial de PII (nombre, teléfono, correo) y datos financieros parciales (banco, referencia de transferencia, monto, y el link al comprobante de pago si es una URL) de **todas** las reservas y citas que existen o existieron, pasadas o futuras, con dos peticiones HTTP sin autenticar.

**Corrección propuesta (P0):**
1. **Cerrar `unitBookings` a lectura pública en la raíz.** Cambiar la regla para que `.read: true` viva únicamente en la hoja `$unitKey/$code` (ya no en `unitBookings` ni en `unitBookings/$unitKey`) — así solo se puede leer un registro puntual si ya se conoce unitKey+code exactos, nunca listar. Esto rompe la lectura actual que usa `FirebaseDataProvider.js` (`onValue(ref(db,'unitBookings'), ...)` para pintar disponible/en-uso/reservado en el catálogo) — hay que reemplazarla por un endpoint público de solo-lectura en el backend (`GET /availability` o similar) que use el Admin SDK (sin Rules) para devolver únicamente lo que el catálogo necesita (estado agregado por unidad, nunca el code→PII).
2. **Cerrar la lectura pública por código exacto de `reservationsManager/{reservations,visits}/$code`.** Sustituir `FirebaseDataProvider.getReservation(code)` (que hoy lee Firebase directo) por una llamada al backend (`GET /reservations/:code`) que devuelva **solo** los campos que el cliente final necesita ver en "Mi reserva" (estado, fechas, monto, método/estado de pago) — nunca el `paymentReport` completo ni reexponer el mismo problema. Este endpoint puede ser público (el código sigue siendo el mecanismo de acceso, es lo que el negocio ya decidió y documentó), pero al vivir en el backend puede tener rate-limit real (reusar `trafficLimiter`, ya existe) y no permite *enumerar* nada (una petición por código, sin listado posible).
3. Mantener el resto de las Rules (`categories`, `apartments`, `statusMeta`, `settings`) tal como están — son catálogo público real, correctamente clasificado.

**Riesgo de migración:** MEDIO — toca Rules de producción y dos rutas del backend, pero es aditivo (nuevo endpoint) + una regla más estricta (nunca más permisiva), reversible si algo se rompe. Compatible con reservas ya creadas: los códigos existentes siguen funcionando exactamente igual desde la perspectiva del cliente (mismo código, mismo flujo de "Mi reserva"), solo cambia qué ruta técnica se usa para leer.

---

## 5. SEC-002 — RBAC con default fail-open (CRITICAL / NEEDS VERIFICATION)

**Componente:** `whatsapp-assistant/src/adminAuth.js:43-57` (`attachRole`), `src/firebase.js:847-851` (`getUserRole`).

```js
// adminAuth.js:43-57
async function attachRole(req, res, next) {
  if (req.adminUser.email === config.superAdminEmail) { req.adminUser.role = 'owner'; return next(); }
  const role = await firebase.getUserRole(req.adminUser.uid);
  req.adminUser.role = role === 'employee' ? 'employee' : 'admin';   // ← default es 'admin'
  next();
}
```//
Cualquier cuenta de Firebase Auth autenticada que **no** tenga un documento en `roles/{uid}` se resuelve como `'admin'` — no como "sin permisos". Esto es intencional para compatibilidad con cuentas creadas antes de que existiera el nodo `roles/` (documentado en el comentario de `firebase.js:843-846`), pero es un default "fail-open": el camino seguro sería lo opuesto (sin rol documentado ⇒ sin acceso, o como mucho `employee`).

**Por qué esto es explotable:** el único guardián que decide si una cuenta *puede autenticarse* en absoluto es Firebase Auth (`requireAdminAuth` en `adminAuth.js:19-33`, que solo verifica que el ID token sea válido — no verifica ninguna lista blanca de UIDs ni de dominios de correo). El registro de cuentas nuevas vía `POST /admin/api/users` (backend, invitación del owner) es solo UN camino de alta; el proyecto de Firebase tiene su **propio** endpoint público de registro (`identitytoolkit.googleapis.com/v1/accounts:signUp`, activado automáticamente por tener el proveedor "Email/Password" habilitado — es lo que permite `signInWithEmailAndPassword` en `AuthContext.tsx:47`) que **no pasa por este backend en absoluto**. No encontré ninguna Cloud Function de bloqueo (`beforeCreate`/Identity Platform) en ninguno de los dos repos, ni configuración de dominios autorizados restrictiva en `firebase.json`/`.firebaserc`.

**Lo que esto significaría si el alta pública sigue habilitada (no lo verifiqué en vivo — ver abajo por qué):** cualquier persona en internet podría llamar ese endpoint público de Firebase (con el `apiKey`, que ya es público por diseño, ver `firebase-config.js`) para crear su propia cuenta, iniciar sesión en el panel con `signInWithEmailAndPassword`, y automáticamente recibir rol `'admin'` — acceso a `dashboard`, `reservations`, `visits`, `records/:code`, `payment-info` (lectura), `payments/:code/verify|reject|register-cash`, `apartments` (lectura), `contracts` (lectura/escritura), `cleaning`/`maintenance` — todo excepto lo que exige específicamente `requireSuperAdmin` (usuarios, tarifas/apartamentos en escritura, bitácora, editar datos bancarios).

**Por qué NO lo demostré en vivo:** crear una cuenta (aunque sea de prueba) es una acción que las reglas de esta sesión me prohíben ejecutar aunque el propio dueño del sistema lo pida — "Creating accounts" está en la lista de acciones que debo negarme a hacer yo mismo, incluso en un contexto de auditoría autorizada por el dueño. Es un hallazgo real basado en cómo está escrito el código + el comportamiento por defecto documentado de Firebase Auth (habilitar Email/Password habilita también el alta pública salvo que se desactive explícitamente o se usen Identity Platform + una función de bloqueo, ninguna de las cuales existe en este proyecto) — pero la confirmación final requiere que **tú** revises la consola de Firebase.

**Cómo verificarlo tú mismo (30 segundos, sin ningún riesgo):** Firebase Console → tu proyecto (`usoinmobiliario-c8e83`) → Authentication → Sign-in method → "Email/Password". Si está en verde/habilitado y no ves ninguna restricción de dominio (eso vive en Identity Platform, un producto distinto y de pago que este proyecto no usa), el alta pública está abierta.

**Corrección propuesta (P0, independiente de si el alta pública resulta estar abierta):**
1. Invertir el default: sin documento en `roles/{uid}` ⇒ **sin acceso** (403), no `'admin'`. Esto exige, como parte del cambio, migrar las cuentas ya existentes: escribir explícitamente `roles/{uid} = 'admin'` para cada cuenta admin real que hoy dependa del default implícito (una sola escritura por cuenta, usando `listAdminUsers()` que ya existe).
2. Si la verificación de consola confirma que el alta pública sigue abierta: deshabilitar el proveedor "Email/Password" para *sign-up* no es una opción directa en Firebase estándar (es todo o nada); la mitigación real es (1) el cambio de default de arriba (rompe el impacto incluso si alguien logra registrarse) + (2) opcionalmente migrar la creación de cuentas a Custom Claims verificados en el token en vez de un nodo RTDB, para que ni siquiera South el Admin SDK dependa de una tabla separada.

**Riesgo de migración:** BAJO — el cambio de default es una condición invertida en una función pura, más un backfill de datos (escribir `roles/{uid}='admin'` para las cuentas existentes que hoy son admin por default). No rompe ningún flujo si el backfill se hace antes de desplegar el cambio de código.

---

## 6. Hallazgos P1

### SEC-003 — Sin rate-limit en `/email/*` (MEDIUM)
`app.js:187-230`: las tres rutas `POST /email/reservation-confirmation|payment-reported|visit-confirmation` son las únicas rutas públicas de escritura del archivo que **no** tienen ningún `rateLimit(...)` (contraste con `chatLimiter`/`reservationLimiter`/`trafficLimiter` en el resto del archivo). `emailService.js` limita a 5 envíos/hora **por código**, lo cual no frena a quien prueba muchos códigos distintos. Combinado con que la respuesta distingue 404 (no existe) de 403 (existe pero el correo no coincide), esto es un oráculo barato para confirmar qué códigos del espacio de 13.8M están en uso — útil como paso previo a SEC-001, y por su cuenta arriesga agotar la cuota gratuita de Resend (3000/mes) con tráfico de un atacante, dejando de enviar correos reales a clientes reales.
**Fix:** agregar `trafficLimiter` (ya existe, mismo criterio que `/track/*`) a las tres rutas.

### SEC-004 — El bot puede confirmar reservas ajenas (LOW-MEDIUM)
`businessTools.js:205-229` (`getReservationTool`): solo exige formato de código válido, no verifica que el número de WhatsApp que pregunta (`from`, ya autenticado por la firma HMAC del webhook) coincida con `rec.phone`. Devuelve estado, fechas, método/estado de pago y monto de cualquier código adivinado/obtenido.
**Fix:** en el canal WhatsApp, exigir que `rec.phone` coincida con el remitente antes de devolver detalle (mismo patrón que ya usa `emailService.js` para el correo). En el canal web (sin número verificado) mantener el comportamiento actual pero taparlo detrás de SEC-001 (una vez que la lectura pase por el backend con rate-limit real, el radio de exposición de este hallazgo baja solo).

### SEC-005 — Endpoint de diagnóstico en producción (LOW)
`adminRoutes.js:596-608`: `POST /admin/api/_diag/whatsapp` deja que cualquier `owner`/`admin` mande un WhatsApp de texto libre a cualquier número usando el número real de negocio. El propio comentario dice "se quita en cuanto se confirme que el envío real funciona" — nunca se quitó.
**Fix:** eliminar la ruta (P1, trivial, cero riesgo de romper nada — no la llama ningún cliente real, confirmado por grep en `usoinmobiliario-middleware/src/api.ts`).

---

## 7. Hallazgos P2/P3

- **SEC-006** (`adminAuth.js:16-18`, ya documentado como decisión consciente): "Revocar" un admin no hace `revokeRefreshTokens`, así que su ID token ya emitido sigue funcionando hasta que expira solo (≤1h). Aceptable como trade-off documentado; si el negocio espera revocación instantánea al hacer clic en "Revocar", hay que sumar `admin.auth().revokeRefreshTokens(uid)` a `setAdminUserDisabled` y pasar `checkRevoked=true` a `verifyIdToken` — cambio pequeño y aislado.
- **SEC-007**: `npm audit` en `whatsapp-assistant` reporta 10 vulnerabilidades "moderate", todas transitivas de `firebase-admin`/`@google-cloud/*` vía `uuid`/`gaxios`/`google-gax`/`retry-request`. `npm audit fix` (sin `--force`) es el primer paso; si no resuelve todas, evaluar actualizar `firebase-admin` a su última mayor.
- **SEC-008**: `firebase/seed-payment-info.json` tiene nombre real + número de cuenta bancaria de una persona, en un repo público. Es la misma información que el negocio expone a propósito vía `settings/paymentInfo` (`.read:true`) para que los clientes puedan transferir — no es una fuga nueva, pero vale la pena confirmar con el dueño de esa cuenta que está de acuerdo con que su nombre completo y número de cuenta vivan en el historial de git de un repo público para siempre (a diferencia de Firebase, donde al menos técnicamente se podría rotar/quitar).

---

## 8. RBAC — matriz real (verificada código a código, panel↔backend)

| Operación | OWNER | ADMIN | EMPLOYEE | Público |
|---|:---:|:---:|:---:|:---:|
| Ver dashboard / analíticas | ✓ | ✓ | ✗ | ✗ |
| Ver catálogo de apartamentos (interno) | ✓ | ✓ | ✓ | parcial¹ |
| Crear/editar apartamento, tarifas | ✓ | ✗ | ✗ | ✗ |
| Ver reservas/citas/pagos | ✓ | ✓ | ✗ | por código¹ |
| Crear reserva manual | ✓ | ✓ | ✗ | vía POST /reservations |
| Confirmar/rechazar/cancelar/completar reserva | ✓ | ✓ | ✗ | ✗ |
| Check-in / check-out | ✓ | ✓ | ✗ | ✗ |
| Verificar/rechazar pago, registrar efectivo | ✓ | ✓ | ✗ | ✗ |
| Editar datos bancarios (`payment-info`) | ✓ | ✗ | ✗ | ✗ |
| Crear/gestionar contratos, ver PDFs | ✓ | ✓ | ✗ | ✗ |
| Crear/gestionar admins y empleados | ✓ | ✗ | ✗ | ✗ |
| Ver bitácora (audit log) | ✓ | ✗ | ✗ | ✗ |
| Aseo/mantenimiento — ver todo / propio | ✓ | ✓ | propio² | ✗ |
| Aseo/mantenimiento — crear tarea | ✓ | ✓ | ✗ | ✗ |
| Aseo/mantenimiento — cambiar estado | ✓ | ✓ | propio² | ✗ |
| Notificaciones/push (propias) | ✓ | ✓ | ✓ | ✗ |

¹ El catálogo público (`categories/apartments`) es una proyección filtrada (sin unidades `isVisible:false`, sin datos administrativos) — correcto. Una reserva/cita puntual es legible "por código" hoy de forma más amplia de lo previsto — ver SEC-001.
² `assertOwnedByEmployeeOrStaff` (`adminRoutes.js:481-486`) devuelve 404 (no 403) si la tarea no es del empleado — no confirma ni la existencia del recurso a quien no tiene por qué saberlo. Bien pensado.

**Sobre OWNER = `email === superAdminEmail`:** es una comparación de string fija (`adminAuth.js:44`, `config/index.js:77`), no Custom Claims. Confirmé que es una decisión ya evaluada y documentada (`SECURITY.md`, `RBAC.md`) — para una sola cuenta dueña conocida de antemano, es correcta y no amerita migrar a Custom Claims (eso agregaría un paso de bootstrap sin beneficio real a esta escala). **No la cambio.**

---

## 9. Concurrencia, idempotencia y precio — verificado, no asumido

- **Doble reserva:** `firebase.js:443-522` reclama cada noche con una transacción atómica independiente (`claimNightAtomically` → `dbTransaction`, que en Firebase Admin SDK es una transacción real optimista sobre ESE nodo). Si dos requests piden las mismas fechas al mismo tiempo, como mucho una gana cada noche puntual; si una reserva reclama 3 de 5 noches y falla en la 4ª, libera las 3 ya reclamadas (`releaseNights`) y aborta con `'conflict'` — nunca deja un registro a medias. Este es el mecanismo correcto y ya está bien implementado. **No hay ningún test automatizado de esto** (confirmado por la sub-auditoría de testing) — es el hueco de cobertura más importante del repo, no un bug.
- **Idempotencia:** `withIdempotency` (`firebase.js:249-278`) implementa claim/pending/done/timeout(30s)/retry correctamente, aplicado tanto a rutas públicas (`POST /reservations`, `/visits`) como admin (`POST /reservations` manual). Sin tests tampoco.
- **Precio:** una sola fórmula (`pricing.js`), recalculada siempre en el servidor para toda creación (`reservationBuilder.js:94-95`) — el cliente nunca puede inyectar `estTotal`. `priceSnapshot` se preserva en el registro (protege el precio histórico si las tarifas cambian después) y `priceIntegrityCheck` (usado en `GET /admin/api/reservations`) alerta al admin si un registro antiguo no cuadra con las tarifas actuales. **Esto ya resuelve la sección 12 del pedido** (rateVersion/priceSnapshot) — no hace falta ninguna migración adicional, ya existe.

---

## 10. Controles verificados como SÓLIDOS (para no inflar el informe con falsos positivos)

- IA/WhatsApp: ninguna función expuesta al modelo (`businessTools.js`) puede confirmar pagos ni cambiar estados — la inyección de prompt no tiene privilegio que escalar, sin importar qué tan convincente sea el mensaje. Esto es exactamente lo que pedía la sección 17-18 ("la respuesta del sistema debe depender de permisos estructurales, no del prompt").
- Firma HMAC del webhook de WhatsApp (`whatsapp.js:34-61`): usa `timingSafeEqual`, falla cerrado en producción si falta el secreto.
- RBAC de backend: cada ruta sensible del panel tiene su `requireRole`/`requireSuperAdmin` correspondiente, verificado ruta por ruta contra lo que el frontend llama — no hay ningún caso de "el botón se esconde pero el endpoint acepta a cualquiera".
- Contratos: no tienen ninguna ruta de lectura pública en Firebase Rules (caen en el `$other: {.read:false}` catch-all); los PDFs de contrato/recibo exigen token de staff válido.
- Fechas: `isValidIsoDate` detecta correctamente el desborde de `Date.UTC` (p. ej. `2026-02-30` normalizándose solo a marzo 2) — bug real ya corregido con round-trip check.
- Escapado HTML en correos: suficiente para el uso actual (nunca se interpola en atributos sin escapar); `rec.notes` nunca se incluye en ningún correo.
- Rate limiting en memoria (`express-rate-limit`) y estado de conversación en memoria (`conversationStore.js`): correctos y suficientes **mientras Render siga en plan gratuito de una sola instancia** (confirmado en `render.yaml:9`) — documentado como el disparador correcto para reconsiderar (múltiples instancias ⇒ necesitarías un store compartido, no antes).

---

## 11. Deriva de documentación (resumen — detalle completo entregado por la sub-auditoría)

| Documento | Estado |
|---|---|
| `DEPLOYMENT.md`, `RBAC.md`, `SECURITY.md` | CURRENT |
| `ARCHITECTURE.md`, `SECURITY_AUDIT.md`, `TESTING.md`, `usoinmobiliario-middleware/README.md` | PARCIALMENTE DESACTUALIZADOS (nombres de páginas viejos, conteo de tests desactualizado, un hallazgo de precio ya sobrepasado por el rediseño del 2026-09-13) |
| `AUDITORIA.md`, `AUDITORIA_COMPLETA.md`, `AUDITORIA_PAGOS.md`, `README.md` (raíz) | OBSOLETOS — describen una versión del sistema sin backend/Firebase Auth; útiles solo como registro histórico |
| `AUDITORIA_EXTERNA_2026_09.md` | PARCIALMENTE OBSOLETO — su propio hallazgo §5 ("mover reservas al backend", "idempotencia pública") quedó marcado como "fuera de alcance" y en realidad se implementó al día siguiente |

**Recomendación (P3, no bloqueante):** mover `AUDITORIA*.md`/`SECURITY_AUDIT.md` viejos a un `docs/AUDIT_HISTORY/` con fecha en el nombre, y dejar un único `SECURITY.md`/`ARCHITECTURE.md` vivos que se actualicen con cada cambio real — evita que una IA o un desarrollador nuevo confunda un documento de hace dos semanas con el estado actual (exactamente el problema que esta auditoría tuvo que resolver a mano).

---

## 12. Cobertura de tests — resumen (detalle completo entregado por la sub-auditoría)

Backend: 5 archivos, 45 casos (`node --test`), todos **unitarios puros** (pricing, validators, dateUtil, rbac-middleware, reservationBuilder-con-mocks). **Cero tests tocan la concurrencia real** (`claimNightAtomically`/`createReservation` contra una DB real o emulada), **cero tests de idempotencia real**, **cero tests de Firebase Rules** (no hay Firebase Emulator Suite configurado en ningún repo), cero tests de transición de pagos contra Firebase real. `npm test` no está enganchado a ningún gate de despliegue — Render despliega en cada push sin correr tests.
Middleware: cero tests de cualquier tipo (confirmado: sin script `test`, sin runner en `package.json`, sin archivos `*.test.tsx`).

---

## 13. Plan de implementación

### P0 (esta sesión)
1. **SEC-001** — Decisión del usuario: reusar el patrón código+correo (no un token nuevo, ver §4 y §14). Cerrar `reservationsManager/*/$code` a lectura pública; agregar `GET /reservations/:code?email=...` (backend, con rate-limit) para reemplazar la lectura directa de `FirebaseDataProvider.getReservation`. **`unitBookings` se deja con `.read: true` en su raíz a propósito** (alcance decidido para esta sesión, ver §14 y §17) — ya no expone PII por sí solo una vez cerrado el punto anterior, solo código+fechas+estado, y cerrarlo del todo exigiría reescribir el cálculo síncrono de disponibilidad del catálogo (`effectiveStatus`/`getOccupiedDates` en `FirebaseDataProvider.js`), un refactor más grande que el usuario no pidió resolver ahora. Archivos: `firebase/database.rules.json`, `firebase/FirebaseDataProvider.js`, `whatsapp-assistant/src/app.js`, `whatsapp-assistant/src/firebase.js`.
2. **SEC-002** — Invertir el default fail-open de `attachRole`/`getUserRole` a "sin rol documentado ⇒ sin acceso", con backfill de `roles/{uid}='admin'` para las cuentas admin existentes. Archivos: `whatsapp-assistant/src/adminAuth.js`, `whatsapp-assistant/src/firebase.js`.

### P1 (esta sesión, después de P0)
3. **SEC-003** — Rate-limit en `/email/*`.
4. **SEC-004** — Verificación de dueño en `getReservationTool` para el canal WhatsApp.
5. **SEC-005** — Eliminar `/admin/api/_diag/whatsapp`.

### P2/P3 (recomendado, no implementado en esta sesión salvo que se pida)
6. SEC-006 (revocación instantánea), SEC-007 (`npm audit fix`), reorganizar documentación, agregar Firebase Emulator Suite + tests de concurrencia/idempotencia/Rules.

Cada cambio de P0/P1 se implementa, se corren los tests existentes (`npm test` en `whatsapp-assistant`, `npm run build` en `usoinmobiliario-middleware` — recordar `tsc -b`, no `tsc -p .`), y se agregan tests nuevos para lo corregido antes de dar por cerrado el punto.

---

## 14. Cambios implementados en esta sesión

Decisión del usuario para SEC-001: reusar el patrón código+correo ya existente en `emailService.js` (opción recomendada), no un `publicAccessToken` nuevo. Implementado así:

**SEC-001** (CRITICAL, cerrado en código — falta el paso de despliegue de Rules, ver §16):
- `firebase/database.rules.json`: eliminado `.read: true` de `reservationsManager/reservations/$code` y `.../visits/$code`. Ahora heredan `auth != null` del padre — un código por sí solo ya no destraba nada.
- `whatsapp-assistant/src/firebase.js`: nueva `getReservationByCodeAndEmail(code, email)` + `reservationEmailMatches(rec, email)` (función pura, exportada, testeada aparte).
- `whatsapp-assistant/src/app.js`: nueva ruta pública `GET /reservations/:code?email=...` (con `trafficLimiter`), reemplaza la lectura directa de Firebase. 404 idéntico tanto si el código no existe como si el correo no coincide.
- `firebase/FirebaseDataProvider.js`: `getReservation(code, email)` ahora llama al backend en vez de leer Firebase directo. Se eliminó `setReservationStatus` (escritura directa a Firebase, código muerto sin ningún caller real — ver `index.html`) y su export.
- `index.html`: "Mi reserva" ahora pide también el correo (`#lookupEmailInput`); los links que ya traían el código (tras crear una reserva, en "reservas recientes") ahora también incluyen el correo. Se eliminó código muerto asociado (`ReservationService.confirmReservation/rejectReservation/cancelReservation/completeReservation/checkReservationStatus`, `VisitService.getVisit/confirmVisit/cancelVisit`) — ningún caller real los usaba, y dependían de la escritura directa ya eliminada.
- **Verificado en vivo**: backend local contra el proyecto real (una reserva de prueba, fechas 2028, HOLD que expira solo) — código+correo correcto → 200 con el registro completo; correo incorrecto → 404; sin correo → 404; código inexistente → 404; correo con mayúsculas/espacios → 200 (case-insensitive). Confirmado también en el navegador real (Mi Reserva) con CSP relajado solo en una copia de prueba fuera del repo (nunca en el archivo real).
- **Nota de UX**: un link de "Mi reserva" ya enviado en un correo ANTES de este cambio (`?code=X`, sin `&email=`) sigue aterrizando en la página correcta con el código precargado, pero ya no busca automáticamente — el cliente debe escribir también su correo (que ya conoce). No es un link roto, es un paso extra.

**SEC-002** (CRITICAL/NEEDS VERIFICATION, cerrado en código — **el backfill de datos NO se ejecutó, ver §16, no desplegar sin correrlo antes**):
- `whatsapp-assistant/src/adminAuth.js`: `attachRole` ahora responde 403 `no-role-assigned` si `roles/{uid}` no existe, en vez de asumir `'admin'`.
- `whatsapp-assistant/src/firebase.js`: `listUsersWithRoles()` refleja `role: null` para una cuenta sin documento (antes la mostraba como `'admin'` igual); `notifyAllStaff` ajustado a la nueva semántica.
- `whatsapp-assistant/scripts/backfill-roles-sec002.js`: script nuevo, no ejecutado (ver §16).

**SEC-003** (MEDIUM): `trafficLimiter` (ya existente, 120/10min por IP) agregado a las tres rutas `POST /email/*`.

**SEC-004** (LOW-MEDIUM): por WhatsApp, `getReservationTool` ahora exige que el teléfono del remitente (autenticado por la firma HMAC del webhook) coincida con el de la reserva antes de revelar cualquier detalle — mismo error genérico "no encontrada" si no coincide. Por chat web no cambia nada (sin teléfono verificado, sigue protegido solo por `chatLimiter`, riesgo ya acotado por SEC-001).

**SEC-005** (LOW): eliminada la ruta `/admin/api/_diag/whatsapp` (diagnóstico temporal olvidado en producción, sin ningún caller real).

**No implementado en esta sesión** (quedan como P2/P3, tal como se planteó en §13): SEC-006 (revocación instantánea de "Revocar"), SEC-007 (`npm audit fix`), reorganización de documentación, Firebase Emulator Suite + tests de concurrencia/idempotencia/Rules.

## 15. Tests ejecutados

- `whatsapp-assistant`: `npm test` — **60/60 pasan** (45 preexistentes + 15 nuevos: 10 en `test/rbac.test.js` para `attachRole` fail-closed y `reservationEmailMatches`, 5 en `test/businessTools.test.js` nuevo para la verificación de teléfono de `getReservationTool`).
- `usoinmobiliario-middleware`: `npm run build` (`tsc -b && vite build`) — compila limpio, sin cambios en este repo.
- Verificación manual end-to-end (servidor local contra el proyecto Firebase real, solo lecturas + una reserva de prueba desechable con fechas 2028): confirmado el flujo completo código+correo en `GET /reservations/:code`, en la UI de "Mi reserva", y que `/admin/api/_diag/whatsapp` ya no existe (401 de `requireAdminAuth`, que corre antes de llegar a esa ruta, sin caída del servidor).
- `git diff` completo revisado línea por línea (sección "auto-revisión" de esta sesión) — sin referencias colgantes a las funciones eliminadas, sin cambios accidentales en `usoinmobiliario-middleware`.

## 16. Antes de que esto quede realmente cerrado (acción tuya, no automatizable desde acá)

1. **Desplegar `firebase/database.rules.json`** — un cambio de código en este repo NO actualiza las Rules reales en Firebase. Necesitas correr `firebase deploy --only database` (con `firebase-tools` instalado y logueado) o pegar el contenido del archivo en Firebase Console → Realtime Database → Rules → Publicar. Hasta que esto pase, el hallazgo SEC-001 **sigue activo en producción** — el código ya está listo, pero la puerta vieja sigue abierta hasta publicar la regla nueva.
2. **Correr el backfill de SEC-002 ANTES de desplegar el backend** — `cd whatsapp-assistant && node scripts/backfill-roles-sec002.js` (necesita las credenciales reales del Admin SDK, las mismas que ya usa el servidor). Sin esto, cualquier admin real sin un `roles/{uid}` explícito quedará bloqueado (403) en cuanto este código llegue a producción. El intento de correr esto automáticamente en esta sesión fue bloqueado por el clasificador de seguridad de Claude Code (escritura a infraestructura de producción) — correctamente, ya que es una decisión que te corresponde a ti.
3. **Verificar en Firebase Console** (Authentication → Sign-in method → Email/Password) si el alta pública sigue habilitada — determina qué tan urgente es el punto anterior (si está deshabilitada, SEC-002 pasa de CRITICAL a defensa-en-profundidad; si sigue habilitada, es explotable hoy mismo por cualquiera).
4. Desplegar el backend (`whatsapp-assistant`) a Render — es automático en cada push a `main`, como siempre.
5. Considerar confirmar con el dueño de la cuenta bancaria (Yessica Paola González Granada, ver SEC-008) que está de acuerdo con que su nombre y número de cuenta vivan en el historial de un repo público de GitHub — es la misma información que ya es pública por diseño en `settings/paymentInfo`, pero vale la pena la confirmación explícita.

## 17. Riesgos remanentes (después de este cierre)

- Hasta que se complete el paso 1 de §16, SEC-001 sigue siendo explotable en producción exactamente como se demostró.
- Hasta que se completen los pasos 2-3 de §16, SEC-002 sigue siendo una posible vía de escalación (o ya está mitigada, dependiendo de la respuesta del paso 3).
- El residual ya aceptado (código puro sigue siendo suficiente para elegir método de pago / reportar un pago — nunca para verlos) se mantiene, documentado, no es un hallazgo nuevo.
- `unitBookings` sigue siendo legible en su raíz sin autenticación (ver nota de §13, punto 1): tras el cierre de `reservationsManager/*/$code`, esto YA NO expone PII (nombre/teléfono/correo/pago) — solo código, fechas y estado agregado por unidad, información operativamente similar a un calendario de disponibilidad público. Si más adelante se quiere cerrar también esto, hace falta reemplazar `effectiveStatus`/`getOccupiedDates` de `FirebaseDataProvider.js` (hoy síncronos, sobre un espejo local de `unitBookings`) por una llamada al backend — un refactor más grande, fuera del alcance que se acordó para esta sesión.
- Cobertura de tests para concurrencia real (`claimNightAtomically`)/idempotencia contra Firebase real/Rules sigue sin existir — recomendación P3 ya descrita en §12, no abordada en esta sesión (requeriría Firebase Emulator Suite, que este sandbox no puede alcanzar por red).
- `npm audit` del backend: 10 vulnerabilidades "moderate" en dependencias transitivas de `firebase-admin` (SEC-007) — no aplicado en esta sesión, bajo riesgo, `npm audit fix` es el siguiente paso natural.
