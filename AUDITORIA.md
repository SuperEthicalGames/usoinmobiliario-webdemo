# AUDITORÍA DEL SISTEMA ACTUAL
**Uso Inmobiliario — index.html**
Fecha: 2026-09-04

---

## 1. Resumen

El sistema actual es un **sitio estático de una sola página** (`index.html`, 2289 líneas, ~2.7 MB por fotografías embebidas en base64), sin build step, sin framework, sin backend, sin base de datos y sin autenticación. Todo — catálogo, reservas, citas, cálculo de precio, "Mi reserva", contenido legal, bilingüismo — vive en JavaScript vanilla dentro de un único `<script>`.

Funciona bien y de forma coherente para lo que es: una **demo/fase 1 con datos reales** del negocio (17 unidades reales, tarifas reales, textos legales reales, dirección y NIT reales), con una experiencia de reserva y agendamiento de visitas ya construida end-to-end pero **enteramente del lado del cliente** — el único canal de confirmación real hoy es WhatsApp (enlace `wa.me`, sin API oficial), y el único almacenamiento es `localStorage` del navegador del visitante.

No hay nada que reescribir por estar mal hecho. El código está ordenado en módulos funcionales razonables (`PANO`, `BOOKING`, funciones `render*`), usa datos reales de forma consistente, y ya separa (aunque sin querer) el estado operativo del apartamento de las reservas, que es justo la trampa que este proyecto quiere evitar. El trabajo que sigue es de **extracción y conexión**, no de reconstrucción.

---

## 2. Arquitectura actual

- **Un solo archivo HTML** con CSS embebido en `<style>` y JS embebido en un único `<script>` que ejecuta un IIFE `(function(){ ... })()`.
- **Sin bundler, sin transpilador, sin dependencias npm.** Se sirve como archivo estático puro (probado con `python -m http.server` vía `.claude/launch.json`).
- **Router propio basado en hash** (`function route()`, línea 2183): parsea `location.hash` manualmente (`#/unidad/estudio?u=09`, `#/mi-reserva?code=AAA000`, etc.), sin librería de enrutamiento.
- **Renderizado por strings de HTML**: funciones (`renderHome`, `renderUnit`, `renderTarifas`, `renderLegalHub`, `renderLegalDoc`, `renderMiReserva`) devuelven HTML como string, que `route()` inyecta con `innerHTML` en `<main id="app">`.
- **Dos subsistemas aislados como IIFE propios**, cada uno con su `var state` interno y una API pública mínima:
  - `PANO` (línea 1010) — visor 360° con three.js.
  - `BOOKING` (línea 1102) — modal de reservas y citas (`open/close/render/load/find`).
- **Un `<div id="modalRoot">` fuera de `<main id="app">`** para que el modal de reserva sobreviva a los re-renders de la navegación por hash.
- **Bilingüismo** vía objeto `STR` (194 claves `{es, en}`) y función `t(key)`.
- **Theming claro/oscuro** vía CSS custom properties en `:root`, con soporte para `prefers-color-scheme` y override manual `data-theme`.
- **Dependencias externas** (todas por CDN, ninguna requiere backend propio):
  - Google Fonts (Fraunces, Karla)
  - three.js r134 (cdnjs) — visor 360°
  - flag-icons 7.2.3 (jsdelivr) — banderas reales del selector de teléfono
  - Google Maps Embed (iframe `output=embed`, sin API key) — mapa de ubicación

No existe backend, base de datos, autenticación, ni build tool de ningún tipo hoy.

---

## 3. Funcionalidades encontradas

