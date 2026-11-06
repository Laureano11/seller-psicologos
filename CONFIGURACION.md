# Configuración pendiente

Checklist de todo lo que tenés que configurar vos para que el sistema funcione de verdad.
Todo se carga en el archivo `.env`, en la raíz del repo. Ese archivo **nunca se sube a GitHub**.
Copiá `.env.example` como `.env` y completalo.

```bash
cp .env.example .env
```

---

## 1. Datos obligatorios (sin estos no arranca)

| Variable | Qué poner |
|---|---|
| `OWNER_WA_ID` | Tu número de WhatsApp en formato internacional, sin `+` ni espacios. Ej: `5491123456789`. A este número te llegan los avisos. |
| `OWNER_NAME` | Cómo firmás (por defecto `Lauri`). |
| `HUB_USER` | Usuario para entrar al hub. |
| `HUB_PASSWORD` | Contraseña fuerte, mínimo 10 caracteres. El hub va a estar en internet: no uses una fácil. Generá una con `openssl rand -base64 18`. |

## 2. Modelos de IA (gratis)

Necesitás al menos una de las dos claves; lo ideal son las dos, para tener respaldo.

| Variable | Dónde se saca |
|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | https://aistudio.google.com/apikey → "Create API key" (Gemini, plan gratuito). |
| `GROQ_API_KEY` | https://console.groq.com/keys → "Create API Key" (gratuito). |

Para elegir qué modelo usa cada agente están `LLM_BUSCADOR`, `LLM_VENDEDOR` y `LLM_ANALISTA`.
El formato es una lista `proveedor:modelo` separada por comas; el orden es el orden de respaldo.

**Para pasar a modelos pagos más adelante:**
1. Completá `ANTHROPIC_API_KEY` o `OPENROUTER_API_KEY`.
2. Cambiá esas líneas, por ejemplo: `LLM_VENDEDOR=anthropic:claude-sonnet-5-5,google:gemini-2.5-flash`.

No hay que tocar código.

## 3. Google Places (Buscador)

1. Entrá a https://console.cloud.google.com, creá un proyecto (o usá uno existente) y activá la facturación. Google da un crédito mensual gratuito que alcanza de sobra para ~50 búsquedas por día.
2. En "APIs y servicios" → "Biblioteca", activá **Places API (New)**.
3. En "Credenciales" → "Crear credenciales" → "Clave de API". Restringila a Places API.
4. Pegala en `GOOGLE_PLACES_KEY`.

Sin esta clave, el buscador no encuentra psicólogos nuevos.

## 4. Google Calendar + Gmail (Agenda)

Esto es para que el agente agende reuniones en tu calendario y mande el mail de confirmación desde tu cuenta.

1. En el mismo proyecto de Google Cloud, activá **Google Calendar API** y **Gmail API**.
2. En "Pantalla de consentimiento de OAuth":
   - Elegí tipo **Externo**.
   - Agregá tu mail como **usuario de prueba**.
   - Pasá la app a **"En producción"** para que el token no venza a los 7 días.
3. En "Credenciales" → "Crear credenciales" → "ID de cliente de OAuth":
   - Tipo **"Aplicación web"**.
   - URI de redirección autorizado: `http://localhost:5555/callback`
