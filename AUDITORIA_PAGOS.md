# AUDITORÍA DEL SISTEMA DE PAGO Y RESERVAS

Fecha: 2026-09-04. Alcance: todo lo construido en `index.html`, `firebase/FirebaseDataProvider.js` y `firebase/database.rules.json` durante las sub-fases de disponibilidad/HOLD/pagos/citas de esta misma sesión. No se modificó ningún archivo para producir este documento — es solo lectura y análisis, tal como se pidió.

---

## 1. Estado actual

Construido y **verificado en vivo** (no solo revisado en código):

- Catálogo con estado disponible/en-uso/reservado sincronizado contra reservas confirmadas.
- Disponibilidad real por fecha (`AvailabilityService.checkAvailability`), conectada al calendario del modal.
- HOLD de 15 minutos con `expiresAt` numérico, contador reconstruido desde ese valor (no desde `setTimeout`), probado con recargo de página real.
- Expiración perezosa (lazy expiration) con reclamo atómico vía reglas de Firebase — **esto ya coincide exactamente con lo que pide la sección 6 del pedido**, no hay que rediseñarlo.
- Anti-doble-reserva atómico (`bookedNights`/`bookedVisitSlots` + `update()` multi-ruta) — probado con dos reservas simultáneas para la misma unidad/fechas.
- Reporte de pago por transferencia (banco/monto/fecha/referencia/comprobante opcional como URL), con los datos bancarios reales del negocio en `settings/paymentInfo` (Firebase) y como configuración propia en `LocalDataProvider` (nunca hardcodeados en la plantilla de la UI).
- Citas específicas (atadas a una unidad) y generales (`appointmentType`), sin HOLD ni bloqueo de noches para citas.
- "Mi reserva" muestra código, unidad, fechas, huéspedes, total, estado de negocio (no el campo crudo), contador si hay HOLD activo, y un recibo del pago una vez reportado.
- Botón de WhatsApp integrado en el modal y en "Mi reserva" (mensaje genérico de "quiero confirmar", ver problema en §8).

**No existe en absoluto** (0%, no parcial):

- Panel administrativo Unity — no hay ningún archivo, script ni integración Unity en el repositorio. Todo lo que el pedido describe en las secciones 15, 16 y 34 (registrar efectivo, revisar transferencias, panel de reservas) es trabajo nuevo, no una corrección.
- Firebase Authentication — confirmé con una búsqueda en todo `firebase/` que no existe ninguna llamada a `getAuth`/`signIn`/nada relacionado. Las reglas ya tienen `auth != null` como condición para las acciones de administrador, pero **hoy nadie puede autenticarse nunca** — no es un bug, es que ese login simplemente no se ha construido todavía.
- Pago en efectivo, campo `paymentMethod`, abstracción `PaymentProvider`.
- Mensaje de WhatsApp específico para "enviar comprobante" (solo existe el genérico de "quiero confirmar mi reserva").

---

## 2. Flujo actual

```
Apartamento → fechas → AvailabilityService.checkAvailability (en vivo, en el calendario)
→ precio (PricingService) → datos de contacto → resumen
→ [Generar código] → ReservationService.createRecord() → HOLD creado (expiresAt = ahora+15min)
→ paso 4: código + contador + instrucciones de transferencia (banco/monto/referencia)
→ [Ya realicé la transferencia] → formulario → paymentStatus: 'none'→'submitted'
→ (nada más — no hay verificación administrativa posible todavía, ver §8)
```

Esto coincide con el flujo objetivo de la sección 3 **hasta el paso de verificación administrativa**, que no puede existir sin un panel de administrador. También coincide con la sección 4: el HOLD se crea exactamente en el momento de "Generar código de reserva" (fin del resumen), no al abrir el modal ni al elegir fechas — confirmado leyendo `submitReservation()`.

---

## 3. Modelo actual (nombres reales, verificados en el código, no supuestos)

### `reservationsManager/reservations/{code}` (type: `'reserva'`)
```
code, type, createdAt, unitType, unitNum, unitLabel, name, phone, email, notes,
status: 'pendiente' | 'confirmada' | 'rechazada' | 'cancelada' | 'completada',
checkin, checkout, nights, guests, estTotal,
expiresAt: number (epoch ms),
paymentStatus: 'none' | 'submitted',
paymentReport?: { reference, date, amount, bank, proofUrl?, reportedAt }
```

### `reservationsManager/visits/{code}` (type: `'cita'`)
```
code, type, createdAt, unitType?, unitNum?, unitLabel, name, phone, email, notes,
status: 'pendiente' | 'confirmada' | 'rechazada' | 'cancelada' | 'completada',
visitDate, visitTime,
appointmentType: 'specific_visit' | 'general_visit'
```
(`unitType`/`unitNum` se omiten del todo cuando `appointmentType === 'general_visit'`.)