- Catálogo bilingüe con pestañas por tipo de unidad (1 Ambiente / 2 Ambientes) y leyenda de disponibilidad contada.
- 17 unidades reales con estado operativo (`disponible` / `en-uso` / `reservado`).
- Página de detalle por unidad: especificaciones, tabla de tarifas real, descripción real tomada del sitio original, recorrido 360°.
- Recorrido 360° (three.js) con carrusel de miniaturas rediseñado (flechas prev/next, puntos indicadores, animación de deslizamiento, límites reales no cíclicos).
- **Sistema de reservas (`BOOKING`)** con dos modos independientes:
  - `reserva` (estadía, calendario de rango, huéspedes, cálculo de precio)
  - `cita` (visita presencial, calendario de un solo día, horario real de atención)
  - Flujo idéntico de 4 pasos para ambos: fechas → datos de contacto → revisión → confirmación con código.
- Calendario propio construido a mano (mes/año navegable, días deshabilitados, rango vs. fecha única).
- Selector de indicativo telefónico internacional (216 países, Colombia por defecto, banderas reales vía `flag-icons`, no emoji).
- Botón "Continuar" con validación en vivo — deshabilitado hasta completar nombre, teléfono y aceptar política/reglamento.
- Generación de código único formato `AAA000` (3 letras + 3 dígitos), verificado contra duplicados existentes.
- Página **"Mi reserva"**: búsqueda por código + lista de reservas/citas recientes de ese navegador.
- Envío de resumen por WhatsApp (`wa.me` con mensaje prellenado) como mecanismo real de aviso al negocio.
- Página de tarifas de renta corta.
- Hub legal + 6 documentos legales con texto real (política de datos, contrato de alojamiento, reglamento, código de conducta, oferta de referidos, recomendaciones de lavadoras).
- Mapa real embebido de Google Maps con la dirección real del negocio.
- Hero animado: ilustración SVG original (no foto) de una calle de Laureles-Estadio, inspirada en fotos reales de Google Street View del edificio.
- Pie de página con datos reales del negocio (NIT, dirección, horario, correos, WhatsApp).
- Selector de idioma ES/EN persistente durante la sesión de navegación (no persiste entre recargas).
- Diseño responsive verificado en desktop/tablet/mobile, con corrección reciente de un bug de CSS Grid (`min-width:0`) que causaba desbordamiento horizontal en la sección de recorrido 360°.

---

## 4. Datos actuales

Todos los datos de negocio están **hardcodeados como objetos JavaScript literales** dentro del `<script>`:

| Estructura | Ubicación | Contenido |
|---|---|---|
| `UNITS` | línea 812 | 2 categorías (`estudio`, `dos`), 17 unidades en total (8 + 9) |
| `STATUS_META` | línea 806 | 3 estados: `disponible`, `en-uso`, `reservado` (bilingüe) |
| `LEGAL_DOCS` | línea 905 | 6 documentos legales completos (título, intro, párrafos) |
| `LEGAL_ORDER` | línea 1811 | orden de despliegue de los 6 documentos |
| `STR` | línea 583 | 194 claves de traducción `{es, en}` |
| `COUNTRIES` | línea 1147 (dentro de `BOOKING`) | 216 países `[iso2, nombre, indicativo]`, solo en español |
| `MAP_EMBED_SRC` | línea 1624 | URL fija del embed de Google Maps |

Cada unidad de `UNITS.estudio.units[]` / `UNITS.dos.units[]` tiene esta forma exacta (verificada, no inventada):

```js
{
  num: "09",                       // código interno, se muestra como "Apartamento H09"
  status: "disponible",            // disponible | en-uso | reservado
  area: 24,                        // m²
  maxPersons: 2,
  baths: 1,
  beds: ["Cama doble 1.40 m"],
  feature: {es:"...", en:"..."},   // característica destacada
  one:   [100000,85000,75000,75000], // tarifa 1 persona: [1 noche, 2-6 noches, semanal, mensual] — precio POR NOCHE de ese tramo
  two:   [130000,100000,75000,75000],// tarifa 2 personas, mismo formato
  extra: [50000,50000,50000,50000],  // recargo por persona adicional, mismo formato
  month: 2250000,                  // tarifa mensual de referencia (30 noches × one/two[3])
  promo: true,                     // opcional
  flagship: true                   // opcional, unidad destacada con ★
}
```

