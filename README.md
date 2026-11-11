# seller-psicologos

Sistema que busca psicólogos en Argentina, les escribe por WhatsApp, conversa con ellos, agenda reuniones en Google Calendar y te avisa cuando hay alguien listo para cerrar. Incluye un hub web para supervisar todo y aprobar cambios de manual y de mensajes de apertura.

Servicios (Docker Compose): `db` (PostgreSQL 16), `worker` (WhatsApp + agentes), `hub` (panel web en el puerto 3000) y, opcional, `cloudflared` (acceso 24/7).

El **Buscador** corre aparte, en tu Mac y sin Docker: un agente de Claude busca psicólogos con un navegador y los guarda en `data/prospectos.json`. El worker los toma de ahí. No necesita claves.

## Requisitos

- Docker y Docker Compose v2.
- Un número de WhatsApp para vincular (ver riesgos al final).
- Cuentas gratuitas: Google AI Studio (Gemini) y Groq (para el Vendedor y el Analista), Google Cloud (Calendar y Gmail).
- En la Mac, para el Buscador: Node 24, Google Chrome y [Claude Code](https://claude.com/claude-code) instalado y logueado (`claude`).

## Pasos

### 1) Completar `content/*.md`
Editá `apertura.md`, `estilo.md`, `manual-ventas.md` y `producto-crm.md` con tu producto, tu estilo de escritura y el manual de ventas. Es lo que usan los agentes.

### 2) API keys gratuitas (Gemini y Groq)
- Gemini: https://aistudio.google.com/apikey -> `GOOGLE_GENERATIVE_AI_API_KEY`
- Groq: https://console.groq.com/keys -> `GROQ_API_KEY`

### 3) Buscador (en tu Mac)
No necesita claves. Con Claude Code logueado:
```
npm install
npm run buscador            # una corrida: hasta 10 psicólogos nuevos en data/prospectos.json
```
Para que corra solo cada hora, instalá el `launchd` como explica [`src/agents/buscador/README.md`](src/agents/buscador/README.md). El worker importa el archivo cada 10 minutos y el hub lo muestra en `/pipeline`.

### 4) Google OAuth (Calendar y Gmail)
Primero creá tu `.env`: `cp .env.example .env`.

1. En Google Cloud creá un "ID de cliente OAuth" de tipo aplicación web, con redirect URI `http://localhost:5555/callback`. Habilitá Calendar API y Gmail API.
2. Poné `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en `.env`.
3. Corré `npm install && npm run google:auth`, abrí la URL que imprime, autorizá y copiá el `GOOGLE_REFRESH_TOKEN` que aparece en la terminal.

### 5) Completar `.env`
Completá con valores reales antes de levantar nada:
- `OWNER_WA_ID`: tu número real en formato internacional sin `+` (ej. `5491155551234`). Ahí llegan los avisos.
- `HUB_PASSWORD`: una contraseña fuerte (el valor de ejemplo `cambiame` no sirve).
- Las keys de los pasos 2 y 4.
- `DNC_MODE`: `file` (con `DNC_FILE` apuntando al listado del registro No Llame) u `off`. Con `off` el hub muestra una advertencia permanente.

`DATABASE_URL` y `TZ` los fija `docker-compose.yml` (base `db`, zona `America/Argentina/Buenos_Aires`).

### 6) Levantar
```
docker compose up -d --build
```

### 7) Vincular WhatsApp
Abrí http://localhost:3000/sistema (usuario `HUB_USER`, contraseña `HUB_PASSWORD`), y escaneá el QR desde WhatsApp > Dispositivos vinculados > Vincular un dispositivo. La sesión queda guardada en el volumen `wa_auth`.

### 8) Acceso 24/7 con Cloudflare Tunnel
Creá un túnel en Cloudflare Zero Trust apuntando a `http://hub:3000`, poné el token en `CLOUDFLARE_TUNNEL_TOKEN` y corré:
```
docker compose --profile tunnel up -d
```
Como el hub queda expuesto a internet, la contraseña fuerte es obligatoria.

### 9) Pasar a modelos pagos
Editá `LLM_VENDEDOR` y `LLM_ANALISTA` en `.env` (el Buscador usa Claude Code y no depende de esto): lista `proveedor:modelo` separada por comas, en orden de fallback (ej. `anthropic:claude-sonnet-4-5,google:gemini-2.5-flash`). Cargá la key del proveedor (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL`) y reiniciá: `docker compose up -d`. Si usás Ollama en tu máquina, `localhost` no funciona dentro del contenedor: poné `OLLAMA_BASE_URL=http://host.docker.internal:11434/v1`.

### 10) Trámites
- Registro "No Llame" (AAIP): inscribite/descargá el listado y guardalo como `data/no_llame.csv` (la carpeta `data/` se monta en el worker como `/app/data`) y usá `DNC_MODE=file` con `DNC_FILE=/app/data/no_llame.csv`.
- Registro de la base de datos personales ante la AAIP según la Ley 25.326, ya que guardás datos de contactos.

### 11) Riesgos asumidos
- Usar un WhatsApp personal para mensajes automatizados puede terminar en el bloqueo (ban) del número. Por eso el sistema limita a 5 contactos nuevos por día y los espacia. Preferí un número que puedas perder.
- Los proveedores de IA gratuitos (Gemini, Groq) pueden usar los datos enviados para entrenar sus modelos. Los mensajes de los prospectos pasan por ellos (el Buscador usa Claude Code, no ellos).

## Backups
La sesión de WhatsApp (volumen `wa_auth`) y la base (volumen `pgdata`) viven en volúmenes de Docker. Los psicólogos encontrados por el Buscador están en `data/prospectos.json` (no se sube a GitHub). Resguardalos periódicamente, por ejemplo `docker compose exec db pg_dump -U seller seller > backup.sql` y copiando el volumen `wa_auth` con un contenedor temporal (`tar`). Si perdés `wa_auth` hay que volver a escanear el QR.

## Comandos útiles
```
docker compose ps
docker compose logs -f worker
docker compose stop worker      # frenar los envíos
npm test && npm run typecheck
```