4. Copiá el ID y el secreto en `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.
5. En tu Mac corré `npm install` (una sola vez) y después `npm run google:auth`. Se abre el navegador; autorizá con tu cuenta.
6. La consola te muestra el `GOOGLE_REFRESH_TOKEN`: pegalo en `.env`.
7. `GOOGLE_CALENDAR_ID` puede quedar en `primary` (tu calendario principal).

## 5. Registro No Llame (obligatorio por ley en Argentina)

La Ley 26.951 prohíbe contactar con fines comerciales a quienes están inscriptos en el Registro No Llame.

1. Registrate como usuario en la AAIP: https://www.argentina.gob.ar/aaip/nollame
2. Descargá el listado de números.
3. Guardalo como `data/no_llame.csv`. Puede tener un número por línea o varios separados por comas o punto y coma; el formato se normaliza solo.
4. En `.env` dejá `DNC_MODE=file`.

Con `DNC_MODE=off` el sistema funciona igual, pero el hub muestra una advertencia permanente y el riesgo legal es tuyo.

Además, por la Ley 25.326 (datos personales) conviene inscribir la base de datos en la AAIP.

## 6. Contenido de ventas (`content/*.md`)

Hoy son plantillas. Reemplazalas con tu contenido real:

| Archivo | Qué contiene |
|---|---|
| `content/producto-crm.md` | Todo sobre tu CRM: funciones, precio, planes, preguntas frecuentes. Si algo no está acá, el agente te escala la pregunta. |
| `content/manual-ventas.md` | Tus métodos y patrones de venta. |
| `content/estilo.md` | Tu forma de escribir, explicada en detalle, con ejemplos de mensajes reales tuyos. |
| `content/apertura.md` | El primer mensaje que se manda a cada psicólogo. |

Los cambios se toman al reiniciar el worker: `docker compose restart worker`.

## 7. Elegir el servidor y dejar el hub online 24/7

El sistema corre con Docker en cualquier servidor Linux con Docker. Alcanza con 1 GB de RAM; mejor 2 GB.
Opciones baratas: Hetzner (CX22), DigitalOcean, Oracle Cloud Free Tier (gratis), o una PC propia siempre prendida.

En el servidor:

```bash
git clone https://github.com/Laureano11/seller-psicologos.git
cd seller-psicologos
# copiá tu .env y data/no_llame.csv (por ejemplo con scp)
docker compose up -d --build db worker hub
```

### Hub accesible desde internet (Cloudflare Tunnel, gratis)

1. Creá una cuenta en https://dash.cloudflare.com. Necesitás un dominio agregado a Cloudflare.
2. Andá a Zero Trust → Networks → Tunnels → "Create a tunnel" (tipo Cloudflared).
3. Copiá el token y pegalo en `CLOUDFLARE_TUNNEL_TOKEN`.
4. En "Public Hostname" configurá, por ejemplo, `hub.tudominio.com` → servicio `http://hub:3000`.
5. Levantá el túnel: `docker compose --profile tunnel up -d`

Recomendado: en Zero Trust → Access, agregá una política que pida tu mail. Así suma una segunda capa además de la contraseña.

## 8. Vincular WhatsApp

1. Con el worker corriendo, entrá al hub → **Sistema** (`/sistema`).
2. En tu celular: WhatsApp → Dispositivos vinculados → Vincular dispositivo → escaneá el QR.
3. La sesión queda guardada en el volumen `wa_auth`. Si se desvincula, el hub te muestra un QR nuevo.

Recordá que usar WhatsApp personal con automatización va contra los términos de WhatsApp y puede terminar en un bloqueo del número. Es el riesgo que decidiste asumir; el límite de 5 contactos nuevos por día lo reduce.

## 9. Ajustes opcionales (ya tienen valores por defecto)

| Variable | Defecto | Qué controla |
|---|---|---|
| `DAILY_NEW_CONTACTS` | 5 | Psicólogos nuevos contactados por día. |
| `SEND_WINDOW` | `mon-fri 09:00-20:00` | Horario en que se mandan mensajes. |
| `MEETING_WINDOW` | `mon-fri 10:00-18:00` | Horario en que se ofrecen reuniones. |
| `MEETING_MINUTES` | 30 | Duración de cada reunión. |
| `SEARCH_HOUR` | 9 | Hora en que corre el buscador. |
| `BUSCADOR_MAX_PER_DAY` | 50 | Máximo de prospectos nuevos por día. |
| `FOLLOWUP_DAYS` / `MAX_FOLLOWUPS` | 3 / 1 | Cuándo y cuántas veces se hace seguimiento si no responden. |
| `CLOSE_AFTER_DAYS` | 4 | Días sin respuesta tras el seguimiento antes de marcar "sin respuesta". |
| `AB_MIN_PER_VARIANT` | 30 | Contactos mínimos por variante antes de proponer un cambio A/B. |
| `REPLY_DEBOUNCE_SECONDS` | 30 | Cuánto espera el vendedor por si el psicólogo manda varios mensajes seguidos. |

## Checklist final

- [ ] `.env` con `OWNER_WA_ID`, `HUB_PASSWORD` fuerte y al menos una clave de IA
- [ ] `GOOGLE_PLACES_KEY`
- [ ] OAuth de Google + `npm run google:auth` → `GOOGLE_REFRESH_TOKEN`
- [ ] `data/no_llame.csv` + `DNC_MODE=file`
- [ ] `content/*.md` con tu contenido real
- [ ] Servidor elegido + `docker compose up -d --build db worker hub`
- [ ] Cloudflare Tunnel con tu dominio
- [ ] QR escaneado en `/sistema`
- [ ] Revisar `/pipeline` para ver que todo circule
