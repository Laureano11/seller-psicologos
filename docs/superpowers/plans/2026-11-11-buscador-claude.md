# Buscador con agente de Claude: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el Buscador corra en la Mac con `claude -p` + navegador, guarde psicólogos en `data/prospectos.json`, y que el worker los importe a la base.

**Architecture:** Script local `src/buscador.ts` → `corrida.ts` (lógica pura, con `claude` y `fetch` inyectados) → `archivo.ts` (JSON atómico). En el worker, `importar.ts` (derivado de `run.ts`) reemplaza a la corrida del navegador y el Orquestador lo lanza cada 10 min. El hub lee los archivos de `data/`.

**Tech Stack:** Node 24 + TypeScript (tsx), vitest, Claude Code CLI (`claude -p --json-schema`), `@playwright/mcp@0.0.83` vía `npx`.

**Spec:** [`docs/superpowers/specs/2026-11-11-buscador-claude-design.md`](../specs/2026-11-11-buscador-claude-design.md)

## Global Constraints

- Sin claves ni variables nuevas para el Buscador. Única variable que queda: `BUSCADOR_MAX_WA_CHECKS` (150).
- Tope por corrida: 10 nuevos (argumento opcional `npm run buscador -- N`).
- Importación cada 10 min; pausa 2–6 s antes de cada consulta a WhatsApp; "sin WhatsApp" se recuerda 60 días.
- Sin archivo No Llame (`DNC_MODE=file`) no se importa a nadie.
- `data/prospectos.json` lo escribe solo la Mac; `data/bajas.json` solo el worker. Escritura atómica (tmp + rename).
- Perfil de navegador propio `browser_profile/`, nunca el Chrome de Lauri. Herramientas de Claude limitadas a `mcp__playwright`.

## Review Focus

- `prospectos.json` inexistente, vacío o corrupto → se trata como lista vacía (Mac) / no importa nada (worker), sin caerse.
- Claude no instalado, sin sesión o con salida no-JSON → error claro y sale con código ≠ 0, sin tocar el `.json`.
- Número de Claude que no figura en la página descargada → descartado (`no_en_pagina`).
- Mismo número dos veces en una corrida → se guarda una vez.
- Número en `bajas.json` → se borra del `.json` y no se vuelve a agregar.

---

### Task 1: Archivos JSON (`archivo.ts`)

**Files:** Create `src/agents/buscador/archivo.ts`; Test `tests/buscador-archivo.test.ts`

**Interfaces — Produces:**
- `type Psicologo = { nombre: string; celular: string; waId: string; email?: string; ciudad: string; provincia: string; pagina: string; encontradoEl: string }`
- `readJson<T>(file: string, fallback: T): T` (inexistente o inválido → fallback)
- `writeJsonAtomic(file: string, value: unknown): void`
- `PROSPECTOS_FILE = 'prospectos.json'`, `BAJAS_FILE = 'bajas.json'`, `ESTADO_FILE = 'buscador-estado.json'`, `CORRIDAS_FILE = 'buscador-corridas.json'`

Tests: lectura de archivo inexistente/corrupto devuelve fallback; escritura + lectura roundtrip; no queda `.tmp`.

### Task 2: Corrida en la Mac (`corrida.ts`, `claude.ts`, `src/buscador.ts`)

**Files:** Create `src/agents/buscador/corrida.ts`, `src/agents/buscador/claude.ts`, `src/buscador.ts`, `scripts/buscador.launchd.plist`; Modify `src/agents/buscador/extract.ts` (quitar IA, sumar `phoneInText`, `BLACKLIST`/`isBlacklisted` desde `engines.ts`); Test `tests/buscador-corrida.test.ts`, `tests/buscador-extract.test.ts`

**Interfaces — Produces:**
- `type Hallazgo = { nombre: string; celular: string; email?: string; pagina: string }`
- `type ClaudeRunner = (prompt: string) => Promise<Hallazgo[]>`
- `buildPrompt(a: { instructions: string; queries: string[]; city: {city; province}; max: number; conocidos: string[] }): string`
- `createClaudeRunner(o: { profileDir: string; timeoutMs: number; maxTurns: number }): ClaudeRunner` — `spawn('claude', ['-p', prompt, '--output-format','json','--json-schema', SCHEMA, '--mcp-config', JSON, '--strict-mcp-config', '--allowedTools','mcp__playwright', '--max-turns', N])`; parsea `structured_output` (o `result` como JSON).
- `runCorrida(d: { dataDir; contentDir; claude: ClaudeRunner; fetchPage: (url) => Promise<string>; max: number; now: Date }): Promise<CorridaResult>` con `CorridaResult = { ciudad: string; hallados: number; guardados: number; descartes: Record<string, number>; borradosPorBaja: number; at: string }`
- `phoneInText(text: string, phone: string): boolean` en `extract.ts`

