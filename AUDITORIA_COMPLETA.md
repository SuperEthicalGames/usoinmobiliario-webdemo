# AUDITORÍA COMPLETA DEL PROYECTO

**Uso Inmobiliario — todo el ecosistema**
Fecha: 2026-09-09

Alcance: sitio web (`index.html`), Firebase (Realtime Database + rules), correo transaccional (`email-worker/`), asistente de WhatsApp con IA (`whatsapp-assistant/`), configuración de despliegue (GitHub Pages, Firebase Hosting, Cloud Functions, Render), y una revisión de alcance acotado (no exhaustiva, ver §12) del panel administrativo en Unity, que vive en un repositorio aparte.

**Método**: todo lo afirmado aquí viene de leer el código real de esta sesión y/o de verificación en vivo (navegador contra la URL pública real, `git log`/`git status`, la API de GitHub, un endpoint de salud real en Render) — no de memoria de sesiones anteriores. Donde algo se apoya en notas de sesiones previas sin haber sido re-verificado ahora, se dice explícitamente. No se modificó ningún archivo de código para producir este documento.

---

## 0. Resumen ejecutivo

| # | Hallazgo | Severidad |
|---|---|---|
| 1 | El sitio en **producción** (GitHub Pages) no está conectado a Firebase — `firebase/firebase-config.js` da 404 en vivo porque nunca se subió al repo. Cada reserva/cita hecha ahí mismo solo vive en el navegador del visitante. | 🔴 Crítico |
| 2 | El webhook del asistente de WhatsApp (`POST /webhook/whatsapp`) no verifica la firma de Meta — cualquiera que encuentre la URL puede inyectarle mensajes falsos. | 🟠 Alto |
| 3 | El asistente de WhatsApp puede, bajo una condición de carrera real, permitir una doble reserva genuina — el Admin SDK que usa no pasa por las reglas de Firebase que protegen al sitio web del mismo problema. | 🟠 Alto |
| 4 | El repo de Unity tiene 42 scripts de trabajo real y un solo commit desde el 7 de septiembre — hay cambios sin commitear ahora mismo (ver §7). | 🟡 Medio |
| 5 | Nada de lo anterior compromete datos: no se encontró ningún secreto expuesto en ningún repo revisado, y el asistente de WhatsApp no tiene ninguna función capaz de confirmar un pago o aprobar una reserva — verificado leyendo el código, no solo la documentación del propio proyecto. | ✅ |

El proyecto creció de forma significativa desde las dos auditorías previas en el repo (`AUDITORIA.md` y `AUDITORIA_PAGOS.md`, ambas del 2026-09-04): además del sitio web y Firebase, ahora existen un asistente de WhatsApp con IA completo (`whatsapp-assistant/`), configuración de Firebase Hosting, y un despliegue real en Render. Esos dos documentos siguen siendo válidos para lo que cubren (arquitectura de `index.html` y del sistema de pagos) — no se repite aquí lo que ya está bien documentado ahí, salvo para señalar qué cambió.

---

## 1. Mapa del ecosistema

```
Visitante (navegador)                       Cliente (WhatsApp)
        │                                            │
        ▼                                            ▼
index.html (GitHub Pages, LIVE)          whatsapp-assistant (Render, LIVE)
  DataProvider: Local o Firebase           Gemini/OpenAI + function calling
        │                                            │
        └────────────────────┬───────────────────────┘
                              ▼
              Firebase Realtime Database (usoinmobiliario-c8e83)
              categories/ apartments/ statusMeta/ settings/
              reservationsManager/{reservations,visits}/
              unitBookings/ bookedNights/ bookedVisitSlots/
                              ▲
                              │  (Firebase Auth + Admin SDK — panel Carlos)
                   Unity Admin App (repo aparte, ver §7)

email-worker (Cloudflare Worker, código listo, sin desplegar/conectar aún)
        invocado por index.html → Amazon SES → correo real al cliente

Firebase Hosting + Cloud Functions (preparados, sin desplegar — ver §4)
```