Casos especiales reales ya presentes en los datos (no son errores, son fidelidad al negocio real):
- Unidad H07: `one/two/extra: null` — no tiene tabla de tarifas publicada, se cotiza directo por WhatsApp.
- Unidad H04: `maxPersons:4`, `extra:[50000,50000,50000,0]` — persona adicional gratis en tarifa mensual.
- Dos direcciones distintas del negocio conviven en los datos reales (razón social vs. ubicación del inmueble) — ya documentado y aceptado, no corregir.

Cada categoría (`estudio`/`dos`) tiene también un array `rooms[]` de 6 ambientes (Zona Social, Ocio, Home Office, Descanso, Comedor, Baño) **compartido por todas las unidades de esa categoría** — el recorrido 360° es representativo del modelo, no de la unidad específica (esto ya se comunica en la UI).

---

## 5. Reservas

`BOOKING` en modo `reserva`. Al confirmar (`submitReservation()`, línea 1504), se guarda este objeto:

```js
{
  code, type:"reserva", createdAt,
  unitType, unitNum, unitLabel,
  checkin, checkout, nights, guests, estTotal,
  name, phone, email, notes,
  status: "pendiente"
}
```

**Hallazgos importantes:**
- `status` **siempre** se crea como `"pendiente"`. No existe en todo el archivo ningún código que lo cambie a otro valor — no hay `"confirmada"`, `"cancelada"`, ni panel para hacerlo. Es decir: **el sistema de estados de reserva descrito en el punto 12 del brief (pending → confirmed/rejected → cancelled/completed) no existe todavía, ni siquiera en su forma más simple.**
- **No hay validación de disponibilidad real ni de doble reserva.** El formulario no consulta si esas fechas ya están tomadas por otra reserva — el calendario solo bloquea fechas pasadas. Esto es una funcionalidad *faltante*, no una a "corregir".
- El campo `unit.status` (operativo) y la reserva **nunca se tocan entre sí** — crear una reserva no cambia `disponible` a `reservado`. Esta separación ya existe hoy (aunque por ausencia de conexión, no por diseño consciente), lo cual coincide exactamente con la advertencia del punto 11 del brief.

---

## 6. Calendario

Construido a mano dentro de `BOOKING` (sin librería):
- `renderCalendar()` (línea 1252): pinta mes/año navegable, celdas de días, deshabilita fechas pasadas (`date < today`) y, en modo `cita`, también domingos (`date.getDay()===0`).
- `bindCalendar()` (línea 1303): maneja navegación de mes y clic en día — en modo `reserva` arma un rango (check-in → check-out); en modo `cita` selecciona un solo día.
- Fechas se manejan internamente como objetos `Date` de JS y se serializan con `isoDate()` (`YYYY-MM-DD`) al guardar — **no se usan strings ambiguos tipo "10/11/2026"**, ya cumple lo pedido en el punto 14 del brief.
- `slotsForDate()` (línea 1223) calcula horarios disponibles para citas según el horario real de atención publicado (Lun-Vie 8-12:30 y 2-6pm → horas en punto; Sábado 8:30am-1pm → cada 30 min; domingo cerrado).

---

## 7. Precios

`computeEstimate()` (línea 1230), lógica real extraída y verificada matemáticamente contra los datos publicados (ej.: `two[3] × 30 noches` da exactamente el mismo valor que `unit.month`):

```js
function computeEstimate(unit, nights, guests){
  if(!unit.one) return null; // unidad sin tarifa publicada (ej. H07)
  tierIdx = nights<=1 ? 0 : nights<=6 ? 1 : nights<30 ? 2 : 3;
  base = guests>=2 ? unit.two[tierIdx] : unit.one[tierIdx];
  total = base * nights;                          // precio del tramo es POR NOCHE, no plano
  extraGuests = max(0, guests-2);
  if(extraGuests>0) total += extraGuests * unit.extra[tierIdx] * nights;
  return total;
}
```

