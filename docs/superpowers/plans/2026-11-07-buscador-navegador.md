# Buscador con navegador: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el Buscador encuentre psicólogos buscando en Google/DuckDuckGo con un Chromium headless y guarde solo nombre, celular y email.

**Architecture:** Piezas chicas detrás de interfaces inyectables (navegador, motores de búsqueda, robots, extracción) que `runBuscador` orquesta con un cursor ciudad + consulta + página y presupuestos por corrida. El Orquestador lanza la corrida en segundo plano. Las instrucciones de la IA y las consultas viven en `content/` para que Lauri las edite sin tocar código.

**Tech Stack:** TypeScript (Node 24, ESM, `tsx`), Playwright (Chromium), Vitest, zod, `ai` SDK vía `Llm`, PostgreSQL/PGlite.

**Spec:** `docs/superpowers/specs/2026-11-07-buscador-navegador-design.md`

## Global Constraints

- Cero APIs pagas. Places solo si hay `GOOGLE_PLACES_KEY`.
- Ficha: `name`, `phone_raw`/`wa_id`, `email`, `city`, `province`, `source` (`google` | `duckduckgo` | `google_places`), `source_ref` (URL exacta de la página; id del lugar para Places), `status = 'encontrado'`. Sin columnas nuevas.
- Orden de filtros por contacto: equipo (nombre) → sin teléfono → duplicado → baja → No Llame → tope WhatsApp → sin WhatsApp → insertar.
- Sin archivo No Llame no se guarda a nadie (igual que hoy).
- Lista negra de dominios: linkedin.com, facebook.com, instagram.com, x.com, twitter.com, tiktok.com, youtube.com.
- Palabras de equipo en el nombre (sin distinguir mayúsculas ni acentos): centro, instituto, equipo, fundación, clínica, asociación.
- Defaults: `BUSCADOR_MAX_PER_DAY=50`, `BUSCADOR_MAX_SEARCHES=25`, `BUSCADOR_MAX_PAGES=150`, `BUSCADOR_RESULTS_PER_QUERY=10`, `BUSCADOR_SEARCH_DELAY=20-60` (s), `BUSCADOR_PAGE_DELAY=3-8` (s), `BUSCADOR_ENGINE=google`, `BUSCADOR_MAX_WA_CHECKS=150`, máximo 3 páginas de resultados por consulta.
- Timeout por página: 15 s. Locale `es-AR`, zona `config.tz`. Perfil persistente en `/app/browser_profile`.
- No resolver ni esquivar CAPTCHAs. No entrar a páginas con login ni completar formularios.
- Cortar por tope, CAPTCHA, falta de IA o cancelación = final normal (no lanza). Solo errores inesperados lanzan.

## Review Focus

1. La IA devuelve un celular que no está en la página (inventado) → se descarta (test en Task 4).
2. El mismo número aparece dos veces en una página o en dos páginas → se guarda una vez, el resto cuenta como `duplicado` (test en Task 5).
3. El worker se reinicia a mitad de corrida → el cursor ya quedó guardado tras cada consulta terminada (test en Task 5).
4. En la base quedó el cursor viejo (un número) → se interpreta como `{ city: n, query: 0, page: 1 }` (test en Task 5).
5. Una página no carga o tarda más de 15 s → se saltea y la corrida sigue (test en Task 5).

## Desvío consciente respecto del spec

- **"Descartar fijos con libphonenumber" no es confiable en Argentina:** un celular escrito sin 9/15 es indistinguible de un fijo. No se descarta por tipo; la protección del número de Lauri es el tope `BUSCADOR_MAX_WA_CHECKS`. Avisar a Lauri al cerrar.
- Las plantillas de consultas van en `content/buscador-consultas.md` (no en `queries.ts`) y las instrucciones de extracción en `content/buscador-instrucciones.md`, para que Lauri las edite sin tocar código (pedido explícito).

---