Cinco piezas de código independientes comparten una sola fuente de verdad (la Realtime Database). Cada una la lee/escribe con un mecanismo distinto:

| Pieza | Cómo toca Firebase | Pasa por `database.rules.json` |
|---|---|---|
| `index.html` (navegador) | Firebase JS SDK, cliente anónimo | **Sí** — es la única barrera de seguridad que tiene |
| `whatsapp-assistant/` | Firebase **Admin SDK** (cuenta de servicio) | **No** — el Admin SDK tiene acceso total, las rules no aplican |
| Unity admin app | Firebase Auth (Email/Password, un solo admin) + SDK cliente | Sí, pero como usuario autenticado (`auth != null`) |

Esta tabla es la clave de varios hallazgos de este documento: todo lo que las `rules` garantizan automáticamente para el sitio web (atomicidad, validación de campos, anti-doble-reserva) el asistente de WhatsApp tiene que **volver a garantizar por su cuenta en código**, porque su acceso vía Admin SDK las ignora por completo. Donde ese código no replica exactamente la misma garantía, aparece una brecha real (§6.3).

---

## 2. Sitio web (`index.html`)

**No cambió desde el commit `581bb3c` (2026-09-05)** — confirmado por `git log --stat`, ningún commit posterior lo toca. La arquitectura completa (capa de servicios, HOLD de 15 minutos, anti-doble-reserva atómico, pago manual con `PaymentProvider`, correo transaccional) ya está documentada en detalle y verificada en `AUDITORIA.md` y `AUDITORIA_PAGOS.md`; se confirmó por grep que las piezas centrales siguen exactamente donde esos documentos dicen (`ApartmentService`, `PricingService`, `AvailabilityService`, `ReservationService`, `VisitService`, `PaymentProvider`, `EmailProvider`/`EmailService` — `index.html:1428-1919`) y sin marcadores `TODO`/`FIXME` pendientes en el archivo.

### 2.1 Hallazgo crítico — el sitio en producción no habla con Firebase

Verificado en vivo, no en el código: se cargó **la URL real de producción** (`https://superethicalgames.github.io/usoinmobiliariodemo/`) en un navegador.

- La consola muestra: `GET .../firebase/firebase-config.js → 404`.
- `window.FirebaseDataProvider` es `undefined` — el módulo `FirebaseDataProvider.js` nunca termina de ejecutarse (su primera línea es `import { firebaseConfig } from "./firebase-config.js"`, y ese import falla).
- `window.LocalDataProvider` sí existe y es el único proveedor activo.

**Causa**: `firebase/firebase-config.js` está en `.gitignore` (línea 2) — correcto para no subir credenciales al repo, pero GitHub Pages sirve exactamente lo que hay en el repo, así que el archivo simplemente no existe en producción. Nunca se creó una versión pública/de ejemplo que sí se suba.

**Consecuencia real**: cualquier visitante de la URL que el negocio muestra hoy solo interactúa con `localStorage` de su propio navegador — el catálogo, la disponibilidad, y cualquier reserva o cita que haga **no llegan a Firebase**, no son visibles para el negocio, y no las vería ni el asistente de WhatsApp ni un futuro panel de Unity. Esto contradice todo el trabajo de conexión a Firebase documentado en sesiones anteriores: ese trabajo es real y correcto en el código, pero **no está activo en la URL pública real**.

**Arreglo**: Firebase, por su propio diseño, no trata la config web (`apiKey`, `authDomain`, etc.) como secreta — la protección real vive en `database.rules.json`, no en ocultar esos valores (esto ya se había concluido en sesiones anteriores). La forma más simple de arreglarlo es quitar `firebase/firebase-config.js` de `.gitignore` y commitear la versión real (u otro mecanismo que sirva ese archivo en producción) — no requiere ningún cambio de arquitectura.

### 2.2 Otras verificaciones en vivo sobre `index.html`

