# Fase 3 — Firebase (datos públicos del catálogo)

Esta carpeta contiene todo lo que se puede preparar **sin** un proyecto Firebase real.
Lo único que falta para conectar de verdad es que tú crees el proyecto y me pases sus
credenciales (o las pegues tú mismo siguiendo estos pasos — ambas opciones sirven).

## Qué migra en esta fase (y qué no)

- **Sí migra:** catálogo de apartamentos (`categories`, `apartments`, `statusMeta`,
  `settings.visitSlots`) — son datos públicos de solo lectura para el sitio web.
- **No migra todavía:** reservas y citas. Siguen en `localStorage`, tal como hoy. Eso es
  Fase 4 en el plan aprobado (`AUDITORIA.md`), porque evitar la doble reserva con
  escrituras concurrentes es un problema distinto y más delicado que servir un catálogo
  de solo lectura — no se resuelve de paso aquí.

## Pasos

1. **Crear el proyecto** en [console.firebase.google.com](https://console.firebase.google.com) (si no existe uno ya para Uso Inmobiliario).
2. **Habilitar Realtime Database** (no Firestore) — Build → Realtime Database → Crear base de datos. Elegir la región más cercana (ej. `us-central1`). Empezar en modo bloqueado (las reglas de este repo las reemplazan después).
3. **Importar los datos reales**: Realtime Database → ⋮ (menú) → Importar JSON → seleccionar [`seed-apartments.json`](./seed-apartments.json) de esta carpeta. Ya tiene las 17 unidades reales, sus tarifas reales y los 3 estados — nada inventado, es una copia exacta de lo que hoy vive en `UNITS`/`STATUS_META` dentro de `index.html`.
4. **Publicar las reglas de seguridad**: Realtime Database → pestaña Reglas → pegar el contenido de [`database.rules.json`](./database.rules.json) → Publicar. (La sección `reservations` de esas reglas es un borrador conservador para cuando llegue Fase 4 — no se usa todavía porque las reservas siguen en `localStorage`.)
5. **Obtener el config de la app web**: ⚙️ Configuración del proyecto → desplázate a "Tus apps" → si no hay una app web, créala (icono `</>`) → copia el objeto de config.
6. **Crear `firebase-config.js`** en esta misma carpeta, copiando [`firebase-config.example.js`](./firebase-config.example.js) y pegando tus valores reales. (Este archivo no se sube a git si el repo tiene `.gitignore` para credenciales — recuérdame configurarlo si hace falta.)
7. **Activarlo en el sitio**: agregar esta línea en `index.html`, justo antes de `</body>`:
   ```html
   <script type="module" src="firebase/FirebaseDataProvider.js"></script>
   ```
   No hace falta cambiar nada más — `ApartmentService` seguirá funcionando exactamente igual, solo que ahora sus datos vendrán de Firebase en vez de los literales del archivo. Si Firebase no responde por cualquier motivo, el sitio sigue funcionando con los datos locales (no se rompe nada).

## Qué falta de mi lado antes de dar esto por terminado

Una vez tengas el proyecto y las credenciales, necesito volver a correr toda la
verificación en el navegador (catálogo, unidad por unidad, reserva y cita completas,
"Mi reserva", cambio de idioma) contra los datos reales de Firebase — igual que hice en
Fase 1 y Fase 2 — antes de considerar esta fase cerrada. No lo voy a dar por bueno solo
porque el código "se ve bien".