### Task 1: Configuración

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: en `Config`:
  ```ts
  buscador: {
    maxSearches: number; maxPages: number; resultsPerQuery: number; maxWaChecks: number;
    searchDelayMs: [number, number]; pageDelayMs: [number, number];
    engine: 'google' | 'duckduckgo'; profileDir: string;
  }
  ```
  (`buscadorMaxPerDay` se queda donde está.) `profileDir` sale de `BUSCADOR_PROFILE_DIR`, default `browser_profile`.

- [ ] **Step 1: Tests** en `tests/config.test.ts`:
  - `buscador: defaults` → `{ maxSearches: 25, maxPages: 150, resultsPerQuery: 10, maxWaChecks: 150, searchDelayMs: [20000, 60000], pageDelayMs: [3000, 8000], engine: 'google', profileDir: 'browser_profile' }`.
  - `buscador: rango "5-10" → [5000, 10000]`.
  - `buscador: rango inválido "10-5" o "abc" lanza` con mensaje que nombra la variable.
  - `buscador: BUSCADOR_ENGINE=bing lanza`.
- [ ] **Step 2:** `npx vitest run tests/config.test.ts` → FAIL.
- [ ] **Step 3:** Implementar en `loadConfig` con un helper local `range(k, def: [number, number]): [number, number]` (segundos `"a-b"` → ms, `0 <= a <= b`).
- [ ] **Step 4:** Agregar las variables nuevas a `.env.example` con comentario de una línea cada una, debajo de `BUSCADOR_MAX_PER_DAY`.
- [ ] **Step 5:** `npx vitest run tests/config.test.ts` → PASS.
- [ ] **Step 6:** Commit `feat(buscador): configuración del buscador con navegador`.

---

### Task 2: Navegador (Playwright) e imagen Docker

**Files:**
- Create: `src/agents/buscador/browser.ts`
- Modify: `package.json` (dep `playwright`), `Dockerfile`, `docker-compose.yml`
- Test: `tests/buscador-browser.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PageSnapshot = { url: string; text: string; links: { href: string; text: string }[] };
  export interface Browser {
    open(url: string): Promise<PageSnapshot>; // lanza si no carga en 15 s o status >= 400
    close(): Promise<void>;
  }
  export function launchBrowser(o: { profileDir: string; tz: string }): Promise<Browser>;
  export function createFakeBrowser(pages: Record<string, PageSnapshot | Error>): Browser & { opened: string[] };
  ```
  `url` del snapshot = URL final tras redirecciones. `links` con `href` absoluto.

- [ ] **Step 1: Test** `fake browser: devuelve snapshot, registra opened y lanza para Error o URL desconocida`.
- [ ] **Step 2:** FAIL → implementar `createFakeBrowser` → PASS.
- [ ] **Step 3:** `npm i playwright` (versión exacta en el lock). Implementar `launchBrowser` con `chromium.launchPersistentContext(profileDir, { headless: true, locale: 'es-AR', timezoneId: tz })`, una sola página reutilizada, `goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' })`, texto con `document.body.innerText`, links con `a[href]` → `{ href: a.href, text: a.innerText.trim() }`. Sin test automático (se verifica a mano en Task 6).
- [ ] **Step 4:** `Dockerfile`: antes de `USER node`, `ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` y `RUN npx playwright install --with-deps chromium`; crear `/app/browser_profile` con dueño `node`. `docker-compose.yml`: volumen `browser_profile:/app/browser_profile` en `worker` y en `volumes:`; `BUSCADOR_PROFILE_DIR: /app/browser_profile` en `environment` del worker.
- [ ] **Step 5:** `npm run typecheck` → sin errores. `docker compose build worker` → termina OK.
- [ ] **Step 6:** Commit `feat(buscador): navegador Chromium headless con perfil propio`.

---

### Task 3: Motores de búsqueda y robots.txt

**Files:**
- Create: `src/agents/buscador/engines.ts`, `src/agents/buscador/robots.ts`
- Test: `tests/buscador-engines.test.ts`