- **GitHub Pages sí está activado y sirviendo** (`gh api repos/.../pages` → `"status":"built"`). Esto contradice una nota de una sesión anterior que lo daba como pendiente — ya no lo está.
- `EMAIL_WORKER_CONFIG` (`index.html:1661`) sigue con `url`/`appSecret` vacíos — el envío de correo transaccional sigue sin estar conectado a un Worker real (falla de forma controlada, como está diseñado — no rompe la reserva).
- `firebase/database.rules.json` (160 líneas, leído completo) coincide exactamente con lo que el código de `index.html`/`FirebaseDataProvider.js` necesita: validadores para `priceSnapshot`, `paymentMethod`, `email` obligatorio en reservas, y la condición de reclamo atómico de HOLD vencido en `bookedNights`. **No se puede verificar desde aquí si esta es la versión realmente publicada en la consola de Firebase** — este proyecto no tiene CLI de Firebase configurado, y sesiones anteriores documentan que ese publish manual se ha quedado atrás varias veces. Recomendado: confirmarlo directamente en la consola antes de asumir que coincide.

---

## 3. Firebase — Hosting y Cloud Functions (piezas nuevas, sin desplegar)

`firebase.json` y `.firebaserc` (commit `07a61b6`, 2026-09-07) preparan dos cosas que **hoy no están activas**:

- **Firebase Hosting**: verificado en vivo — `https://usoinmobiliario-c8e83.web.app` responde **"Site Not Found"**. La configuración (`firebase.json:1-32`) está lista (excluye correctamente `firebase-config.js`, `seed-*.json`, `database.rules.json` y los propios documentos de auditoría de lo que se publicaría), pero nadie ha corrido `firebase deploy` — coherente con la ausencia de CLI de Firebase en este entorno, documentada en sesiones anteriores.
- **Cloud Functions**: `whatsapp-assistant/index.js` exporta `exports.api = onRequest(...)` (línea 25), y `firebase.json:29-30` redirige `/webhook/**` y `/health` exactamente a esa función (`"function": "api"`) — **la conexión entre ambos archivos está bien hecha**, no es un cabo suelto. Lo que la bloquea es externo al código: según el mensaje del commit `a41e819`, **Firebase Cloud Functions requiere el plan Blaze (pago por uso) incluso solo para habilitar las APIs necesarias**, confirmado con un intento real de despliegue. Por eso el proyecto pivotó a Render como ruta de despliegue activa (ver §6.2) y dejó esta ruta de Cloud Functions lista pero en pausa para cuando se decida activar Blaze.

**En resumen**: ninguna de las dos rutas de Firebase (Hosting, Functions) está desplegada hoy. La única pieza del ecosistema realmente corriendo en un servidor ahora mismo es el bot de WhatsApp en Render (§6.2).

---

## 4. Correo transaccional (`email-worker/`)

Revisado directamente (`email-worker/src/index.js`, 111 líneas) — arquitectura sólida y ya descrita en sesiones anteriores (Cloudflare Worker + Amazon SES vía `aws4fetch`, dominio `usoinmobiliario.com` ya verificado en SES). Confirmaciones y notas de esta pasada:

- No hay secretos hardcodeados — credenciales de AWS solo vía `env` (secrets de Cloudflare).
- Manejo de errores distinto para cada fallo (`bad-json`, `invalid-email`, `ses-request-failed`, `ses-send-failed`) — no expone detalles internos al llamador.
- **Nota informativa, ya reconocida en el propio código como una decisión consciente**: la única protección contra abuso es un `Origin` header (falsificable por un cliente que no sea un navegador) más un `APP_SHARED_SECRET` opcional (`index.js:41-55`) — si ese secreto llegara a quedar sin configurar en producción, el Worker actuaría como un relay abierto de correo HTML arbitrario desde el dominio verificado, limitado únicamente por las cuotas de AWS/Cloudflare. El propio comentario del archivo ya lo dice explícitamente como aceptado, no oculto — se repite aquí para que quede en el documento de auditoría, no solo en un comentario de código.
- **No se puede verificar si el Worker ya está desplegado en Cloudflare** (no hay una URL conocida para probarlo). Es irrelevante en la práctica: como se confirmó en §2.2, `EMAIL_WORKER_CONFIG` en `index.html` sigue vacío, así que el sitio no lo llamaría de todas formas.

