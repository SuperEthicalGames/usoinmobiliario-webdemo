# Email Worker — Uso Inmobiliario

Función serverless (Cloudflare Workers) que recibe los datos de una reserva desde
`index.html` y envía el correo real usando **Amazon SES**, aprovechando que el dominio
`usoinmobiliario.com` ya está verificado en una cuenta de AWS (se confirmó porque su
registro MX ya apunta a `inbound-smtp.us-east-1.amazonaws.com`).

Por qué existe esta pieza separada: un secreto (las credenciales de AWS) **nunca** puede
vivir en el JavaScript de `index.html` — cualquiera que abra el sitio vería el código
fuente. Este Worker es la única parte del sistema que conoce esas credenciales; el sitio
web solo le manda un `fetch()` con los datos de la reserva, nunca con nada secreto.

## Qué necesitas antes de desplegar

1. **Cuenta de Cloudflare** (gratis) — https://dash.cloudflare.com/sign-up
2. **Acceso a la cuenta de AWS** que administra `usoinmobiliario.com` (la que ya tiene SES
   configurado para ese dominio).

## Paso 1 — Confirmar/activar SES en AWS

1. Entra a la [consola de Amazon SES](https://console.aws.amazon.com/ses/), región
   **us-east-1** (N. Virginia — la misma que ya usa el MX record).
2. Ve a **Verified identities** → confirma que `usoinmobiliario.com` aparece como
   **Verified**. Si no lo está, créala ahí y agrega los registros DNS que te indique
   (TXT + 3 CNAME de DKIM) en Route 53 (el DNS del dominio ya vive ahí).
3. Ve a **Account dashboard** → revisa el recuadro de **Sending statistics**:
   - Si dice que la cuenta está en **Sandbox**, haz clic en **Request production access**
     (formulario corto: tipo de correo = "Transactional", caso de uso = confirmaciones de
     reserva de un sitio de alojamiento, volumen esperado = unos cientos al mes). AWS
     suele aprobar esto en pocas horas para casos legítimos como este.
   - Mientras esté en Sandbox, SES solo deja enviar a direcciones que también estén
     verificadas individualmente — no sirve todavía para clientes reales.
4. (Recomendado) En la identidad `usoinmobiliario.com`, pestaña **Authentication**,
   confirma que **DKIM** esté habilitado — mejora muchísimo que el correo no caiga en spam.

## Paso 2 — Crear un usuario IAM dedicado (nunca uses las credenciales raíz de AWS)

1. Ve a **IAM → Users → Create user** (ej. `ses-email-worker`).
2. **Attach policy directly** → **Create policy** → pestaña JSON, pega esto (reemplaza la
   cuenta/región si aplica):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["ses:SendEmail", "ses:SendRawEmail"],
         "Resource": "*",
         "Condition": {
           "StringEquals": { "ses:FromAddress": "reservas@usoinmobiliario.com" }
         }
       }
     ]
   }
   ```
   Esto limita al usuario a **solo enviar correo, solo desde esa dirección** — no puede
   leer nada, no puede tocar ningún otro servicio de AWS.
3. En **Security credentials** del usuario → **Create access key** → elige "Application
   running outside AWS" → copia el **Access Key ID** y el **Secret Access Key** (este
   último solo se muestra una vez).

## Paso 3 — Desplegar el Worker

Desde esta carpeta (`email-worker/`):

```bash
npm install
npx wrangler login
```

Esto abre el navegador para conectar tu cuenta de Cloudflare. Luego configura los secretos
(nunca van en `wrangler.toml`, que sí queda en el repositorio):

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
npx wrangler secret put APP_SHARED_SECRET
```

(`APP_SHARED_SECRET` puede ser cualquier cadena aleatoria larga — es solo un freno anti-bot
de baja fricción, no la protección real; genera una con `openssl rand -hex 32` o similar.)

Despliega:

```bash
npx wrangler deploy
```

Al terminar, Wrangler imprime la URL pública del Worker (algo como
`https://uso-inmobiliario-email.<tu-subdominio>.workers.dev`). **Copia esa URL** — hay que
pegarla en `EMAIL_WORKER_URL` dentro de `index.html` (buscar ese nombre en el archivo) junto
con el mismo valor de `APP_SHARED_SECRET` que configuraste arriba.

## Qué NO hace este Worker (a propósito)

- No guarda nada — no toca Firebase, no es una segunda fuente de verdad. Solo reenvía un
  correo y devuelve éxito/error.
- No reintenta envíos fallidos por su cuenta — si SES rechaza el envío, el Worker responde
  con error y `index.html` ya sabe mostrar "no pudimos enviar el correo" sin romper la
  reserva (la reserva ya estaba guardada en Firebase antes de siquiera llamar aquí).
- No maneja rebotes/quejas de spam (bounces/complaints) — para un volumen pequeño de un
  negocio no es crítico al inicio; si el volumen crece, lo siguiente a agregar sería un
  SNS topic de SES para monitorear eso, no algo que haga falta ahora.
