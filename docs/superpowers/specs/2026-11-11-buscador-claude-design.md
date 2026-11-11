# Buscador con agente de Claude: diseño

Fecha: 2026-11-11 · Reemplaza al diseño [`2026-11-07-buscador-navegador-design.md`](2026-11-07-buscador-navegador-design.md) en lo que respecta a cómo se busca y dónde se guarda.

## Intención

Lauri quiere que el agente 1 (Buscador) funcione **sin claves ni configuración de terceros**: nada de Google Places, Gemini, Groq, ni elegir motor de búsqueda. La búsqueda la hace un **agente de Claude** (`claude -p`, con la sesión de Claude ya logueada en la Mac) que navega en un navegador como lo haría una persona. Lo que encuentra se guarda en un **archivo `.json`** con los psicólogos y sus datos de contacto. Ese archivo se ve en el hub local y alimenta al siguiente agente (el Vendedor).

## Objetivos

- `npm run buscador` en la Mac (sin Docker) lanza el agente de Claude, que busca, navega y devuelve psicólogos con nombre, celular y email.
- También puede correr solo **cada hora** (launchd de macOS).
- El resultado se agrega a `data/prospectos.json`, sin duplicados.
- El hub muestra el contenido de ese archivo en `/pipeline`.
- El worker (Docker) toma los psicólogos nuevos del `.json`, hace los chequeos que requieren WhatsApp y la ley, y los carga a la base como `encontrado` para que el Vendedor les escriba.

## No objetivos

- **No** se reemplaza Postgres. La base sigue igual para todo lo demás (Vendedor, mensajes, cola, reuniones, Analista). El `.json` guarda **solo psicólogos y sus datos de contacto**.
- **No** se cambia cómo el Vendedor, la Agenda ni el Analista usan la IA (siguen con `LLM_VENDEDOR` / `LLM_ANALISTA`).
- **No** se corre el agente de Claude dentro de Docker.

## Anti-objetivos (sería un fracaso aunque "funcione")

- Que aparezcan **números inventados** en el `.json`.
- Que se le escriba a alguien del **Registro No Llame**, que pidió la baja o que no tiene WhatsApp.
- Que el agente use el **Chrome personal** de Lauri, entre a redes sociales, resuelva CAPTCHAs, complete formularios o haga login.
- Que dos corridas pisen el archivo o lo dejen corrupto.
- Que vuelva a hacer falta cargar claves o variables para que el Buscador funcione.

## Cómo funciona

### 1. Corrida en la Mac (`npm run buscador`)

Script nuevo `src/buscador.ts` (reemplaza a `buscador-ahora.ts` y `buscador-prueba.ts`):

1. **Candado:** si hay otra corrida en curso (`data/buscador.lock` con un PID vivo), sale sin hacer nada. Así la corrida por hora no se superpone con una manual.
2. **Ciudad del día:** lee `data/buscador-estado.json` (`{ ciudad: <índice en CITIES> }`), toma esa ciudad de `cities.ts` y al terminar avanza a la siguiente (vuelve a la primera al llegar al final).
3. **Lanza Claude:** `claude -p` con:
   - el prompt armado desde `content/buscador-instrucciones.md` (reescrito para un agente que navega) + las consultas de `content/buscador-consultas.md` con `{ciudad}`/`{provincia}` reemplazados + la lista de celulares ya guardados para esa ciudad (para que no pierda tiempo en ellos),
   - navegador: **Playwright MCP** (`@playwright/mcp`, versión fija) vía `--mcp-config` + `--strict-mcp-config`, con perfil propio `browser_profile/` (nunca el Chrome de Lauri),
   - `--allowedTools` limitado a las herramientas del navegador (sin Bash, sin escribir archivos),
   - `--output-format json` + `--json-schema` con la forma `{ psicologos: [{ nombre, celular, email?, pagina }] }`,
   - un tope de turnos y un tiempo máximo (el proceso se mata si se pasa).
4. **Tope por corrida:** se le pide un máximo de **10 psicólogos nuevos** por corrida (constante en código; se puede pasar otro número como argumento: `npm run buscador -- 20`). Con corridas cada hora alcanza de sobra.
5. **Filtra en código** cada resultado, descartando al que:
   - por el nombre es un equipo (`looksLikeTeam`: centro, instituto, equipo, fundación, clínica, asociación),
   - no tiene un celular argentino válido (`toWaId`),
   - viene de una red social (lista negra de dominios),
   - **ya está en el `.json`** (mismo `waId`),
   - **anti-invención:** el código descarga la `pagina` con un `fetch` simple y verifica que el número figure en el texto o en los links `tel:`/`wa.me` (la misma regla de hoy: mismo número normalizado). Si la página no se puede descargar o no figura, se descarta.
6. **Guarda:** agrega los que pasan a `data/prospectos.json` con escritura atómica (archivo temporal + rename).
7. **Informe:** imprime en consola un resumen (encontrados, guardados, descartes por motivo) y lo agrega a `data/buscador-corridas.json` (últimas 50 corridas), para que el hub lo muestre.

Si `claude` no está instalado o no está logueado, el script lo dice claramente y sale con error.

### 2. Formato de `data/prospectos.json`

```json
[
  {
    "nombre": "Lic. Ana Gómez",
    "celular": "+54 9 351 555-1234",
    "waId": "5493515551234",
    "email": "ana@ejemplo.com",
    "ciudad": "Córdoba",
    "provincia": "Córdoba",
    "pagina": "https://…",
    "encontradoEl": "2026-11-11T14:00:00.000Z"
  }
]
```

`email` solo si aparece. El archivo lo escribe **solo** el script de la Mac.

### 3. Corrida cada hora