Esta es la **única fuente de cálculo de precio** en todo el archivo — no hay tarifas hardcodeadas en un segundo lugar (la tabla "Tarifas de esta unidad" en la página de detalle solo muestra los mismos arrays `one/two/extra`, no recalcula nada por su cuenta).

---

## 8. Apartamentos

Ver estructura completa en el punto 4. Puntos adicionales:
- `unitLabel(unit)` → siempre `"Apartamento H" + unit.num` (la nomenclatura visible al público, distinta del código interno real del sitio original).
- La disponibilidad mostrada en el catálogo es el campo estático `unit.status`, editado manualmente en el código — no hay ningún proceso hoy que lo actualice automáticamente.
- Las fotos/recorridos 360 son actualmente **stock/placeholder embebido en base64** (Poly Haven CC0 + Unsplash), explícitamente señalado como tal en un banner visible — esto es intencional y documentado, pendiente de reemplazo cuando el dueño entregue fotos reales.

---

## 9. Visitas

`BOOKING` en modo `cita`, completamente independiente del flujo de reserva de estadía (comparten el mismo modal y los mismos pasos 2-4, pero paso 1 y el objeto final son distintos):

```js
{
  code, type:"cita", createdAt,
  unitType, unitNum, unitLabel,
  visitDate, visitTime,
  name, phone, email, notes,
  status: "pendiente"
}
```

No se mezcla con `reservation` en la lógica (aunque ambos viven en el mismo array de `localStorage`, distinguidos por el campo `type`). Igual que las reservas, no hay panel de confirmación ni transición de estado.

---

## 10. Mi reserva

`renderMiReserva()` + `renderReservationSummary()` + `mountMiReservaInteractivity()`. Busca por código exacto (`BOOKING.find(code)`) dentro del array guardado en `localStorage` — **solo encuentra reservas/citas creadas en ese mismo navegador**, no hay forma de consultar desde otro dispositivo. Esto ya está comunicado honestamente en la UI ("Demo: las reservas se guardan solo en este navegador").

---

## 11. localStorage

**Única clave usada en todo el sistema:** `usoInmobiliario_reservas_v1` — un array JSON con todos los objetos de reserva/cita mezclados (distinguidos por `type`). No hay ninguna otra clave de `localStorage` en el archivo (verificado por búsqueda completa). No se usa para preferencias de UI, idioma, tema, ni nada más — su único uso es como almacenamiento de reservas/citas.

---

## 12. WhatsApp

6 enlaces `https://wa.me/573003848517` en el archivo (topbar, footer, CTA final, página de tarifas, unidad no disponible, confirmación de reserva/cita). Todos son **deep links simples** con texto prellenado construido en el cliente vía `encodeURIComponent` — no hay API de WhatsApp Business, no hay webhook, no hay bot, no hay confirmación de entrega ni de lectura. Es, literalmente, un botón que abre WhatsApp con un mensaje ya escrito; el negocio responde manualmente.

---

## 13. 360° / multimedia

`PANO` (three.js): esfera equirectangular con textura cargada por unidad de recorrido, arrastre táctil/mouse para mirar alrededor, `dispose()` limpio al cambiar de ruta. Las imágenes (thumbnails pequeños + panorámicas completas) están **embebidas directamente en el HTML como base64**, no como archivos externos ni URLs — esto es el mayor motivo del peso del archivo (~2.7 MB) y es exactamente el punto que el brief pide resolver a futuro (URLs externas en vez de contenido embebido).

---

## 14. Responsive

22 media queries. Breakpoints principales: 1024px, 960px, 920px, 860px, 640px, 480px, 380px. Puntos ya corregidos explícitamente durante el desarrollo de este mismo sistema:
- Bug de CSS Grid en la sección de recorrido 360° (columnas no se encogían por debajo del contenido — corregido con `.tour-grid > *{min-width:0}`).
- Selector de teléfono con layout en fila que se apila verticalmente bajo 480px.
- Aspect-ratio del hero y del visor 360° ajustado específicamente para mobile.

---

## 15. Bilingüismo

