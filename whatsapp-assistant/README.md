# Asistente virtual de WhatsApp — Uso Inmobiliario

Backend independiente del panel administrativo de Unity. Comparte **únicamente** la misma
Firebase Realtime Database (fuente de verdad del negocio) — no hay una segunda base de datos,
no se usa Firebase Storage, no se toca ni se importa código de Unity desde aquí.

## Qué hace

Un asistente conversacional en WhatsApp Business que entiende lenguaje natural (no comandos),
usando Gemini con *function calling* sobre un set controlado de operaciones de negocio
(`src/businessTools.js`). El modelo **nunca** escribe a Firebase directamente — solo puede
invocar esas funciones, y ninguna de ellas puede confirmar un pago ni aprobar una reserva (eso
sigue siendo exclusivo del panel administrativo de Unity).

```
WhatsApp Business → WhatsApp Cloud API → webhook (src/server.js)
                                              ↓
                                     src/aiAgent.js (Gemini + function calling)
                                              ↓
                                     src/businessTools.js (valida, arma el dato)
                                              ↓
                                     src/firebase.js (Admin SDK, único lugar que toca Firebase)
                                              ↓
                                     Firebase Realtime Database (la misma del sitio web/Unity)
```

## Estructura

```
whatsapp-assistant/
  src/
    server.js            Express + rutas del webhook
    firebase.js           Firebase Admin SDK — lecturas/escrituras crudas
    whatsapp.js            Cliente de WhatsApp Cloud API
    aiAgent.js              Gemini, personalidad, declaración de tools, loop de function calling
    businessTools.js         Las funciones que el modelo puede invocar (única superficie expuesta a la IA)
    conversationStore.js      Contexto de conversación por número (en memoria, con expiración)
    validators.js              Validaciones (correo, código, fechas, teléfono)
    pricing.js                  Cálculo de precio (mismo algoritmo que index.html/Unity)
    dateUtil.js                  Fechas/noches (mismo criterio que index.html/Unity)
  config/index.js         Carga y valida variables de entorno
  .env.example
```

## Requisitos

- Node.js 18 o superior (usa `fetch` global — no hay dependencia extra para HTTP).
- Una cuenta de servicio de Firebase con acceso de **Admin** al mismo proyecto
  (`usoinmobiliario-c8e83`) que ya usan el sitio web y Unity.
- Una app de WhatsApp Business en [Meta for Developers](https://developers.facebook.com/) con
  el producto **WhatsApp** agregado (tiene cuota gratuita: primeras 1000 conversaciones/mes).
- Una API key de [Google AI Studio](https://aistudio.google.com/apikey) para Gemini (tiene
  cuota gratuita para desarrollo/pruebas).

## Configuración

1. `cp .env.example .env` y llena los valores (ver comentarios en ese archivo).
2. Cuenta de servicio de Firebase: Firebase Console → ⚙️ Configuración del proyecto → Cuentas
   de servicio → **Generar nueva clave privada**. Guarda el JSON descargado fuera del repo (por
   ejemplo en la carpeta padre) y apunta `FIREBASE_SERVICE_ACCOUNT_PATH` a esa ruta — o pega el
   JSON completo (una sola línea) en `FIREBASE_SERVICE_ACCOUNT_JSON`. Nunca subas ese archivo al
   repositorio.
3. `npm install`
4. `npm start` (o `npm run dev` para reinicio automático al editar archivos).

## Conectar el webhook de WhatsApp

El servidor necesita una URL pública HTTPS (localhost no sirve para que Meta le hable). Para
desarrollo, la forma más simple y gratuita es un túnel temporal (ej. `ngrok http 3000`) —
apunta la URL que te dé a `https://tu-url/webhook/whatsapp` en la configuración del webhook de
tu app de Meta, usando el mismo `WHATSAPP_VERIFY_TOKEN` que pusiste en `.env`.

Para producción, cualquier host con capa gratuita que corra Node.js sirve (Render, Fly.io,
Railway, Google Cloud Run) — evita Cloudflare Workers para este proyecto específico: el SDK
`firebase-admin` depende de APIs de Node (no del runtime de Workers), por eso el `email-worker/`
hermano de este proyecto (que sí usa Workers) nunca toca Firebase directamente.

## Limitaciones conocidas (honestas, no ocultas)

- **El contexto de conversación es en memoria** (`conversationStore.js`) — si el servidor se
  reinicia, todas las conversaciones activas se olvidan (el cliente tendría que repetir datos
  a medio proceso). Esto es aceptable para un MVP gratuito sin costo de base de datos adicional;
  si se vuelve un problema real, la solución sería persistir el historial en el propio Firebase
  bajo un path nuevo (ej. `assistantSessions/{phone}`) — deliberadamente no se hizo eso todavía
  para no añadir una segunda responsabilidad a Firebase sin que se haya pedido.
- **No hay reintento automático** si el envío a WhatsApp falla (se registra el error en logs,
  no se reintenta solo) — para el volumen esperado de un solo negocio pequeño no es crítico
  todavía.
- **Solo procesa mensajes de texto** — audios, imágenes, ubicaciones, etc. se ignoran
  silenciosamente por ahora (no rompen el webhook, pero tampoco generan respuesta).
- Este entorno de desarrollo no tenía Node.js instalado al escribir este backend — el código
  está escrito y revisado, pero **no ejecutado en vivo todavía**. Antes de conectarlo a
  WhatsApp real, sigue `TEST_PLAN.md`.

## Qué NO hace (a propósito)

Ver la lista completa de restricciones en `TEST_PLAN.md`, sección "Reglas que nunca deben
romperse". En resumen: nunca confirma pagos, nunca aprueba reservas, nunca inventa datos, nunca
usa Firebase Storage, nunca crea una reserva sin correo, nunca reemplaza el panel de Unity.