**Interfaces:**
- Consumes: `PageSnapshot` (Task 2).
- Produces:
  ```ts
  export type EngineName = 'google' | 'duckduckgo';
  export interface SearchEngine {
    name: EngineName;
    searchUrl(query: string, page: number): string; // page empieza en 1
    parseResults(s: PageSnapshot): string[];        // URLs orgánicas, sin repetir, en orden
    isBlocked(s: PageSnapshot): boolean;            // CAPTCHA / "tráfico inusual"
  }
  export const ENGINES: Record<EngineName, SearchEngine>;
  export function isBlacklisted(url: string): boolean; // lista negra de Global Constraints, incluye subdominios
  export function createRobotsChecker(fetchFn?: typeof fetch): { allowed(url: string): Promise<boolean> };
  ```

- [ ] **Step 1: Tests:**
  - `google searchUrl` → `https://www.google.com/search?q=psic%C3%B3logo%20Rosario&hl=es-419&gl=ar&start=10` para `('psicólogo Rosario', 2)`.
  - `google parseResults` con snapshot de ejemplo: descarta links a `google.*`, `/search`, `webcache`; desarma `/url?q=`; quita repetidos.
  - `google isBlocked` → true si `url` contiene `/sorry/` o el texto contiene "tráfico inusual" o "unusual traffic".
  - `duckduckgo searchUrl` → `https://html.duckduckgo.com/html/?q=...` (con `&s=${(page-1)*30}` si page > 1); `parseResults` decodifica `uddg=` de `duckduckgo.com/l/?uddg=...`.
  - `isBlacklisted('https://ar.linkedin.com/in/x') === true`, `isBlacklisted('https://ana-psicologa.com') === false`.
  - `robots: Disallow /privado bajo User-agent * → /privado/x false, /otra true`; `robots: 404 o error de red → true`; `robots: un fetch por dominio` (caché).
- [ ] **Step 2:** FAIL → implementar. El parser de robots solo necesita grupos `User-agent: *` y prefijos `Disallow`/`Allow` (gana el prefijo más largo). Timeout de fetch 5 s.
- [ ] **Step 3:** `npx vitest run tests/buscador-engines.test.ts` → PASS.
- [ ] **Step 4:** Commit `feat(buscador): motores Google/DuckDuckGo y robots.txt`.

---

### Task 4: Extracción de contactos e instrucciones editables

**Files:**
- Create: `src/agents/buscador/extract.ts`, `content/buscador-instrucciones.md`, `content/buscador-consultas.md`
- Test: `tests/buscador-extract.test.ts`

**Interfaces:**
- Consumes: `PageSnapshot`, `Llm` (`src/llm/llm.ts`).
- Produces:
  ```ts
  export type Contact = { name: string; phone: string; email?: string };
  export function hasPhoneHint(s: PageSnapshot): boolean;
  export function looksLikeTeam(name: string): boolean;
  export function loadInstructions(contentDir: string): string;           // lee buscador-instrucciones.md; si falta, DEFAULT_INSTRUCTIONS
  export function loadQueries(contentDir: string): string[];              // lee buscador-consultas.md; si falta o vacío, DEFAULT_QUERIES
  export function fillQuery(tpl: string, q: { city: string; province: string }): string; // reemplaza {ciudad} y {provincia}
  export function extractContacts(s: PageSnapshot, deps: { llm: Llm; instructions: string }): Promise<Contact[]>;
  ```
  `extractContacts` deja propagar `AllProvidersFailedError`; cualquier otro error de la IA → `[]`.

