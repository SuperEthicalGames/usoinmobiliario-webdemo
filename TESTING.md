# Testing — Uso Inmobiliario

Qué está probado, cómo correrlo, y por qué una parte real del pedido (concurrencia contra
Firebase real) no se pudo hacer en este entorno — declarado explícitamente, no asumido.

## Lo que sí se puede probar aquí: lógica pura, sin red

`whatsapp-assistant/test/` — Node nativo (`node:test` + `node:assert/strict`), **sin dependencia
nueva** (Node 20 ya lo trae, mismo criterio de "sin dependencias de más" que el resto del
proyecto).

```bash
cd whatsapp-assistant
npm test
```

31 casos, cuatro archivos:

- **`pricing.test.js`** — tramos por noches, tarifa de huésped extra, y el caso real que motivó
  `priceIntegrityCheck` (P1-03 de `SECURITY_AUDIT.md`): un `estTotal` manipulado por el cliente
  se detecta comparando contra las tarifas reales, siempre recalculado con `checkin`/`checkout`
  reales — nunca con el `nights` que trae el registro (otro dato que el cliente pudo alterar).
- **`validators.test.js`** — el sistema anti-datos-inventados (`isPlaceholderText`,
  `isValidEmail`, etc.) rechaza los valores de relleno reales que la IA llegó a generar bajo
  presión ("Cliente", "0000000000", "pendiente@correo.com"), no solo formato válido.
- **`dateUtil.test.js`** — incluye el bug real ya documentado en el propio archivo: `Date.UTC`
  normaliza en silencio un día fuera de rango ("2026-02-30" → 2 de marzo) en vez de fallar;
  `isValidIsoDate` tiene que detectarlo con un round-trip, no solo `isNaN`.
- **`rbac.test.js`** — el corazón de la Fase 2 (ver `RBAC.md`): `requireRole` deja pasar el rol
  correcto y rechaza con 403 cualquier otro (incluyendo "sin rol resuelto todavía", para que
  nunca abra por accidente si `attachRole` fallara en poblarlo); `sanitizeApartmentPatch` nunca
  guarda un `status` fuera del enum; `domainForAction` clasifica bien la bitácora.

Estos cubren funciones **puras** (mismo input → mismo output, sin Firebase, sin red) — se
importan directo desde `src/`, nunca se levanta un servidor ni se toca una base de datos real.

## Lo que NO se pudo probar en este entorno (y por qué)

El pedido original pide pruebas de **concurrencia real** contra Firebase (100 solicitudes
simultáneas por la misma unidad, dos HOLD peleando la misma fecha, expiración de HOLD en
carrera con un pago reportado, etc.) — esto necesita el **emulador de Firebase Realtime
Database**, la única forma de probar Rules y transacciones reales sin tocar el proyecto de
producción.

Se intentó explícitamente (no se asumió que fallaría): `firebase-tools` requiere alcanzar
`firebase-public.firebaseio.com` para descargar/arrancar el emulador, y este sandbox lo
bloquea — confirmado con el endpoint de diagnóstico del proxy (`403`), documentado ya en
`AUDITORIA_EXTERNA_2026_09.md` §2/§7 la primera vez que una sesión de auditoría intentó esto
mismo. No es una suposición repetida sin verificar: cada sesión que lo necesitó lo intentó de
nuevo y encontró el mismo bloqueo.

**Lo que ya cubre esa brecha, parcialmente:** `claimNightAtomically`/`bookedNights` (anti-doble-
reserva) y la condición de reclamo de HOLD vencido en `database.rules.json` ya fueron
**verificados en vivo contra el proyecto real** en sesiones anteriores (ver `SECURITY_AUDIT.md`
§2, `AUDITORIA_PAGOS.md` #16-17) — probando dos reservas simultáneas reales, no solo leyendo el
código. Esas pruebas manuales siguen siendo válidas; lo que falta es automatizarlas como una
suite repetible.

**Para completar esto de verdad**, hace falta una de estas dos cosas, ninguna disponible aquí:

1. Correr `firebase emulators:start` desde una máquina/CI con acceso de red normal (el dueño del
   proyecto, o un runner de GitHub Actions sin esta restricción), y escribir specs con
   `@firebase/rules-unit-testing` contra ese emulador.
2. Un proyecto de Firebase de PRUEBA separado (no el real) con las mismas Rules publicadas,
   para poder probar contra un backend real sin arriesgar datos de producción.

## Qué se verificó en su lugar, en esta sesión

Para cada cambio de código (RBAC, apartamentos, idempotencia, emails, bitácora):
- `node --check` sobre cada archivo de backend tocado.
- Arranque real del servidor (`node src/server.js`, variables de entorno dummy) y peticiones
  HTTP reales contra rutas nuevas/cambiadas — confirmando 401/403 sin token, y que el servidor
  no se cae al montar las rutas nuevas.
- `tsc -b`, `vite build` y `oxlint` sobre el panel — sin errores nuevos, sin warnings nuevos más
  allá del patrón `set-state-in-effect` ya preexistente en las otras 12+ pantallas.
- Verificación real en el navegador (Browser pane) del sitio público servido en estático: el
  cambio de la sección 12 (relajar `isUnitBookable`) se probó de punta a punta navegando a una
  unidad "Reservado" real y confirmando que el botón "Reservar ahora" aparece con el aviso
  nuevo, en vez de estar oculto.

## Pendiente declarado (no implementado en esta sesión)

- Suite de concurrencia/Rules contra el emulador (bloqueado aquí, ver arriba).
- Tests de integración HTTP con un token real de Firebase Auth por rol (owner/admin/employee) —
  este entorno no tiene credenciales de un proyecto de Firebase real para generar tokens
  válidos; los tests de RBAC de esta sesión prueban `requireRole` de forma aislada (con
  `req.adminUser` simulado), que es la pieza que de verdad decide el acceso, pero no reemplazan
  una prueba end-to-end con un login real de cada rol.