`STR` (194 claves) + `t(key)` que devuelve `STR[key][LANG]`. `LANG` es una variable simple (`'es'` por defecto) cambiada por los botones del topbar, que dispara `applyStatic()` + `route()` para re-renderizar todo con el nuevo idioma. **No persiste entre recargas de página** (vuelve a `'es'` cada vez). Único hueco de bilingüismo real: los nombres de país en `COUNTRIES` (selector de teléfono) están solo en español — decisión pragmática ya tomada para no duplicar 216 nombres.

---

## 16. Código que debe conservarse

- Toda la experiencia de usuario ya construida y validada: catálogo, detalle de unidad, recorrido 360°, flujo de reserva/cita de 4 pasos, "Mi reserva", páginas legales, tarifas.
- Los datos reales tal cual están en `UNITS`, `LEGAL_DOCS`, `STR`, información de negocio (NIT, dirección, horario).
- La lógica de precio (`computeEstimate`) — ya es correcta y fue verificada contra los datos publicados.
- El router por hash y la convención de rutas actual (`#/unidad/:tipo?u=:num`, `#/mi-reserva?code=`, etc.) — no romper enlaces existentes.
- El diseño visual completo (paleta, tipografía, componentes) y el sistema de temas claro/oscuro.
- El visor 360° (`PANO`) tal cual funciona.
- El formato de código de reserva `AAA000`.

---

## 17. Código que debe refactorizarse (extraerse, no eliminar)

| Hoy vive en | Debe extraerse a | Motivo |
|---|---|---|
| `UNITS`, `STATUS_META`, `LEGAL_DOCS`, `STR`, `COUNTRIES` (literales JS) | Capa de datos / futuras colecciones Firebase | Fuente única, editable sin tocar código |
| `computeEstimate()` | `PricingService.calculatePrice()` | Reutilizable por Web, IA y Unity sin duplicar fórmula |
| `BOOKING.load/persist/find` (localStorage directo) | `ReservationService` + `DataProvider` | Para poder sustituir `localStorage` por Firebase sin tocar la UI del modal |
| `genCode()` | `ReservationService.createReservation()` | La unicidad del código debería validarse contra la fuente central, no solo contra el navegador local |
| Selección de fechas/horarios en `BOOKING` | `AvailabilityService` (nuevo, no existe hoy) | Hoy no hay ningún chequeo de solapamiento — es una funcionalidad a construir, no a mover |
| Render de unidades leyendo `UNITS` directamente | `ApartmentService.getApartments()` | Para que la UI deje de conocer la forma exacta de los datos |

**Importante:** nada de esto implica reescribir las funciones `render*` ni el HTML/CSS — implica que dejen de leer datos y hacer I/O directamente, y en su lugar llamen a un servicio.

---

## 18. Arquitectura propuesta

```
UI (render*, BOOKING, PANO — tal como existen hoy)
   ↓
Services  (ApartmentService, AvailabilityService, PricingService,
           ReservationService, VisitService, ContentService)
   ↓
DataProvider (interfaz común)
   ↓
LocalDataProvider (fase de transición, misma data que hoy)
   ↓ (después, sin tocar Services ni UI)
FirebaseDataProvider (Authentication + Realtime Database)
```

Dado que hoy **todo vive en un solo archivo sin build**, la migración de código debe ser incremental en dos ejes independientes:
1. **Eje lógico** (ya se puede hacer hoy, sin build): mover las funciones de datos/precio/reserva a objetos separados dentro del mismo `<script>` (ej. `var ApartmentService = {...}`), sin fragmentar archivos todavía.
2. **Eje de archivos** (`src/services/`, `src/data/`, etc., como sugiere el brief): requiere introducir un build step (Vite/esbuild) — **decisión pendiente de aprobación**, no se debe asumir antes de discutirlo, ya que hoy el proyecto se enorgullece de "sin build step".