---

## 5. Asistente de WhatsApp con IA (`whatsapp-assistant/`) — subsistema nuevo

Construido en dos commits (`07a61b6`, `a41e819`; 2026-09-07 y 2026-09-08). No estaba documentado en ninguna auditoría previa. Esta sección viene de una lectura completa de los ~2,500 líneas de código del subsistema (`src/*.js`, `config/index.js`, `index.js`, `package.json`) más verificación en vivo de su despliegue.

### 5.1 Qué es

Bot conversacional de WhatsApp Business (Gemini u OpenAI, intercambiables por `LLM_PROVIDER`) que atiende con lenguaje natural — no comandos — usando *function calling* sobre un set cerrado de operaciones de negocio (`src/businessTools.js`, 10 funciones exportadas). Comparte la misma Realtime Database que el sitio web, pero accede vía Firebase **Admin SDK** con una cuenta de servicio (no el SDK cliente que usa `index.html`) — ver la tabla de §1 sobre por qué esto importa.

```
WhatsApp Cloud API → webhook (src/app.js)
                          ↓
                 src/assistantCore.js (loop de function calling)
                          ↓
                 src/businessTools.js (valida, arma el dato)
                          ↓
                 src/firebase.js (Admin SDK — único lugar que toca Firebase)
```

### 5.2 Estado de despliegue (verificado en vivo)

