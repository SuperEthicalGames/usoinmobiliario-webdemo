# Deployment — Uso Inmobiliario

## Resumen de despliegue por pieza

| Pieza | Repo | Dónde | Cómo se dispara |
|---|---|---|---|
| Sitio público | `usoinmobiliario-webdemo` | GitHub Pages | Push a `main` → `.github/workflows/pages.yml` |
| Backend (WhatsApp/IA/admin API) | `usoinmobiliario-webdemo` (`whatsapp-assistant/`) | Render | Push a `main` → integración automática de Render (GitHub App), no un workflow de Actions |
| Panel administrativo | `usoinmobiliario-middleware` | GitHub Pages | Push a `main` → `.github/workflows/deploy.yml` |

**Importante:** las tres piezas son independientes. Desplegar una sin revisar las otras dos
puede dejar features a medias (ej. el panel mostrando 404 en una ruta nueva del backend, o
Analytics sin datos porque el sitio todavía no manda `/track/pageview`). Antes de dar por
terminado un deploy, confirmar las tres.

## Variables de entorno — backend (`whatsapp-assistant/`)

Ver `whatsapp-assistant/.env.example` para la lista completa y comentada. Resumen de qué
cambia entre entornos:

| Variable | Desarrollo local | Producción (Render) |
|---|---|---|
| `NODE_ENV` | vacío o `development` | **`production`** — ya fijado en `render.yaml`. Activa fail-closed en la firma del webhook de WhatsApp (ver `SECURITY_AUDIT.md` P1-01). |
| `WHATSAPP_APP_SECRET` | opcional (advierte y acepta sin firma si falta) | **obligatorio en la práctica** — sin esto, con `NODE_ENV=production`, el webhook rechaza TODO el tráfico entrante de WhatsApp. Configúralo en el dashboard de Render ANTES o inmediatamente después de este deploy. |
| `FIREBASE_SERVICE_ACCOUNT_JSON`/`_PATH` | uno de los dos, apuntando a la cuenta de servicio real descargada de la consola de Firebase | `FIREBASE_SERVICE_ACCOUNT_JSON` (pegado como variable en Render) — nunca subir el archivo JSON al repo |
| `WHATSAPP_TOKEN` | token temporal de pruebas de Meta (expira cada 24h) | token de producción, permanente, generado en Meta for Developers |
| `GEMINI_API_KEY`/`OPENAI_API_KEY` | key de desarrollo, cuota libre está bien | key real del proyecto — activa solo la del `LLM_PROVIDER` elegido |
| `ADMIN_ORIGIN` | no importa — `localhost:*` ya está permitido explícitamente en el código | debe ser el origin real donde vive el panel (`https://superethicalgames.github.io` por defecto) |

**Nunca dejar activo en producción:** el modo "advierte y acepta" del webhook sin firma (eso es
exactamente lo que `NODE_ENV=production` desactiva). Si alguna vez se necesita depurar el webhook
real de Meta sin tener el App Secret a mano, hacerlo con `NODE_ENV` sin fijar, nunca contra el
servicio de Render real.

## Pasos de deploy — backend (Render)

1. `git push` a `main` en `usoinmobiliario-webdemo` — Render lo detecta solo (integración ya
   configurada, ver `render.yaml`).
2. Verificar `GET https://usoinmobiliario-whatsapp-bot.onrender.com/health` → `{"ok":true}`.
3. Si es la primera vez que se configura `WHATSAPP_APP_SECRET`, o si acaba de fijarse
   `NODE_ENV=production` sin tenerlo aún: revisar los logs de Render — debe aparecer el mensaje
   de error explícito si falta (`[whatsapp] WHATSAPP_APP_SECRET no configurado en producción...`),
   nunca un rechazo silencioso.

## Pasos de deploy — sitio público (GitHub Pages)

1. `git push` a `main` en `usoinmobiliario-webdemo`.
2. El workflow copia `index.html`, `media/`, `firebase/FirebaseDataProvider.js` y
   `firebase/firebase-config.js` — **nunca** `whatsapp-assistant/`, `email-worker/`, las semillas
   de Firebase ni los documentos de auditoría.
3. Verificar en vivo: la consola del navegador no debe mostrar `firebase-config.js → 404` (si
   aparece, algo rompió el paso anterior).

## Pasos de deploy — panel administrativo (GitHub Pages)

1. `git push` a `main` en `usoinmobiliario-middleware`.
2. El build de Vite usa `base: '/usoinmobiliario-middleware/'` — confirmar que el workflow
   publica el contenido de `dist/` tal cual (no la raíz del repo).
3. Verificar login real contra Firebase Auth antes de dar el deploy por terminado — un CSP mal
   configurado (o cualquier cambio futuro a `index.html`) podría bloquear silenciosamente las
   llamadas a `identitytoolkit.googleapis.com`/`securetoken.googleapis.com` sin que se note hasta
   que alguien intente entrar.

## Firebase — configuración obligatoria fuera del código

- **Reglas de Realtime Database:** este proyecto no tiene el CLI de Firebase configurado en
  ningún entorno de desarrollo usado hasta ahora — publicar `firebase/database.rules.json` es un
  paso **manual** en la consola de Firebase (Realtime Database → Reglas → pegar el contenido del
  archivo → Publicar). Repetir cada vez que el archivo cambie. No asumir que el archivo del repo
  y lo publicado coinciden sin confirmarlo ahí.
- **Firebase Authentication:** Email/Password habilitado, con una sola cuenta creada a mano para
  arrancar (el super admin, `SUPER_ADMIN_EMAIL` en el backend debe coincidir con su email
  exacto). Cuentas adicionales se crean desde `Admins.tsx` en el panel, nunca a mano después de
  la primera.
- **App Check:** no configurado. Si en algún momento se activa, recordar que NO reemplaza las
  Rules ni la autorización del backend — es una capa adicional contra abuso de bots/scripts, no
  el control de acceso en sí (ver `SECURITY.md`).

## Headers de seguridad — qué se puede y qué no se puede configurar hoy

Ambos frontends son estáticos en GitHub Pages, que no permite fijar headers HTTP personalizados.
Lo que SÍ se logró vía `<meta>` (ver `index.html` de ambos repos): `Content-Security-Policy`,
`Referrer-Policy`. Lo que **requiere** una capa adicional (ej. Cloudflare delante de GitHub
Pages, o migrar a un host que sí permita headers):

```
[ ] X-Frame-Options / frame-ancestors real (protección contra clickjacking)
[ ] Strict-Transport-Security (HSTS)
[ ] X-Content-Type-Options: nosniff
[ ] Permissions-Policy
```

Esto es una decisión de infraestructura pendiente del dueño del proyecto, no una tarea de código
— documentado aquí para que no se pierda, no para bloquear el deploy actual.

## Checklist previo a un deploy de producción

```
[ ] WHATSAPP_APP_SECRET configurado en Render (o se acepta que el webhook quede cerrado)
[ ] NODE_ENV=production presente en Render (ya en render.yaml — confirmar en el dashboard)
[ ] Reglas de Firebase publicadas en la consola coinciden con firebase/database.rules.json
[ ] .env NUNCA commiteado (verificar git status antes de push)
[ ] npm audit revisado si se tocaron dependencias
[ ] Build del panel (`npm run build`) sin errores de TypeScript
[ ] Las tres piezas (sitio, backend, panel) probadas juntas, no cada una por separado
```