Recomendación: completar el eje lógico primero (Fase 1 del brief) dentro del archivo actual; decidir sobre fragmentación de archivos recién en la Fase 3+ cuando ya haya Firebase de por medio y la necesidad de organización sea evidente.

---

## 19. Modelo Firebase Realtime Database (propuesta, derivada de los datos reales)

```
apartments/
  estudio_09/                       # typeKey + num, único y legible
    typeKey: "estudio"
    num: "09"
    name: {es,en}                   # ya existe por categoría en UNITS[tipo].name
    feature: {es,en}
    area, maxPersons, baths, beds: []
    operationalStatus: "disponible" # disponible | en-uso | reservado (igual que hoy)
    rates: { one:[], two:[], extra:[], month }
    flagship, promo (bool, opcionales)
    media:
      images: []
      tours360: [{id, name:{es,en}, url}]   # hoy son 6 por categoría, compartidos
      floorPlans: []

reservations/
  {pushId}/
    code, type: "reserva" | "cita"
    unitType, unitNum, unitLabel
    checkin, checkout, nights, guests, estTotal      # si type = reserva
    visitDate, visitTime                             # si type = cita
    name, phone, phoneCountry, phoneLocal, email, notes
    status: "pending" | "confirmed" | "rejected" | "cancelled" | "completed"
    createdAt

content/
  legal/{slug}: { title, intro, paragraphs: [] }     # igual a LEGAL_DOCS hoy
  strings/{key}: { es, en }                          # igual a STR hoy
  business: { nit, address, hours, whatsapp, emails }

settings/
  visitSlots: { weekday: [], saturday: [] }
```

Notas de diseño:
- **No se propone `customers/` en esta primera versión** — hoy los datos de contacto viven embebidos en cada reserva/cita, no hay entidad "cliente" reutilizable en el sistema actual. Crearla es una decisión de Fase 4, no algo a inventar ahora.
- **No se propone Storage** — `media.images/tours360/floorPlans` guardan solo URLs externas, tal como exige el punto 2 del brief.
- El esquema es intencionalmente plano y cercano a la forma actual de `UNITS`/`BOOKING`, para que la migración de datos sea casi 1:1.

---

## 20. Authentication (propuesta)

**Hoy: no existe ningún mecanismo de autenticación en el sistema.** El sitio público es 100% anónimo, sin login en ningún punto.

Propuesta: Firebase Authentication únicamente para la futura app de administración en Unity (correo/contraseña o método equivalente). El sitio público de reservas/citas **no debe requerir login** — coincide con el uso actual y con el punto 8 del brief.

---

## 21. Seguridad

**Estado actual: sin ninguna capa de seguridad**, porque no hay backend que proteja nada — todo el "sistema" corre en el navegador del visitante:
- Cualquier persona con las herramientas de desarrollador puede leer o editar las reservas guardadas en su propio `localStorage` (no hay integridad ni firma).
- El precio y la disponibilidad se calculan en el cliente — un usuario podría, en teoría, manipular el JS para intentar generar un código con datos falsos, aunque como no hay backend que lo reciba automáticamente (todo pasa por WhatsApp manual), el impacto real hoy es bajo.
- No hay datos sensibles de terceros expuestos (no hay panel admin, no hay login que proteger).

Propuesta a futuro (según reglas del brief): Realtime Database Rules deben separar lectura pública (`apartments`, `content`) de lectura/escritura restringida a administradores autenticados (`reservations`, futura colección `customers`). Ninguna clave o secreto debe vivir en el frontend. La confirmación de una reserva debe validarse siempre contra el servidor/reglas, nunca confiar en lo que envía el cliente (Web, Unity, WhatsApp o la IA).

---

## 22. Migración