### `unitBookings/{unitType_num}/{code}` (espejo público, sin datos de contacto)
```
status, type, checkin/checkout o visitDate/visitTime, expiresAt, paymentStatus
```
Usado por `effectiveStatus()` (badge del catálogo) y por la regla de reclamo de HOLD vencido.

### `bookedNights/{unitKey}/{fecha}` y `bookedVisitSlots/{unitKey}/{fecha_hora}`
Un nodo por noche/turno ocupado, valor = código de la reserva/cita dueña. Solo existencia, sin más datos.

### `settings/paymentInfo`
```
bankName, accountHolder, accountType, accountNumber
```

**Punto clave para la sección 7 del pedido**: hoy **no existe un campo `reservationStatus` separado** — `status` cumple ese rol directamente. Tampoco existe un campo `hold` separado — el HOLD es implícito: `type==='reserva' && status==='pendiente' && expiresAt existe`. La sección 9 propone mostrar esto siempre bajo una función de traducción (`reservationDisplayStatus()`, ya construida), nunca el campo crudo — eso ya se cumple.

---

## 4. HOLD actual

Ya cumple la sección 4 al pie de la letra: se crea únicamente al confirmar el resumen (no al abrir el modal ni elegir fechas), guarda `createdAt` (vía `createdAt` del registro) y `expiresAt` (numérico), dura 15 minutos (`HOLD_DURATION_MS`).

**Diferencia con el pedido**: el pedido sugiere que el HOLD sea un concepto/registro separado de la reserva. Lo que existe hoy es una reserva con `status:'pendiente'` que *funciona como* HOLD mientras no expira. No hay dos entidades de datos distintas — hay una función derivada (`isHoldExpired`) que decide si esa reserva pendiente cuenta como HOLD vigente o no. Esto es intencional (evita duplicar el registro) pero vale la pena confirmarlo explícitamente como decisión, no dejarlo implícito.

---

## 5. Pago actual

Solo transferencia bancaria. Reporte de un solo sentido (`'none' → 'submitted'`), aplicado tanto en `LocalDataProvider` como en `FirebaseDataProvider` y protegido en las reglas (ver §7). **No existe ninguna forma de que `paymentStatus` llegue a `'verified'` ni `'rejected'`** — esos valores no existen en el código todavío. Tampoco existe ninguna UI que llame a `confirmReservation()`/`rejectReservation()` (esas funciones existen como *stubs* desde la Fase 1, listas pero sin ningún botón que las invoque).

---

## 6. Firebase actual

Solo Realtime Database, confirmado por lectura directa de `firebase/FirebaseDataProvider.js` (únicos imports: `initializeApp`, `getDatabase`/`ref`/`onValue`/`get`/`update`). Cero referencias a Storage, Firestore, Cloud Functions o Cloud Run en todo el proyecto — la restricción de la sección 1 ya se cumple, no por casualidad sino por diseño explícito desde el inicio del proyecto.

Firebase Authentication: **paquete no importado, no inicializado, sin ningún archivo de login**. Confirmado con búsqueda exhaustiva.

---

## 7. Rules actuales (`firebase/database.rules.json`, leído completo)

Ya protegen correctamente casi todo lo que pide la sección 36:

| Pregunta de la sección 36 | Estado real |
|---|---|
| ¿Puede el cliente confirmar su propia reserva? | No — `status` solo acepta `'pendiente'` sin `auth != null` |
| ¿Puede verificar su propio pago? | No — `paymentStatus` solo permite el único salto `'none'→'submitted'` sin auth |
| ¿Puede modificar `expiresAt`? | No — no tiene `.write` propio, hereda el del nodo padre (bloqueado tras creación) |
| ¿Puede prolongar el HOLD? | No, por lo anterior |
| ¿Puede modificar `bookedNights` de otro? | No — solo puede crear donde no existe, o reclamar un HOLD ya vencido sin pago |
| ¿Puede modificar `paymentInfo`? | No — `settings` es `auth != null` completo |
| ¿Puede modificar una reserva ajena? | No — el nodo padre exige `auth != null` una vez que el código ya existe |

**Esto ya está bien diseñado.** El problema no es la seguridad de las reglas — es que, al no existir Authentication (§6), **tampoco existe manera de que un admin real las use**. Las reglas están listas para un admin que todavía no puede iniciar sesión.

---

## 8. Problemas encontrados