- [ ] **Step 1: Contenido.** `content/buscador-consultas.md`: comentario HTML explicando el formato (una consulta por línea, `{ciudad}` y `{provincia}`, líneas vacías y `#` se ignoran) y las 5 plantillas del spec. `content/buscador-instrucciones.md`: el prompt de extracción. Debe decir: devolver solo psicólogos/as personas con nombre y celular textuales de la página, email si aparece, no inventar ni completar, ignorar centros/institutos/equipos, una entrada por persona. Copiarlo también como `DEFAULT_INSTRUCTIONS` y las plantillas como `DEFAULT_QUERIES` en `extract.ts`.
- [ ] **Step 2: Tests:**
  - `hasPhoneHint`: true con texto "Tel: 351 15-612-3456", con link `tel:`, con link `wa.me/549...`; false con un texto sin números de 8+ dígitos.
  - `looksLikeTeam('Centro de Psicología Norte') === true`, `('Lic. Clínica Pérez')`: true (palabra suelta), `('Lic. Ana Gómez') === false`, `('FUNDACION X') === true` (sin acento).
  - `loadQueries` ignora vacías y `#`; si el archivo no existe devuelve `DEFAULT_QUERIES`.
  - `fillQuery('psicólogo {ciudad} {provincia}', { city: 'Rosario', province: 'Santa Fe' }) === 'psicólogo Rosario Santa Fe'`.
  - `extractContacts` manda a la IA el texto de la página **más** los `href` de links `tel:`/`mailto:`/`wa.me`, recortado a 12.000 caracteres; usa `agent: 'buscador'` y `system` = instrucciones.
  - **Review Focus 1:** `extractContacts descarta un celular que no aparece en la página` (comparando solo dígitos de los últimos 8 contra los dígitos del texto + links).
  - `extractContacts deja pasar AllProvidersFailedError`; `otro error → []`.
- [ ] **Step 3:** FAIL → implementar (schema zod `{ contacts: { name, phone, email? }[] }`). → PASS.
- [ ] **Step 4:** Commit `feat(buscador): extracción de contactos con instrucciones editables`.

---

### Task 5: Corrida nueva (`runBuscador`)

**Files:**
- Modify: `src/agents/buscador/run.ts` (reescritura), `src/agents/buscador/sources.ts` (sin cambios de interfaz)
- Delete: `src/agents/buscador/enrich.ts`
- Test: `tests/buscador.test.ts` (quitar tests de `enrichFromWebsite`, reescribir los de corrida)

**Interfaces:**
- Consumes: Tasks 1–4; `toWaId`, repo (`getProspectByWaId`, `insertProspect`, `isOptedOut`, `kvGet`, `kvSet`, `logEvent`), `reportDncStatus`, `CITIES`.
- Produces:
  ```ts
  export type StopReason = 'tope_prospectos' | 'tope_busquedas' | 'tope_paginas' | 'tope_whatsapp'
    | 'captcha' | 'sin_ia' | 'cancelado' | 'sin_no_llame' | 'fin';
  export type BuscadorResult = {
    found: number; inserted: number; skipped: Record<string, number>;
    searches: number; pages: number; waChecks: number;
    engine: EngineName | null; captcha: boolean; stopReason: StopReason;
  };
  export type BuscadorCursor = { city: number; query: number; page: number };
  export type BuscadorDeps = {
    db: Db; llm: Llm; dnc: DncChecker; wa: Pick<WaTransport, 'hasWhatsApp'>;
    sources: ProspectSource[];                       // Places (opcional)
    openBrowser?: () => Promise<Browser>;            // sin esto, solo fuentes
    engines: SearchEngine[];                         // principal primero, respaldo después
    robots: { allowed(url: string): Promise<boolean> };
    notifyOwner: (text: string) => Promise<unknown>;
    contentDir: string;
    config: Pick<Config, 'buscadorMaxPerDay' | 'buscador'>;
    sleep?: (ms: number) => Promise<void>;           // default setTimeout; tests: no-op
    random?: () => number;
  };
  export function runBuscador(deps: BuscadorDeps, now: Date, signal?: AbortSignal): Promise<BuscadorResult>;
  ```