- **El servicio SÍ está desplegado en Render y respondiendo**: `GET https://usoinmobiliario-whatsapp-bot.onrender.com/health` → `200 {"ok":true}` (tras el cold-start típico del plan gratuito, confirmado en vivo). Esto es más avanzado de lo que sugiere la documentación del propio subsistema (`README.md`/`TEST_PLAN.md` dicen "nunca ejecutado, sin Node.js en este entorno") — esa documentación quedó desactualizada apenas se desplegó.
- El proceso arranca sin crashear, lo que confirma que `config/index.js` no está lanzando su validación fail-fast por variables faltantes — pero **no se puede confirmar desde aquí que los secretos reales configurados en el dashboard de Render sean válidos** (token de WhatsApp, API key de Gemini/OpenAI, credencial de servicio de Firebase) sin un mensaje real de extremo a extremo, que está fuera del alcance de esta auditoría de solo lectura.
- El archivo `.env` local (gitignorado, no se leyó su contenido) tiene valores no vacíos para `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `GEMINI_API_KEY` y `OPENAI_API_KEY` — hay credenciales reales configuradas localmente, más allá de lo que la documentación del subsistema deja ver.
- **`WHATSAPP_PHONE_NUMBER_ID` sigue en blanco en `.env.usoinmobiliario-c8e83`** (el archivo committeado, no sensible) con un comentario `TODO` explícito: *"reemplazar por el phone_number_id del número de WhatsApp Business REAL de producción... antes del primer deploy a producción"*. El número público real del negocio es 3003848517 (usado en todos los enlaces `wa.me` de `index.html`) — todavía no está confirmado que el bot esté conectado a ese número real y no a un número de pruebas de Meta.

### 5.3 Seguridad — hallazgos

| Severidad | Hallazgo |
|---|---|
| 🟠 Alto | **`POST /webhook/whatsapp` no verifica la firma de Meta.** Se buscó en todo el proyecto cualquier verificación tipo `X-Hub-Signature-256`/HMAC — no existe ninguna, ni el campo de configuración necesario (`APP_SECRET` de Meta) aparece en `.env.example`/`config/index.js`. `WHATSAPP_VERIFY_TOKEN` solo protege el handshake `GET` inicial, no cada mensaje entrante. **Consecuencia real**: cualquiera que descubra la URL del webhook puede enviarle un payload fabricado (remitente y texto arbitrarios) y el sistema lo procesa como un cliente real — puede agotar la cuota de Gemini/OpenAI, generar HOLDs falsos (evadiendo el filtro de placeholders, ver §5.6, con datos simplemente plausibles), o hacer que el bot envíe mensajes salientes a un número de terceros elegido por el atacante usando el WhatsApp real del negocio. |
| 🟠 Alto | **`reclaimExpiredHold` (`firebase.js:160-170`) puede causar una doble reserva real bajo carrera.** Es casi el mismo código que su equivalente en `FirebaseDataProvider.js:136-143`, pero ahí es seguro porque la escritura pasa por `database.rules.json`, que revalida atómicamente en el servidor que el HOLD siga vencido en el momento exacto del commit. El Admin SDK no pasa por esa regla — así que si una solicitud A lee un HOLD vencido, una solicitud B reclama legítimamente esa misma noche mientras tanto, y luego el `update()` de A se aplica igual, A puede sobreescribir `bookedNights` y borrar la reclamación de B — dos reservas terminan reclamando la misma fecha. Ninguna prueba de `TEST_PLAN.md` cruza estos dos escenarios (concurrencia + vencimiento) a la vez, así que no se habría detectado con el plan de pruebas documentado. |
| 🟡 Medio | **La reclamación de noches al crear una reserva no es atómica ante una caída real del proceso** (`firebase.js:251-293`): usa transacciones seguras noche por noche más un `update()` final separado para el registro. Si Node se cae entre medio (no una excepción capturable — un crash real), quedan noches en `bookedNights` sin ningún registro en `unitBookings` que las respalde — y como `isHoldExpired` exige un registro de `unitBookings` para poder reclamar, esas noches quedan bloqueadas **para siempre**, sin forma automática de liberarlas. El sitio web no tiene este problema porque escribe todo en un solo `update()` multi-ruta atómico. |
| 🟡 Medio | `reportPayment` no revalida que la reserva siga siendo dueña de sus noches antes de aceptar un reporte de pago tardío — pero esta misma brecha ya existe en `FirebaseDataProvider.js:347-358` (sitio web), no es nueva de este subsistema. |
| 🟢 Bajo | No hay chequeo de colisión de código antes de escribir una reserva/cita nueva — el sitio web lo obtiene gratis de la regla `!data.exists()`; el Admin SDK la ignora. Con ~13.8 millones de combinaciones posibles (24 letras × 1000, sin I/O) el riesgo real es mínimo, pero estructuralmente no está protegido. |
| ✅ Verificado, no solo documentado | **No existe ninguna función capaz de mover `status` más allá de `'pendiente'` ni `paymentStatus` más allá de `'submitted'`** entre las 10 funciones exportadas de `businessTools.js` — se leyó el archivo completo para confirmarlo, coincidiendo con lo que `TEST_PLAN.md` afirma. La inyección de prompt (el system prompt de `assistantCore.js` es defensa solo por instrucciones, sin filtro de código) por lo tanto tiene un radio de daño limitado a respuestas fuera de tono o gasto de cuota — no puede tocar datos sensibles ni aprobar nada. |

### 5.4 Corrección — desviaciones frente a la fórmula ya validada en el sitio web

Se comparó línea por línea contra `index.html`/`FirebaseDataProvider.js` (las referencias ya probadas en vivo):

- **Fórmula de precio, formato de código, y criterio de HOLD vencido: idénticos**, carácter por carácter (tramos por noches, `rate = guests>=2 ? two[tier] : one[tier]`, alfabeto `ABCDEFGHJKLMNPQRSTUVWXYZ`, `expiresAt` como epoch-ms, `paymentStatus!=='submitted'` protegiendo un pago reportado).
- **Correo obligatorio en citas — desviación no documentada**: `validators.js` y el schema de `createVisit` exigen correo también para citas, pero `database.rules.json` (la referencia real) lo deja opcional para citas, solo obligatorio en reservas. El bot es más estricto que el propio modelo de datos, sin que quede señalado como una decisión de negocio explícita.
- `pricing.js` agrega una validación de longitud de array (`rates.extra.length > tierIdx`) que `index.html` no tiene — en la práctica más segura (evita un `NaN` si a una unidad le faltan tramos de tarifa), pero es un comportamiento distinto no documentado como intencional.
- **`effectiveStatus()` (`firebase.js:206-220`) está escrito pero nunca se llama** — el bot siempre devuelve el estado manual crudo de un apartamento, nunca el estado calculado contra reservas confirmadas que sí ve el catálogo web. No es un riesgo de seguridad (la disponibilidad real la sigue validando `checkAvailability`), pero el bot le podría decir a un cliente que un apartamento está "disponible" cuando el catálogo ya lo muestra como "en uso".
- El arreglo mencionado en el commit más reciente — que la IA no asuma una estadía de 1 noche cuando el cliente solo da fecha de entrada — es real y está bien dirigido (`assistantCore.js:209`, instrucción explícita con el caso de falla real documentado en el propio comentario). Por su naturaleza **solo puede vivir en el prompt**, no en código — `businessTools.js` solo recibe los argumentos ya estructurados que decide el modelo, nunca el texto crudo de la conversación.

### 5.5 Robustez

- 🟡 **`conversationStore.js`: el `Map` de locks nunca se limpia** (línea 11) — a diferencia de las conversaciones, que sí expiran. Cada número de teléfono distinto que alguna vez escriba dejará una entrada mínima pero permanente mientras el proceso viva. Bajo impacto hoy (una referencia pequeña por número), pero es una fuga real y sin cota.
- ✅ Verificado correcto: la serialización por número de teléfono (`runSerialized`) sí evita que mensajes rápidos del mismo cliente compitan por el mismo contexto de conversación.
- ✅ Verificado correcto: todas las llamadas de red tienen timeout explícito (15-30s) con reintento exponencial en Gemini/OpenAI — ningún `fetch` puede quedarse colgado indefinidamente.
- ✅ Verificado correcto: `config/index.js` falla rápido y con mensaje claro si falta una variable de entorno requerida; el entrypoint de Cloud Functions difiere esa validación a la primera petición real a propósito, para no romper la fase de "discovery" de secretos de Firebase.
- 🟢 Sin reintento si falla el envío saliente a WhatsApp — ya reconocido como aceptable en el propio `README.md`, no es un hallazgo nuevo.

### 5.6 Sistema anti-datos-inventados (`validators.js`) — verificado empíricamente

Construido tras detectar en pruebas reales que la IA rellenaba campos obligatorios con datos plausibles pero falsos ("Cliente", "0000000000", "pendiente@correo.com") en vez de preguntar. Confirmado con doble capa — instrucción explícita en el prompt (`assistantCore.js`, regla 3) **y** bloqueo en código (`isPlaceholderText`/`isPlaceholderPhone`, consumidos por `createReservationHold`, `createVisit` y `reportPaymentTool` en `businessTools.js` antes de tocar Firebase) — y probado en vivo contra el módulo real (no solo leído): rechaza correctamente "Cliente", "0000000000", "cliente@correo.com", "Referencia", "Banco".

Dos huecos menores encontrados en la misma prueba: `isValidPhone` no detecta una secuencia falsa tipo `1234567890` (solo detecta dígitos repetidos), y la lista de dominios/usuarios placeholder de `isValidEmail` es de coincidencia exacta — una variante como `test123@gmail.com` pasa el filtro. Bajo impacto (son defensas adicionales sobre un flujo que de todos modos requiere revisión humana antes de confirmar cualquier pago), pero quedan señalados.

### 5.7 Notas de arquitectura ya buenas (confirmadas, no solo documentadas)

- Ningún secreto hardcodeado en `src/`/`config/` — todo viene de `process.env`. `.env.usoinmobiliario-c8e83` (el único archivo de entorno que sí está en git, por convención propia de Firebase) se releyó completo y no contiene ningún secreto real.
- Gemini y OpenAI implementan exactamente el mismo contrato (`handleIncomingMessage(phone, texto) → string`), mismas tools, mismo prompt, mismo límite de 6 turnos de function-calling — sin deriva entre proveedores.
- La razón dada para evitar Cloudflare Workers (`firebase-admin` necesita APIs de Node) es consistente con lo que realmente importa el código.
- El split `index.js` (Cloud Functions) / `src/app.js` (Express puro) / `src/server.js` (arranque local) es coherente — sin lógica duplicada entre las tres entradas.
- `README.md` quedó desactualizado tras el último refactor (todavía describe `server.js`/`aiAgent.js` con responsabilidades que ahora están en `app.js`/`assistantCore.js` y en los providers) — cosmético, no afecta el comportamiento.

---

## 6. Panel administrativo Unity (repositorio aparte)

**Ubicación**: `D:\Portfolio\Super Ethical Games\Usoinmobiliario` — repo Git independiente, confirmado accesible desde esta máquina. Esta sección es deliberadamente de **alcance acotado** (ver §12): no se releyó el código C# a fondo esta sesión (ya está descrito en gran detalle en la memoria de sesiones anteriores, hasta un punto de pausa donde el usuario tomó control manual del diseño de UI). Lo que sigue es verificación fresca de estado de repositorio, no una re-auditoría del código.

- **Git**: un solo commit en toda la historia (`788dcf5`, "Initial commit: Unity admin panel", 2026-09-07), a pesar de que la memoria de sesiones anteriores documenta módulos 1 a 11 completos, un rediseño con prefabs/TextMeshPro, y un refactor SOLID posteriores a ese commit.
- 🟡 **El working tree tiene cambios reales sin commitear ahora mismo**: `Assets/Scenes/SampleScene.unity` modificado; `EmailLoginUI.cs`, y `CanvasGroupAlphaService.cs`/`CanvasGroupFader.cs`/`LoginMenuController.cs`/`NavBarController.cs`/`ScreenManager.cs` **borrados** de `Assets/Scripts/UI/`; una nueva carpeta `Assets/Scripts/ManualUI/` con `AuthenticationController.cs` (nuevo, no documentado en memoria) y versiones nuevas de `CanvasGroupAlphaService.cs`/`CanvasGroupFader.cs` sin trackear todavía. Esto es consistente con la reorganización manual de UI que el usuario emprendió (documentada en memoria), pero significa que **hay trabajo real en curso que no está respaldado por ningún commit** — un `git checkout`/`clean` accidental, o simplemente el disco fallando, lo perdería todo.
- **Higiene de secretos: limpia.** `google-services.json` y `google-services-desktop.json` están correctamente en `.gitignore`; solo sus archivos `.meta` (metadatos de Unity, sin credenciales) están trackeados. No se encontró ningún archivo de credenciales real trackeado.
- 42 scripts C# en `Assets/Scripts/` — volumen real, consistente con la arquitectura en capas (Models/Data/Services/UI) que la memoria describe.

**Recomendación**: hacer un commit real del estado actual cuanto antes (aunque sea intermedio/no perfecto) para eliminar el riesgo de pérdida, y considerar una auditoría dedicada de este repositorio — su tamaño y el hecho de que es un proyecto Unity completo lo justifican como una sesión propia en vez de una sección de esta.

---

## 7. Higiene de secretos — resumen transversal

| Repositorio | Archivo sensible | ¿Gitignorado? | ¿Trackeado por git? |
|---|---|---|---|
| `UsoInmobiliario` (web) | `firebase/firebase-config.js` | Sí | No |
| `UsoInmobiliario` (web) | `whatsapp-assistant/.env` | Sí | No |
| `UsoInmobiliario` (web) | `whatsapp-assistant/.env.usoinmobiliario-c8e83` | No (a propósito — sin secretos, confirmado releyéndolo) | Sí, intencional |
| `UsoInmobiliario` (web) | `email-worker/` (secretos AWS) | N/A — nunca en archivo, solo `wrangler secret put` | No aplica |
| `Usoinmobiliario` (Unity) | `Assets/google-services.json` | Sí | No (solo el `.meta`) |

No se encontró ningún secreto real expuesto en ningún repositorio revisado. `git status`/`git status --ignored` se corrieron en ambos repos para confirmar esto directamente, no solo leyendo el `.gitignore`.

---

## 8. Qué está realmente activo hoy vs. lo que sugiere el código/la documentación

| Componente | Lo que el código/docs sugieren | Lo verificado en vivo hoy |
|---|---|---|
| Sitio web | Conectado a Firebase (Fase 3-4, HOLD, pagos, todo documentado como "verificado en vivo" en sesiones previas) | **Desconectado en producción** — corriendo solo con `LocalDataProvider` (§2.1) |
| GitHub Pages | Memoria: "pendiente de activar" | **Activo y sirviendo** (`status: built`) |
| Firebase Hosting | Configurado (`firebase.json`) | **No desplegado** ("Site Not Found") |
| Cloud Functions | Preparado para el bot de WhatsApp | **No desplegable aún** (requiere plan Blaze) — no es la ruta activa |
| Bot de WhatsApp | README/TEST_PLAN: "nunca ejecutado en vivo" | **Desplegado y corriendo en Render**, `/health` responde `200` |
| Email transaccional | Pipeline completo construido | Config del lado del cliente sigue vacía — inactivo end-to-end |
| Número real de WhatsApp del bot | — | `WHATSAPP_PHONE_NUMBER_ID` sigue con un `TODO` sin llenar en el archivo committeado |

---

## 9. Recomendaciones priorizadas

**P0 — bloquea que lo ya construido funcione de verdad:**
1. Arreglar `firebase/firebase-config.js` en producción (§2.1) — sin esto, meses de trabajo de integración con Firebase no están activos en la URL real.
2. Confirmar en la consola de Firebase que `database.rules.json` publicado coincide con la versión del repo.

**P1 — seguridad real, explotable hoy si el bot está recibiendo tráfico real:**
3. Agregar verificación de firma (`X-Hub-Signature-256`) al webhook de WhatsApp (§5.3).
4. Corregir la condición de carrera de `reclaimExpiredHold` en `whatsapp-assistant/src/firebase.js` — idealmente reusando la misma garantía atómica que ya protege al sitio web, no solo parcheando el síntoma (§5.3).
5. Commitear el estado actual del repo de Unity (§6) para eliminar el riesgo de pérdida de trabajo.

**P2 — corrección y robustez, no urgentes:**
6. Decidir si el correo es realmente obligatorio para citas (alinear `whatsapp-assistant` con `database.rules.json`) o documentar la diferencia como intencional.
7. Cablear `effectiveStatus()` en `whatsapp-assistant/src/firebase.js` (está escrito, solo falta llamarlo).
8. Limpiar el `Map` de locks en `conversationStore.js`.
9. Confirmar el número real de WhatsApp de producción antes de anunciar el bot al público.

**P3 — cuando haya tiempo:**
10. Actualizar `whatsapp-assistant/README.md` para reflejar el split `app.js`/`server.js`/`index.js` actual.
11. Considerar una auditoría dedicada y completa del repo de Unity.

---

## 10. Alcance no cubierto por esta auditoría

- Revisión completa del código C# de Unity (42 scripts) — se hizo solo una verificación de estado de repositorio (§6), no una lectura línea por línea.
- Prueba real de extremo a extremo del bot de WhatsApp (mandarle un mensaje real) — habría generado datos de prueba reales y mensajes salientes reales; fuera del alcance de una auditoría de solo lectura sin autorización explícita para eso.
- Valores reales de las variables de entorno configuradas en el dashboard de Render (no accesible desde aquí).
- Estado real y actual de las rules publicadas en la consola de Firebase (solo se pudo comparar el archivo del repo contra lo que el código necesita, no contra lo que está realmente publicado).
- Estado de despliegue del Worker de Cloudflare (`email-worker/`) — no hay una URL conocida para probarlo directamente.