1. **No hay `paymentMethod`.** Todo el flujo asume transferencia. No hay opción de efectivo en ningún punto de la UI ni del modelo de datos.
2. **`paymentStatus` incompleto** — faltan `'verified'` y `'rejected'`. Sin panel admin, esto no se ha necesitado hasta ahora, pero el modelo no está preparado.
3. **`checkAvailability` no devuelve `reason`** — hoy es `{available: boolean}`, la sección 22 pide algo como `{available: false, reason: 'confirmed_reservation' | 'temporary_hold'}`.
4. **Sin `PaymentProvider`** — `reportPayment()` está escrito directamente para transferencia, sin ninguna capa de abstracción que permita añadir efectivo o una pasarela futura sin tocar `ReservationService`.
5. **Sin `AppointmentService` como nombre propio** — existe `VisitService`, que cumple el mismo rol (una puerta de entrada separada de `ReservationService` para citas) pero reutiliza los helpers internos de `ReservationService` (`_createRecord`). Es una decisión de diseño ya tomada (evita duplicar la lógica de creación), no un error, pero no coincide con el nombre exacto que pide la sección 24.
6. **Lógica de expiración de HOLD triplicada** — existe casi la misma función `isHoldExpired`/`isHoldExpiredRecord` en tres lugares (`LocalDataProvider`, `FirebaseDataProvider.js`, dentro de `BOOKING`). Hoy están sincronizadas porque las escribí todas en la misma sesión, pero es un riesgo de mantenimiento real: si se cambia el criterio en un lugar y se olvida en otro, la web mentiría de nuevo.
7. **No existe el mensaje de WhatsApp de la sección 12** ("Hola, realicé el pago... Adjunto el comprobante") — solo existe un mensaje genérico de "quiero confirmar mi reserva", sin monto ni mención de comprobante.
8. **No hay registro de auditoría** (`verifiedAt`, `verifiedBy`) porque no hay ninguna acción que verifique todavía.

---

## 9. Contradicciones

La única contradicción real es entre **lo que el pedido asume que ya existe parcialmente** (Unity, Authentication) **y lo que existe de verdad (nada)**. No es una contradicción dentro del código — es una diferencia entre el punto de partida asumido por el pedido y el punto de partida real. Vale la pena decirlo explícito para no planear las siguientes fases como si Unity ya tuviera una base sobre la cual "completar".

No encontré contradicciones internas en el modelo de datos actual (los nombres son consistentes entre `LocalDataProvider` y `FirebaseDataProvider`, las reglas coinciden con lo que el código realmente escribe).

---

## 10. Solución propuesta

- **No renombrar `status`→`reservationStatus`** ni inventar un objeto `hold` separado. El modelo actual (una reserva con `status:'pendiente'` + `expiresAt` que se interpreta como HOLD vigente/vencido) ya cumple el principio de la sección 6 (lazy expiration) y evita una migración de datos innecesaria. Se documenta como decisión consciente, no como pendiente.
- **Sí añadir**: `paymentMethod` (`'bank_transfer' | 'cash'`), y extender `paymentStatus` con `'verified'`/`'rejected'` — cambio aditivo, no rompe nada existente (los registros viejos simplemente nunca llegan a esos valores hasta que exista un admin que los use).
- **Sí añadir** `reason` a `checkAvailability()`.
- **Sí construir** una abstracción `PaymentProvider` mínima (`ManualBankTransferProvider`, `CashPaymentProvider`) — delgada, sin sobrediseño, tal como pide la sección 39/40.
- **Sí escribir** el mensaje de WhatsApp específico para comprobante (sección 12).
- **Separar explícitamente** el trabajo de Unity/Authentication como su propia fase — no es "completar", es construir desde cero, y depende de que el dueño decida cómo se autenticará (usuario/contraseña, quién tiene acceso, etc.), una decisión suya, no técnica.
- **Opcional, baja prioridad**: unificar la lógica de expiración del HOLD en un solo lugar compartido para evitar la triplicación del §8.4 — no urgente porque hoy está sincronizada, pero lo dejo señalado.

---

## 11. Estados definitivos (propuestos, sin tocar código todavía)

**`status`** (reserva/cita) — sin cambios: `pendiente | confirmada | rechazada | cancelada | completada`.

**`paymentStatus`** (solo reservas) — extendido: `none | submitted | verified | rejected`.

**HOLD** — sigue siendo derivado, no un campo nuevo: `isHoldExpired(res)`.

**`paymentMethod`** (nuevo) — `bank_transfer | cash`.

---

## 12. Flujo definitivo (propuesto)

Igual al actual (§2), con un paso nuevo insertado justo después de crear el HOLD:

```
... HOLD creado → [elegir método: Transferencia | Efectivo] →
  si Transferencia: instrucciones + reporte (como ya existe)
  si Efectivo: mensaje "paga en persona, un administrador debe verificar" (sin formulario)
→ verificación administrativa (Unity, fase aparte) → confirmada
```

---

## 13. Cambios necesarios en Web

1. Paso de selección de método de pago (transferencia/efectivo) en el paso 4 del modal, antes de mostrar instrucciones.
2. Bloque de "pago en efectivo" (sección 32) — sin campo de reporte, solo el mensaje de que un administrador debe confirmar.
3. Botón "Enviar comprobante por WhatsApp" con el mensaje específico de la sección 12 (distinto del botón genérico ya existente).
4. `checkAvailability()` devuelve `{available, reason}`.
5. `PaymentProvider` (capa delgada) delante de `reportPayment`.
6. Extender `reservationDisplayStatus()` para los nuevos valores de `paymentStatus` (`verified`/`rejected`) — hoy solo maneja `none`/`submitted`.
7. Etiquetas nuevas en "Mi reserva" para pago verificado/rechazado.

---

## 14. Cambios necesarios en Unity

**Todo esto es trabajo nuevo, no correcciones**:

1. Autenticación de administrador (requiere que Firebase Authentication exista primero — decisión del dueño: quién tiene acceso, cómo se crean las cuentas).
2. Vista de reservas (pendientes, con HOLD, pagos reportados, confirmadas, expiradas, canceladas, rechazadas).
3. Acción "Registrar pago en efectivo" (sección 15).
4. Acción "Verificar pago" / "Rechazar pago" (sección 16).
5. Re-validación de disponibilidad antes de confirmar (sección 17) — no puede confiar en el estado que la propia vista mostró antes.

---

## 15. Cambios necesarios en Firebase

1. Habilitar Firebase Authentication (Email/Password es lo más simple) — acción manual del dueño en la consola, igual que la importación del catálogo.
2. Reglas nuevas para `paymentMethod` (validación simple de string).
3. Confirmar que un admin autenticado (`auth != null`) ya puede escribir `paymentStatus: 'verified'/'rejected'` y `status: 'confirmada'/'rechazada'` — **ya puede**, las reglas actuales no distinguen valores específicos para el caso `auth != null`, solo exigen que exista sesión. No hace falta ampliar las reglas para esto, solo que exista el login.

---

## 16. Pruebas

De las 23 pruebas pedidas en la sección 41, ya verifiqué en vivo durante esta sesión (no solo en teoría):

- **#1** disponible → reserva funciona.
- **#3** HOLD vigente → no se puede reservar (bloqueo atómico probado).
- **#4** HOLD expirado → fechas vuelven a estar disponibles (forcé la expiración y confirmé el reclamo).
- **#16** dos clientes, mismo apartamento/fechas → solo uno obtiene el HOLD.
- **#17** cita específica para apartamento ocupado → ya se bloquea si es una unidad no disponible (el botón "Cotizar visita" se oculta).
- **#18** cita general → no bloquea una unidad (confirmado, no toca `bookedVisitSlots`/`unitBookings`).
- **#21** recargar durante HOLD → contador correcto desde `expiresAt`.
- **#22** cerrar y volver durante HOLD → mismo resultado, probado vía "Mi reserva".

**No se pueden probar todavía** porque la funcionalidad no existe: #6 (admin verifica transferencia), #7 (admin confirma), #8 (efectivo), #9 y #10 (cliente intenta confirmar/verificar — la regla ya lo impide, pero no hay UI de admin con la que comparar el resultado esperado completo del flujo).

**Pendientes de probar explícitamente** (la regla existe pero no hice el intento en vivo esta sesión): #11 (modificar `expiresAt` debe fallar), #2 (reserva confirmada bloquea — no se puede probar de punta a punta sin admin, pero puedo simular el estado y confirmar que `checkAvailability` lo respeta).

---

## Resumen para decidir

Lo que ya existe cubre bien las secciones 3 a 7, 10, 11 (parcial), 17 (parcial vía disponibilidad), 22, 23, 24 (parcial), 25 a 27, 29 a 31 (transferencia), 33 (parcial), 36 a 38, y 42 a 47 del pedido original. Lo que falta de verdad son tres bloques separables:

**A. Web — pago en efectivo + método + WhatsApp comprobante + `PaymentProvider`** (tamaño similar a la sub-fase de pagos ya hecha).
**B. Firebase Authentication** (una decisión + un trámite del dueño, no código complejo).
**C. Unity — panel completo de administrador** (el bloque más grande, desde cero).

Quedo detenido aquí, sin tocar código ni reglas, a la espera de que apruebes la arquitectura de la sección 10-11 y me digas con cuál bloque (A, B o C) seguimos.