- [ ] **Step 1: Tests** (fake browser con páginas de resultados y de psicólogos, fake LLM, `sleep` no-op). Reusar `mkDeps` del archivo actual adaptado:
  - `sin No Llame → stopReason 'sin_no_llame', no abre el navegador`.
  - `guarda nombre, celular, email, ciudad, source 'google', source_ref = URL de la página, status encontrado`.
  - `filtros en orden: equipo, sin_telefono, duplicado, opt_out, no_llame, sin_whatsapp` (un contacto para cada uno, `skipped` exacto).
  - **Review Focus 2:** `mismo número en dos páginas → 1 insertado, 1 duplicado`.
  - `salta dominios de la lista negra y URLs con robots prohibido sin abrirlas` (`opened` no las contiene).
  - `página sin indicio de teléfono no llama a la IA`.
  - **Review Focus 5:** `página que lanza al abrir → skipped.pagina_error y sigue con la siguiente`.
  - `tope_prospectos`, `tope_busquedas`, `tope_paginas`, `tope_whatsapp`: cada uno corta con su `stopReason` y no excede el límite.
  - `CAPTCHA en google → avisa a Lauri una vez, sigue con duckduckgo (engine 'duckduckgo', captcha true)`; `CAPTCHA en los dos → stopReason 'captcha'`, devuelve sin lanzar.
  - `AllProvidersFailedError → stopReason 'sin_ia'`, devuelve sin lanzar.
  - `signal abortado → 'cancelado'` y cierra el navegador.
  - `cierra el navegador siempre`, también si algo lanza.
  - **Review Focus 3:** `cursor guardado tras cada consulta terminada` (la segunda consulta corta por tope → kv `buscador_cursor` = `{ city: 0, query: 1, page: 1 }`).
  - `al pasar la última ciudad, page sube a 2; después de 3 vuelve a 1`.
  - **Review Focus 4:** `cursor viejo numérico 3 → arranca en { city: 3, query: 0, page: 1 }`.
  - `Places se consulta solo al empezar una ciudad (query 0, page 1)` y sus contactos usan `source 'google_places'`, `source_ref` = id.
  - `evento buscador_run con found, inserted, skipped, searches, pages, waChecks, engine, captcha, stopReason`.
- [ ] **Step 2:** `npx vitest run tests/buscador.test.ts` → FAIL.
- [ ] **Step 3: Implementar.** Algoritmo (lo no obvio):
  ```
  si !reportDncStatus → fin 'sin_no_llame'
  cursor = leer kv (número viejo → {city:n, query:0, page:1}; inválido → {0,0,1})
  queries = loadQueries(contentDir); instructions = loadInstructions(contentDir)
  browser = openBrowser?.()   (try/finally browser.close())
  engineIdx = 0; visited = Set
  bucle hasta un corte (lanzar Stop(reason) interno y atraparlo):
    abortado → Stop('cancelado')
    city = CITIES[cursor.city]
    si cursor.query == 0 y cursor.page == 1: procesar fuentes (Places) de la ciudad
    si hay browser:
      si searches >= maxSearches → Stop('tope_busquedas')
      snap = browser.open(engine.searchUrl(fillQuery(queries[cursor.query], city), cursor.page)); searches++
      si engine.isBlocked(snap):
        captcha = true; si es el primer bloqueo de la corrida → notifyOwner(aviso)
        engineIdx++; si no quedan motores → Stop('captcha'); si no, reintentar esta misma consulta
      urls = parseResults(snap) sin lista negra ni visited, primeros resultsPerQuery
      por url: pages >= maxPages → Stop('tope_paginas'); robots → saltar; sleep(pageDelay)
               abrir (error → skip 'pagina_error'); pages++; visited.add
               si !hasPhoneHint → seguir; contactos = extractContacts (AllProvidersFailedError → Stop('sin_ia'))
               por contacto: procesarContacto(contacto, engine.name, snap.url)
    avanzar cursor (query++ → city++ → page = page >= 3 ? 1 : page+1), kvSet, sleep(searchDelay)
    sin browser y se recorrió toda la lista de ciudades una vez → Stop('fin')
  procesarContacto: inserted >= max → Stop('tope_prospectos') ANTES de procesar;
    looksLikeTeam → 'equipo'; toWaId → 'sin_telefono'; duplicado; opt_out; no_llame;
    waChecks >= maxWaChecks → Stop('tope_whatsapp'); waChecks++; hasWhatsApp → 'sin_whatsapp'; insertProspect
  siempre: logEvent('buscador_run', {...result, at})
  ```
  Aviso de CAPTCHA: `⚠️ Google pidió CAPTCHA al Buscador. Sigo con DuckDuckGo por hoy.` (o `… Corto la búsqueda de hoy y retomo mañana.` si no hay respaldo). Los delays usan `random` dentro del rango de config. Borrar `enrich.ts` y sus imports.