Los datos reales a migrar ya están identificados y verificados (puntos 4-9). Se recomienda:
1. Escribir un script de transformación (Node) que **lea los objetos literales tal cual del archivo** (`UNITS`, `LEGAL_DOCS`, `STR`, horario de visitas) y genere el JSON exacto del esquema del punto 19 — evitando copiar/pegar manual, que es donde se introducen errores de tarifas o códigos.
2. **No migrar** las reservas/citas que hoy existan en `localStorage` de las pruebas de esta sesión de desarrollo — son datos de prueba, no reales. La colección `reservations` en Firebase debe arrancar vacía.
3. Migrar primero lo de menor riesgo (apartamentos, tarifas, contenido legal — son de solo lectura pública) antes que reservas (que requieren reglas de seguridad ya definidas).

---

## 23. Riesgos

- **No existe hoy validación de doble reserva ni de disponibilidad por fechas** — es la brecha más importante a cerrar, y coincide exactamente con la advertencia del punto 13 del brief.
- El campo `operationalStatus` (`disponible/en-uso/reservado`) es manual y estático — no se recalcula a partir de reservas confirmadas. Definir esa relación es una decisión de diseño pendiente, no algo que ya esté resuelto.
- Introducir un build step (`src/`, bundler) es un cambio grande para un proyecto que hoy se distribuye como un único HTML — debe decidirse explícitamente, no asumirse.
- El archivo pesa ~2.7 MB por imágenes embebidas; mover multimedia a URLs externas (punto 2 del brief) también reduce el archivo drásticamente, lo cual es una ganancia adicional de la migración.
- Todas las dependencias externas (Google Fonts, three.js, flag-icons, Google Maps embed) requieren conexión a internet — si alguna cae, degrada visualmente pero no debería romper el resto del sitio (a verificar caso por caso al migrar).
- `localStorage` es por navegador y dispositivo — cualquier reserva de prueba hecha durante desarrollo desaparece si se limpia el navegador; ya es sabido y aceptado.

---

## 24. Plan por fases (adaptado del brief a lo que realmente existe)

- **Fase 0 — Auditoría:** este documento.
- **Fase 1 — Separación lógica** (dentro del archivo actual, sin romper nada): extraer `PricingService`, `AvailabilityService` (nuevo), `ApartmentService`, `ReservationService`, `VisitService` como objetos JS, con la UI llamándolos en vez de leer `UNITS`/`localStorage` directamente. El sistema debe comportarse exactamente igual que hoy al terminar esta fase.
- **Fase 2 — Data Provider:** introducir `LocalDataProvider` que envuelva el `localStorage` actual detrás de la misma interfaz que tendrá Firebase.
- **Fase 3 — Firebase (datos públicos primero):** conectar Realtime Database, migrar `apartments`, `content`, tarifas. La web pasa a leer de Firebase en vez de los literales `UNITS`.
- **Fase 4 — Reservas en Firebase:** `reservations` deja de vivir solo en `localStorage`; `ReservationService` escribe/lee de Firebase. Aquí se decide el modelo de `customers` si aplica.
- **Fase 5 — Disponibilidad real:** `AvailabilityService.checkAvailability()` contra reservas confirmadas en Firebase — cierra el riesgo de doble reserva.
- **Fase 6 — Unity Admin:** login + ver/cambiar apartamentos y estados, conectado al mismo Firebase.
- **Fase 7 — WhatsApp oficial:** más allá del deep link actual, requiere integración con WhatsApp Business Platform (fuera del alcance de este HTML).
- **Fase 8 — IA:** conectar un asistente a los mismos servicios (nunca directo a Firebase).
- **Fase 9 — Automatización:** notificaciones, Google Calendar, seguimiento administrativo.

---

## 25. Próximo paso recomendado

**Esperar aprobación de esta auditoría antes de tocar código**, tal como se pidió explícitamente. Ningún archivo de código fue modificado durante esta tarea.

Una vez aprobada, el primer paso concreto de menor riesgo es la **Fase 1**: extraer `PricingService` y `ApartmentService` de dentro de `BOOKING`/`UNITS` como objetos separados en el mismo archivo, sin cambiar ni un solo comportamiento visible — es el cambio más aislado, más fácil de verificar (comparando antes/después en el navegador), y sienta la base para todo lo demás sin todavía introducir Firebase ni un build step.