Orden de filtros en `runCorrida`: `equipo` → `sin_telefono` → `red_social` → `baja` → `duplicado` → `no_en_pagina` (fetch falla o el número no está). Guarda, avanza el cursor de ciudad, agrega el resultado a `buscador-corridas.json` (máx 50).

Tests (con `ClaudeRunner` y `fetchPage` falsos, `dataDir` temporal): guarda uno válido con todos los campos; descarta cada motivo; no duplica dentro de la corrida ni contra el archivo; borra los de `bajas.json`; avanza la ciudad y da la vuelta; si `claude` lanza, el `.json` queda intacto y la ciudad no avanza; respeta `max`.

`src/buscador.ts`: candado `data/buscador.lock` (PID vivo → sale 0 con mensaje), arg `max` (default 10), imprime resumen, borra el candado en `finally`.

### Task 3: Importador en el worker + Orquestador

**Files:** Create `src/agents/buscador/importar.ts` (desde `run.ts`); Delete `run.ts`, `sources.ts`, `engines.ts`, `browser.ts`, `robots.ts`, `src/buscador-ahora.ts`, `src/buscador-prueba.ts`, tests viejos del buscador; Modify `src/orchestrator/orchestrator.ts`, `src/worker.ts`, `src/config.ts`, `src/llm/llm.ts`, `src/db/repo.ts` (`listOptOutWaIds`); Test `tests/buscador-importar.test.ts`, `tests/orchestrator.test.ts`, `tests/config.test.ts`

**Interfaces — Produces:**
- `runImportador(d: { db; dnc; wa: Pick<WaTransport,'hasWhatsApp'>; dataDir; config: Pick<Config,'buscador'>; sleep?; random? }, now: Date, signal?: AbortSignal): Promise<ImportResult>` con `ImportResult = { revisados; cargados; descartes: Record<string,number>; waChecks; stopReason: 'fin'|'tope_whatsapp'|'cancelado'|'sin_no_llame' }`; evento `buscador_import`; descartes permanentes en `kv: importador_descartados` (`{ [waId]: motivo }`); escribe `bajas.json` con `listOptOutWaIds`.
- Orquestador: dep `runImportador(now, signal)`; paso `importar` cada 10 min, en segundo plano, uno a la vez. Se quitan `searchHour`, `buscador_last_date`, `forceBuscadorToday`.
- Config: `buscador: { maxWaChecks }`, `dataDir` (default `data`); se quitan `searchHour`, `buscadorMaxPerDay`, `googlePlacesKey`, `llm.buscador`, `BUSCADOR_ENGINE` y demás `BUSCADOR_*`.

Tests: importa válido como `encontrado` con `source 'claude'`; saltea ya en base; opt-out/No Llame → descarte registrado y no se reconsulta; sin WhatsApp → recordado; tope de WhatsApp corta; sin archivo No Llame no importa; escribe `bajas.json`. Orquestador: lanza al primer tick, no relanza antes de 10 min, sí después; en segundo plano; `stop()` aborta.

### Task 4: Hub, Docker, contenido y documentación

**Files:** Modify `src/hub/pipeline.tsx`, `docker-compose.yml`, `Dockerfile`, `package.json`, `.env.example`, `content/buscador-instrucciones.md`, `content/buscador-consultas.md`, `README.md`, `Business.MD`, `CONFIGURACION.md`, `src/agents/buscador/README.md`; Test `tests/pipeline.test.ts`

- `loadPipelineData` suma `buscadorArchivo: { total; enBase; descartados: Record<string,number>; pendientes; ultimos: (Psicologo & { estado: 'pendiente'|'en la base'|'descartado' })[]; ultimaCorrida: CorridaResult | null }` leyendo `config.dataDir`; la vista muestra una sección "Buscador" con tabla de los últimos 20.
- Compose: worker `./data:/app/data` (rw), hub `./data:/app/data:ro`, sin `browser_profile`. Dockerfile sin Playwright. `package.json`: sin `playwright`, `buscador` → `tsx src/buscador.ts`, sin `buscador:prueba`.
- Test: pipeline con un `prospectos.json` de 2 entradas (una en base) muestra totales y estados.

Verificación final: `npx vitest run` y `npx tsc --noEmit` en verde; `npm run buscador -- 2` real en la Mac.