- [ ] **Step 4:** `npx vitest run tests/buscador.test.ts` → PASS. `npm run typecheck` → OK.
- [ ] **Step 5:** Commit `feat(buscador): corrida con navegador, cursor y presupuestos`.

---

### Task 6: Orquestador en segundo plano y conexión en el worker

**Files:**
- Modify: `src/orchestrator/orchestrator.ts`, `src/worker.ts`
- Test: `tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: `runBuscador`, `launchBrowser`, `ENGINES`, `createRobotsChecker`.
- Produces: `OrchestratorDeps.runBuscador: (now: Date, signal: AbortSignal) => Promise<unknown>`; el orquestador expone además `stop(): void` (aborta la corrida en curso). `idle()` **no** espera a la corrida del Buscador.

- [ ] **Step 1: Tests** en `tests/orchestrator.test.ts` (ajustar los tres tests de buscador existentes a la nueva semántica):
  - `buscador corre en segundo plano: el tick termina aunque runBuscador no haya resuelto` (promesa pendiente controlada por el test; el paso `responder` del mismo tick corre).
  - `no lanza una segunda corrida mientras hay una en curso`.
  - `al resolver, marca buscador_last_date = hoy`.
  - `si rechaza: logEvent error con paso buscador, alerta tras 3 fallas seguidas y backoff de 30 min` (mismo comportamiento que hoy, en diferido).
  - `stop() aborta el signal pasado a runBuscador`.
- [ ] **Step 2:** FAIL → implementar: extraer de `step` dos helpers `recordSuccess(paso)` y `recordFailure(paso, e, now)` y usarlos también en el `.then/.catch` de la corrida en segundo plano. Estado: `buscadorRun: Promise<void> | null`, `buscadorAbort: AbortController | null`.
- [ ] **Step 3:** `src/worker.ts`: construir deps de `runBuscador` con `openBrowser: () => launchBrowser({ profileDir: config.buscador.profileDir, tz: config.tz })`, `engines` = `[ENGINES[config.buscador.engine], el otro]`, `robots: createRobotsChecker()`, `notifyOwner: (t) => gateway.enqueueToOwner(t)`, `contentDir: config.contentDir`. En `shutdown` llamar `orch.stop()` antes de `orch.idle()`. Actualizar el log de inicio: `buscador=navegador+places` / `navegador`.
- [ ] **Step 4:** `npm test` → todo PASS. `npm run typecheck` → OK.
- [ ] **Step 5: Verificación manual** (corrida real con tope bajo): `.env` con `BUSCADOR_MAX_PER_DAY=3 BUSCADOR_MAX_SEARCHES=2`, `docker compose up -d --build worker`, forzar la corrida borrando `buscador_last_date` de `kv`, y revisar en el hub/`events` el `buscador_run` y los prospectos nuevos con `source_ref` = URL. Anotar el resultado.
- [ ] **Step 6:** Commit `feat(buscador): corrida en segundo plano desde el orquestador`.

---

### Task 7: Documentación

**Files:**
- Create: `src/agents/buscador/README.md`
- Modify: `Business.MD` (Parte 1 §1 y tabla de pendientes), `CONFIGURACION.md` (variables nuevas)

- [ ] **Step 1:** `src/agents/buscador/README.md`: qué hace el agente en 5 líneas, mapa de archivos (uno por línea con su responsabilidad), **qué editar para cambiar qué** (consultas → `content/buscador-consultas.md`; instrucciones de la IA → `content/buscador-instrucciones.md`; ciudades → `cities.ts`; lista negra y palabras de equipo → `engines.ts` / `extract.ts`; ritmo y topes → `.env`), y cómo forzar una corrida.
- [ ] **Step 2:** `Business.MD` §1: reemplazar Función/Qué entrega/Qué NO puede hacer por la versión con navegador y ficha mínima; quitar el enriquecimiento; Estado ✅.
- [ ] **Step 3:** `CONFIGURACION.md`: tabla de variables `BUSCADOR_*` con defaults.
- [ ] **Step 4:** Commit `docs(buscador): guía del agente y configuración`.