`scripts/buscador.launchd.plist` (plantilla) + instrucciones en el README para instalarla con `launchctl`. Ejecuta `npm run buscador` en el repo cada 3600 s y deja el log en `data/buscador.log`. Sin variables de entorno nuevas.

### 4. Del `.json` a la base (worker)

El paso `buscador` del Orquestador se reemplaza por **`importar`**:

- Cada 10 minutos (sin `SEARCH_HOUR`), corre en segundo plano como la corrida de hoy (por las pausas de WhatsApp), y una sola a la vez.
- Lee `/app/data/prospectos.json` (ya montado en solo lectura). Si no existe, no hace nada.
- Para cada psicólogo que todavía **no** fue procesado (no está en `prospects` por `waId` ni en el registro de descartes `kv: importador_descartados`):
  - baja (`opt_outs`) → descarte,
  - **No Llame** → descarte; **si falta el archivo No Llame no importa a nadie** (como hoy),
  - número sin WhatsApp recordado (60 días) → se saltea,
  - tope diario de consultas a WhatsApp (`BUSCADOR_MAX_WA_CHECKS`, 150) y pausa de 2 a 6 s antes de cada consulta (se conservan tal cual),
  - sin WhatsApp → se recuerda 60 días,
  - si pasa todo: `insertProspect` con estado `encontrado`, `source: 'claude'` y `source_ref` = `pagina`.
- Registra un evento `buscador_import` (revisados, cargados, descartes por motivo, consultas a WhatsApp, motivo de corte).

Se reutiliza la lógica de `processContact` de `run.ts` (filtros, contador diario de WhatsApp, memoria de "sin WhatsApp", corte por apagado).

**Bajas (Ley 25.326):** cuando alguien pide la baja, sus datos se borran de la base (como hoy) y también tienen que salir del `.json`. Como el `.json` lo escribe solo la Mac, el worker publica la lista de números dados de baja en `data/bajas.json` (para eso el montaje `./data` del worker pasa a lectura y escritura, y el worker escribe solo ese archivo). Al arrancar cada corrida, el script de la Mac borra del `.json` a esos números y nunca los vuelve a agregar. La demora máxima es de una hora.

### 5. Hub

- `docker-compose.yml`: el servicio `hub` monta `./data:/app/data:ro`.
- `/pipeline` suma una sección **"Buscador"** con:
  - total de psicólogos en el `.json`, cargados a la base, descartados (por motivo) y pendientes,
  - la tabla de los últimos encontrados (nombre, celular, email, ciudad, link, fecha, estado: pendiente / en la base / descartado),
  - la última corrida de `data/buscador-corridas.json` y la última importación (`buscador_import`).

### 6. Lo que se elimina

| Qué | Dónde |
|---|---|
| Google Places | `sources.ts`, `GOOGLE_PLACES_KEY`, `config.googlePlacesKey` |
| Motores y CAPTCHA | `engines.ts` (se conserva solo la lista negra de dominios), `BUSCADOR_ENGINE` |
| Navegador propio | `browser.ts`, `robots.ts`, dependencia `playwright`, instalación de Chromium en el `Dockerfile`, volumen `browser_profile`, `BUSCADOR_PROFILE_DIR` |
| IA del Buscador | `LLM_BUSCADOR`, `extractContacts` (se conservan `looksLikeTeam`, la verificación de celular en la página, `loadQueries`, `fillQuery`, `loadInstructions`) |
| Topes del navegador | `BUSCADOR_MAX_SEARCHES`, `BUSCADOR_MAX_PAGES`, `BUSCADOR_RESULTS_PER_QUERY`, `BUSCADOR_SEARCH_DELAY`, `BUSCADOR_PAGE_DELAY`, `BUSCADOR_MAX_PER_DAY`, `SEARCH_HOUR` |
| Scripts viejos | `buscador-ahora.ts`, `buscador-prueba.ts`, `npm run buscador:prueba` |

Se conserva: `BUSCADOR_MAX_WA_CHECKS` (protege el número de WhatsApp en el worker).

`AgentName` en `llm.ts` pierde `'buscador'`. Las claves de Gemini/Groq siguen en `.env.example` porque las usan el Vendedor y el Analista.

### 7. Documentación a actualizar

`README.md`, `Business.MD` (ficha del Buscador, tabla de comunicación, mapa), `CONFIGURACION.md` (§2, §3, §9, checklist), `src/agents/buscador/README.md` y `.env.example`, para que describan el nuevo flujo y no mencionen las claves ni variables eliminadas.

## Decisiones mías (revisar)

- **Playwright MCP** como navegador del agente (open source, sin claves, perfil propio). Se descarga con `npx` la primera vez.
- **Un `.json` único** con la lista, no un archivo por psicólogo.
- **Una ciudad por corrida** y **10 nuevos** como tope por corrida.
- **Anti-invención con `fetch`**: el código vuelve a bajar la página para confirmar el número. Puede descartar algún caso válido en páginas que arman el texto con JavaScript; se prefiere eso a guardar un número inventado.
- El worker revisa el `.json` **cada 10 minutos**.
- Se borran los scripts `buscador:prueba` y `buscador-ahora`: el nuevo `npm run buscador` ya corre local y es la prueba.
- Los descartes del worker se guardan en `kv`, no en `data/`.
- **Bajas vía `data/bajas.json`**: el worker solo escribe ese archivo y la Mac limpia el `.json` en cada corrida.

## Lo que queda para quien implemente

- Redacción final del prompt del agente en `content/buscador-instrucciones.md`.
- Tope exacto de turnos y tiempo máximo de `claude -p`.
- Diseño visual de la sección del hub, siguiendo el estilo existente de `/pipeline`.
- Ajustar las pruebas (`tests/buscador*.test.ts`) al flujo nuevo, con un `claude` falso inyectado.
