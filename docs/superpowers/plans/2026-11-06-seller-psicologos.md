# Seller automatizado para psicólogos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un sistema 24/7 que encuentra psicólogos argentinos, les escribe por el WhatsApp personal de Lauri, conversa para vender su CRM, escala a Lauri cuando hace falta, aprende de los resultados y se supervisa desde un hub web.

**Architecture:** Un solo proyecto TypeScript (ESM) con dos procesos: `worker` (WhatsApp vía Baileys, agentes, orquestador con tick cada minuto) y `hub` (Hono con JSX server-side). Ambos comparten PostgreSQL. Todo acceso a modelos de IA pasa por una capa `Llm` multi-proveedor con fallback, configurable por agente vía variables de entorno. Servicios externos (WhatsApp, Google, Places, LLM) están detrás de interfaces con fakes para tests.

**Tech Stack:** Node 24, TypeScript, `tsx`, `vitest`, PostgreSQL 16 (`pg`; tests con `@electric-sql/pglite`), Vercel AI SDK (`ai`, `@ai-sdk/google`, `@ai-sdk/groq`, `@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`), `zod`, `baileys`, `googleapis`, `libphonenumber-js`, `luxon`, `hono`, `@hono/node-server`, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-11-06-seller-psicologos-design.md`

**Desvíos del spec (decisiones del planificador, el spec las deja abiertas):** Hono+JSX en vez de Next.js para el hub (menos piezas, un solo build). Baileys en vez de navegador headless (más liviano en VPS; el spec deja la librería al constructor). El Orquestador es código determinístico (scheduler), no un LLM: supervisa y notifica sin costo de modelo ni riesgo de alucinación.

## Global Constraints

- Mercado Argentina, todo texto visible y prompts en español rioplatense. Zona horaria `America/Argentina/Buenos_Aires`.
- Máximo **5 contactos nuevos por día** (`DAILY_NEW_CONTACTS=5`), espaciados al menos 30 min entre sí.
- Envíos solo en ventana `SEND_WINDOW` (default lun–vie 09:00–20:00); reuniones en `MEETING_WINDOW` (default lun–vie 10:00–18:00), duración `MEETING_MINUTES=30`.
- Buscador a las `SEARCH_HOUR=9` todos los días; máximo `BUSCADOR_MAX_PER_DAY=50` prospectos nuevos.
- Lista blanca a nivel código: solo se procesan mensajes entrantes de números que existen en `prospects`; mensajes de otros números no se guardan ni se pasan a ningún agente. Solo se envía a prospectos permitidos o al propio número de Lauri (`OWNER_WA_ID`).
- Nunca escribir a: prospectos en `baja`, `rechazado`, `listo_para_cerrar`, `descartado`, con `handed_off=true`, o en `opt_outs`.
- Ningún cambio de manual o de mensaje de apertura se activa sin aprobación en el hub.
- Umbral A/B: `AB_MIN_PER_VARIANT=30` contactos por variante y p<0.05 para "confirmado"; si no, "tendencia" o "insuficiente".
- Ningún agente llama a un proveedor de IA directamente: todo por `Llm`. Config por agente: `LLM_BUSCADOR`, `LLM_VENDEDOR`, `LLM_ANALISTA` = lista separada por comas de `proveedor:modelo` (orden = fallback).
- Registro "No Llame": `DNC_MODE=file|off`. Con `file` se exige `DNC_FILE`; con `off` el hub muestra una advertencia permanente.
- Secretos solo por variables de entorno; `.env` en `.gitignore`.
- Estados de prospecto (exactos): `encontrado, contactado, conversando, interesado, reunion_agendada, listo_para_cerrar, rechazado, sin_respuesta, baja, descartado`.

## Review Focus

1. Mensaje entrante de un contacto personal de Lauri (no prospecto): debe ignorarse por completo, sin guardarse ni responderse → test en Task 3.
2. Lauri escribe a mano desde su celular en el chat de un prospecto: el sistema debe marcar `handed_off` y dejar de escribir → test en Task 3.
3. Todos los proveedores gratuitos responden límite de uso: no se envía nada, la conversación queda pendiente y se notifica → tests en Task 2 y Task 5.
4. El prospecto manda varios mensajes seguidos: una sola respuesta tras una pausa (debounce), no una por mensaje → test en Task 7.
5. El modelo propone agendar un horario que no fue ofrecido o sin mail: no se agenda; se pide el dato → test en Task 5.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, .env.example
src/config.ts                  Config tipada desde env
src/time.ts                    Ventanas horarias y nextSendTime
src/phone.ts                   Normalización a wa_id
src/db/db.ts                   Interfaz Db + pg + pglite
src/db/schema.sql              Esquema
src/db/repo.ts                 Repositorios (prospects, messages, outbox, escalations, faq, opt-outs, manuals, variants, proposals, meetings, events, kv)
src/dnc.ts                     Registro No Llame
src/llm/llm.ts                 Capa Llm + fallback + fake
src/whatsapp/transport.ts      Interfaz + fake
src/whatsapp/baileys.ts        Transporte real
src/whatsapp/gateway.ts        Lista blanca, outbox, toma de control
src/agents/buscador/*.ts       Fuentes, enriquecimiento, runBuscador, ciudades
src/agents/vendedor/*.ts       Conocimiento, decisión, apertura, entrantes, seguimientos, escalaciones
src/agents/agenda/*.ts         Calendar/Gmail + slots
src/learning/*.ts              Estadísticas, A/B, análisis semanal, propuestas
src/orchestrator/*.ts          Tick, notificaciones, salud
src/worker.ts                  Entrypoint worker
src/hub/*.tsx                  App Hono
src/hub/server.ts              Entrypoint hub
content/*.md                   Manual ventas, producto, estilo, apertura (placeholders)
scripts/google-auth.ts         Obtener refresh token
Dockerfile, docker-compose.yml, README.md
tests/**                       vitest
```

---

### Task 1: Fundaciones — proyecto, config, DB, repos, teléfono, horarios, No Llame

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (incluye `node_modules`, `dist`, `.env`, `.superpowers/`, `wa_auth/`), `.env.example`, `src/config.ts`, `src/time.ts`, `src/phone.ts`, `src/db/db.ts`, `src/db/schema.sql`, `src/db/repo.ts`, `src/dnc.ts`, `content/manual-ventas.md`, `content/producto-crm.md`, `content/estilo.md`, `content/apertura.md`
- Test: `tests/phone.test.ts`, `tests/time.test.ts`, `tests/repo.test.ts`, `tests/dnc.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces:
  - `type Status = 'encontrado'|'contactado'|'conversando'|'interesado'|'reunion_agendada'|'listo_para_cerrar'|'rechazado'|'sin_respuesta'|'baja'|'descartado'`; `const BLOCKED_STATUSES: Status[] = ['baja','rechazado','listo_para_cerrar','descartado']`.
  - `loadConfig(env: Record<string,string|undefined>): Config` — `Config` incluye: `databaseUrl, tz, dailyNewContacts, sendWindow: Window, meetingWindow: Window, meetingMinutes, searchHour, buscadorMaxPerDay, followupDays (3), closeAfterDays (4), maxFollowups (1), abMinPerVariant, ownerWaId, ownerName ('Lauri'), dncMode, dncFile?, llm: {buscador: string[], vendedor: string[], analista: string[]}, googlePlacesKey?, google?: {clientId, clientSecret, refreshToken, calendarId ('primary')}, hubUser, hubPassword, contentDir ('content'), waAuthDir ('wa_auth'), replyDebounceSeconds (30)`. Lanza `Error` si falta `DATABASE_URL`, `OWNER_WA_ID`, `HUB_PASSWORD`, o si `DNC_MODE=file` sin `DNC_FILE`.
  - `type Window = { days: number[] /*1=lun..7=dom*/; start: string /*'HH:mm'*/; end: string }`; `parseWindow('mon-fri 09:00-20:00'): Window`.
  - `isInWindow(now: Date, w: Window, tz: string): boolean`; `nextSendTime(now: Date, w: Window, tz: string): Date` (now si está dentro, si no el próximo inicio de ventana).
  - `toWaId(raw: string): string|null` — dígitos E.164 sin `+`.
  - `interface Db { query<T=any>(sql: string, params?: unknown[]): Promise<T[]>; exec(sql: string): Promise<void>; close(): Promise<void> }`; `createPgDb(url): Db`; `createMemoryDb(): Promise<Db>`; `migrate(db): Promise<void>` (ejecuta `schema.sql`, idempotente).
  - Repo (`src/db/repo.ts`), todas `async` y reciben `db` primero:
    - `insertProspect(db, p: NewProspect): Promise<Prospect|null>` (null si `wa_id` duplicado), `getProspect(db,id)`, `getProspectByWaId(db, waId)`, `updateProspect(db, id, patch: Partial<Prospect>)`, `setStatus(db, id, status, reason?)`, `listProspectsForHub(db): Promise<Prospect[]>` (orden: `needs_attention` no nulo primero, luego `listo_para_cerrar`, luego `updated_at desc`), `pickContactable(db, limit): Promise<Prospect[]>` (status `encontrado`, `wa_id` no nulo, no en opt_outs, más antiguos primero), `countContactedSince(db, since: Date): Promise<number>`.
    - `addMessage(db, m: {prospectId, direction:'in'|'out', author:'prospect'|'agent'|'lauri', body, waMessageId?})`, `listMessages(db, prospectId)`.
    - `enqueueOutbox(db, o: {prospectId: number|null, toWaId, body, kind:'prospect'|'self', sendAfter: Date}): Promise<number>`, `dueOutbox(db, now): Promise<OutboxItem[]>`, `markOutboxSent(db, id, waMessageId)`, `markOutboxFailed(db, id, error)`.
    - `createEscalation(db, prospectId, question)`, `answerEscalationRow(db, id, answer)`, `listOpenEscalations(db)`, `getEscalation(db,id)`.
    - `addFaq(db, question, answer)`, `listFaq(db)`.
    - `isOptedOut(db, waId)`, `applyOptOut(db, prospectId, reason)` — inserta en `opt_outs`, status `baja`, anonimiza (name='(baja)', email/phone_raw/website null, borra sus `messages`).
    - `getActiveManual(db, kind:'ventas'|'producto'|'estilo'): Promise<string>`, `addManualVersion(db, kind, content, source:'archivo'|'propuesta'): Promise<number>` (desactiva la anterior), `listManualVersions(db, kind)`.
    - `listVariants(db, status?)`, `addVariant(db, template, status:'activa'|'candidata', proposalId?)`, `setVariantStatus(db, id, status:'activa'|'candidata'|'retirada')`.
    - `addProposal(db, p:{kind:'apertura_nueva'|'promover_apertura'|'manual', summary, evidence, proposedContent, targetId?: number})`, `listProposals(db, status?)`, `decideProposal(db, id, status:'aprobada'|'rechazada')`, `getProposal(db,id)`.
    - `addMeeting(db, m)`, `listUpcomingMeetings(db, now)`.
    - `logEvent(db, type: string, payload: object)`, `listEvents(db, limit)`, `kvGet<T>(db, key): Promise<T|undefined>`, `kvSet(db, key, value)`.
  - `interface DncChecker { isBlocked(waId: string): Promise<boolean> }`; `createDncChecker(config): DncChecker` (`file`: lee CSV/TXT de números, normaliza con `toWaId`; `off`: siempre false).
  - `seedKnowledge(db, contentDir)`: si no hay versión activa de cada manual, carga `manual-ventas.md`/`producto-crm.md`/`estilo.md`; si no hay variante activa, carga `apertura.md` como variante `activa`.

**Schema (`src/db/schema.sql`)** — tablas: `prospects` (id serial pk, name, phone_raw, wa_id unique, email, city, province, address, website, source, source_ref, profile_urls jsonb default '[]', practice_type text default 'desconocido', tools_signals, fit_notes, attributes jsonb default '{}', status text default 'encontrado', status_reason, needs_attention text null, handed_off bool default false, opener_variant_id int, followups_sent int default 0, evaluation jsonb default '{}', tags jsonb default '{"objections":[]}', contacted_at, last_inbound_at, last_outbound_at, created_at, updated_at timestamptz default now()), `messages`, `outbox`, `escalations`, `faq`, `opt_outs` (wa_id pk), `manual_versions`, `opener_variants`, `proposals` (con `target_id int null`), `meetings`, `events`, `kv` (key pk, value jsonb). Columnas en snake_case; el repo mapea a camelCase.

- [ ] **Step 1:** `git init`, scaffold de proyecto (ESM, `"type":"module"`, scripts `test`, `typecheck`, `worker`, `hub`), instalar dependencias de Task 1 (`pg`, `@electric-sql/pglite`, `libphonenumber-js`, `luxon`, `zod`, dev: `typescript`, `tsx`, `vitest`, `@types/*`).
- [ ] **Step 2: Tests que fallan**
```ts
// tests/phone.test.ts
expect(toWaId('+54 9 11 2345-6789')).toBe('5491123456789');
expect(toWaId('011 15 2345-6789')).toBe('5491123456789');
expect(toWaId('(0351) 15 555-1234')).toBe('5493515551234');
expect(toWaId('hola')).toBeNull();
// tests/time.test.ts (tz Buenos Aires, ventana lun-vie 09:00-20:00)
isInWindow(new Date('2026-11-09T13:00:00-03:00'), w, tz) === true   // lunes 13h
isInWindow(new Date('2026-11-08T13:00:00-03:00'), w, tz) === false  // domingo
nextSendTime(new Date('2026-11-06T21:30:00-03:00'), w, tz).toISOString() === new Date('2026-11-09T09:00:00-03:00').toISOString() // vie noche -> lun 9h
// tests/repo.test.ts (createMemoryDb + migrate)
insertProspect duplicado por wa_id -> null
applyOptOut -> isOptedOut true, status 'baja', name '(baja)', listMessages vacío
pickContactable excluye opt-outs y wa_id null
listProspectsForHub pone needs_attention primero
addManualVersion deja solo una activa por kind
seedKnowledge carga 3 manuales y 1 variante activa; segunda llamada no duplica
// tests/dnc.test.ts
archivo con '11 2345-6789' -> isBlocked('5491123456789') true; off -> false
// tests/config.test.ts
DNC_MODE=file sin DNC_FILE -> throw; defaults dailyNewContacts=5, searchHour=9
```
- [ ] **Step 3:** Correr `npx vitest run` → FAIL.
- [ ] **Step 4:** Implementar los archivos listados. Contenido placeholder en `content/*.md` con encabezados en español indicando qué debe completar Lauri (`apertura.md`: guía breve para el primer mensaje).
- [ ] **Step 5:** `npx vitest run && npx tsc --noEmit` → PASS.
- [ ] **Step 6:** Commit `feat: fundaciones (config, db, repos, teléfono, horarios, no llame)`.

---

### Task 2: Capa de modelos de IA con fallback

**Files:**
- Create: `src/llm/llm.ts`
- Test: `tests/llm.test.ts`

**Interfaces:**
- Consumes: `Config.llm`, `logEvent`.
- Produces:
  - `type AgentName = 'buscador'|'vendedor'|'analista'`; `type ChatMessage = { role: 'user'|'assistant'; content: string }`.
  - `interface Llm { text(a:{agent:AgentName; system:string; messages:ChatMessage[]}): Promise<string>; object<T>(a:{agent:AgentName; system:string; messages:ChatMessage[]; schema: z.ZodType<T>}): Promise<T> }`.
  - `class AllProvidersFailedError extends Error { attempts: {spec:string; error:string}[] }`.
  - `createLlm(config: Config, opts?: { modelFactory?: (spec: string) => LanguageModel; db?: Db }): Llm` — prueba cada `proveedor:modelo` de la lista del agente en orden; ante error pasa al siguiente; si todos fallan lanza `AllProvidersFailedError`. Si `db` está, `logEvent(db,'llm_error',…)` por cada fallo.
  - `defaultModelFactory(spec)`: `google` (`@ai-sdk/google`), `groq` (`@ai-sdk/groq`), `openrouter` (`@ai-sdk/openai-compatible`, baseURL `https://openrouter.ai/api/v1`, `OPENROUTER_API_KEY`), `ollama` (openai-compatible, `OLLAMA_BASE_URL` default `http://localhost:11434/v1`), `anthropic` (`@ai-sdk/anthropic`). Proveedor desconocido → Error.
  - `createFakeLlm(handler: (a:{agent; system; messages; schema?}) => unknown | Promise<unknown>): Llm` — `text` devuelve `String(result)`, `object` valida con el schema.
- Defaults en `.env.example`: `LLM_BUSCADOR=google:gemini-2.5-flash-lite,groq:llama-3.1-8b-instant`, `LLM_VENDEDOR=google:gemini-2.5-flash,groq:llama-3.3-70b-versatile`, `LLM_ANALISTA=google:gemini-2.5-flash`.

- [ ] **Step 1:** Instalar `ai @ai-sdk/google @ai-sdk/groq @ai-sdk/openai-compatible @ai-sdk/anthropic`.
- [ ] **Step 2: Tests que fallan** (usar los mock models de `ai/test` vía `modelFactory`):
  - primer modelo lanza error 429, segundo devuelve `'hola'` → `text` resuelve `'hola'`.
  - todos lanzan → rechaza con `AllProvidersFailedError` y `attempts.length === 2`.
  - `object` con schema `z.object({ok: z.boolean()})` devuelve `{ok:true}`.
  - `createFakeLlm` valida schema y rechaza si no cumple.
- [ ] **Step 3:** FAIL. **Step 4:** Implementar con `generateText` / `generateObject` (o `generateText` + `Output.object`, según la versión instalada del SDK). **Step 5:** PASS + `tsc`. **Step 6:** Commit `feat: capa llm multi-proveedor con fallback`.

---

### Task 3: WhatsApp — transporte, lista blanca, outbox, toma de control manual

**Files:**
- Create: `src/whatsapp/transport.ts`, `src/whatsapp/baileys.ts`, `src/whatsapp/gateway.ts`
- Test: `tests/gateway.test.ts`

**Interfaces:**
- Consumes: repo de Task 1, `isInWindow`/`nextSendTime`, `BLOCKED_STATUSES`.
- Produces:
  - `type IncomingMsg = { fromWaId: string; text: string; id: string; at: Date; fromMe: boolean }` (`fromMe`: mensaje enviado desde el teléfono de Lauri en ese chat).
  - `type WaStatus = { state: 'conectando'|'qr'|'conectado'|'desconectado'|'sesion_cerrada'; qr?: string }`.
  - `interface WaTransport { start(): Promise<void>; send(waId: string, text: string): Promise<string>; hasWhatsApp(waId: string): Promise<boolean>; onIncoming(cb: (m: IncomingMsg) => void): void; onStatus(cb: (s: WaStatus) => void): void }`.
  - `createFakeTransport(): WaTransport & { sent: {waId:string; text:string}[]; emitIncoming(m: IncomingMsg): void; emitStatus(s: WaStatus): void; whatsappNumbers: Set<string> }`.
  - `createBaileysTransport(authDir: string): WaTransport` — `useMultiFileAuthState`, reconecta salvo `loggedOut` (→ `sesion_cerrada`), emite QR, convierte JIDs `<num>@s.whatsapp.net`, ignora grupos/estados/broadcast. Sin test unitario (adaptador fino).
  - `class WaGateway { constructor(db: Db, transport: WaTransport, config: Config); handleIncoming(m: IncomingMsg): Promise<{ prospectId: number; triggerAgent: boolean } | null>; enqueueToProspect(prospectId: number, body: string, opts?: { sendAfter?: Date }): Promise<number>; enqueueToOwner(body: string): Promise<number>; flushOutbox(now: Date): Promise<number> }`.
  - Reglas `handleIncoming`: número no presente en `prospects` → `null`, sin guardar nada. Si `fromMe` y el `id` no corresponde a un `wa_message_id` enviado por el sistema → guardar como `author:'lauri'`, `handed_off=true`, `triggerAgent:false`. Mensaje del prospecto → guardar `in`, actualizar `last_inbound_at`; `triggerAgent` = no `handed_off` y status fuera de `BLOCKED_STATUSES`.
  - Reglas `flushOutbox`: kind `self` se envía siempre a `ownerWaId`; kind `prospect` solo dentro de `sendWindow` y si el prospecto no está bloqueado/`handed_off`/opt-out (si lo está → `markOutboxFailed(…,'bloqueado')`). Al enviar: `markOutboxSent`, `addMessage(out, agent)`, `last_outbound_at`. Error del transporte → `markOutboxFailed` con mensaje, sigue con el resto.

- [ ] **Step 1:** Instalar `baileys` (y `qrcode` para renderizar QR en el hub más tarde).
- [ ] **Step 2: Tests que fallan** (memory db + fake transport):
  - mensaje entrante de número que no es prospecto → `null`, `messages` vacía.
  - mensaje entrante de prospecto `contactado` → guardado, `triggerAgent:true`.
  - `fromMe` con id desconocido → `handed_off` true, `triggerAgent:false`; flush posterior a ese prospecto → no envía y marca `bloqueado`.
  - outbox a prospecto en `baja` → no se envía.
  - outbox a prospecto fuera de ventana (domingo) → no se envía y queda pendiente; dentro de ventana → se envía y se registra mensaje `out`.
  - `enqueueToOwner` se envía aunque sea domingo.
- [ ] **Step 3:** FAIL. **Step 4:** Implementar. **Step 5:** PASS + `tsc`. **Step 6:** Commit `feat: whatsapp gateway con lista blanca y outbox`.

---

### Task 4: Agente Buscador

**Files:**
- Create: `src/agents/buscador/cities.ts`, `src/agents/buscador/sources.ts`, `src/agents/buscador/enrich.ts`, `src/agents/buscador/run.ts`
- Test: `tests/buscador.test.ts`

**Interfaces:**
- Consumes: `Llm` (agent `buscador`), `DncChecker`, `toWaId`, repo, `WaTransport.hasWhatsApp`.
- Produces:
  - `CITIES: { city: string; province: string }[]` — al menos 40 ciudades argentinas (CABA primero, luego capitales provinciales y ciudades grandes).
  - `type RawProspect = { name: string; phone?: string; website?: string; address?: string; city: string; province: string; source: string; sourceRef: string; profileUrls?: string[] }`.
  - `interface ProspectSource { name: string; search(q: { city: string; province: string }): Promise<RawProspect[]> }`.
  - `createGooglePlacesSource(apiKey: string, fetchFn = fetch): ProspectSource` — POST `https://places.googleapis.com/v1/places:searchText`, header `X-Goog-FieldMask: places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri`, `textQuery: "psicólogo en {city}, {province}, Argentina"`, `languageCode:'es'`.
  - `enrichFromWebsite(raw: RawProspect, deps: { llm: Llm; fetchFn?: typeof fetch }): Promise<Enrichment>` — `Enrichment = { email?: string; whatsapp?: string; practiceType: 'individual'|'equipo'|'desconocido'; toolsSignals: string; fitNotes: string; extra: Record<string,string> }`. Descarga la home (timeout 10 s, máx 8000 caracteres de texto sin HTML), extrae con `llm.object`. Sin website o error de red → `{practiceType:'desconocido', toolsSignals:'', fitNotes:'', extra:{}}`.
  - `runBuscador(deps: { db; llm; dnc: DncChecker; sources: ProspectSource[]; wa: Pick<WaTransport,'hasWhatsApp'>; config }, now: Date): Promise<{ found: number; inserted: number; skipped: Record<string, number> }>` — recorre `CITIES` desde el cursor `kv 'buscador_cursor'` hasta `buscadorMaxPerDay` insertados; por cada raw: `toWaId` (whatsapp del enriquecimiento tiene prioridad sobre teléfono de Places) → sin número: skip `sin_telefono`; opt-out: `opt_out`; DNC: `no_llame`; `hasWhatsApp` false: `sin_whatsapp`; duplicado: `duplicado`. Inserta con status `encontrado`. Guarda cursor. `logEvent('buscador_run', resultado)`.

- [ ] **Step 1: Tests que fallan** (fake source, fake llm, fake fetch, fake dnc):
  - Places: el fetch recibe el field mask y el textQuery exactos; mapea `displayName.text`, `internationalPhoneNumber`, `websiteUri`.
  - un raw duplicado, uno en DNC, uno sin WhatsApp y uno válido → `inserted:1`, `skipped` con cada motivo.
  - corta al llegar a `buscadorMaxPerDay` y la siguiente corrida retoma desde el cursor.
  - website que falla → prospecto insertado igual con `practiceType 'desconocido'`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** PASS + `tsc`. **Step 5:** Commit `feat: agente buscador`.

---

### Task 5: Agente Vendedor + herramienta de agenda

**Files:**
- Create: `src/agents/agenda/google.ts`, `src/agents/agenda/slots.ts`, `src/agents/vendedor/knowledge.ts`, `src/agents/vendedor/decision.ts`, `src/agents/vendedor/vendedor.ts`
- Test: `tests/slots.test.ts`, `tests/vendedor.test.ts`

**Interfaces:**
- Consumes: `Llm` (agent `vendedor`), `WaGateway.enqueueToProspect/enqueueToOwner`, repo.
- Produces:
  - `interface CalendarService { busy(from: Date, to: Date): Promise<{ start: Date; end: Date }[]>; createMeeting(m: { start: Date; end: Date; email: string; name: string }): Promise<{ eventId: string; meetLink: string }> }`; `interface MailService { send(m: { to: string; subject: string; text: string }): Promise<void> }`; `createGoogleServices(cfg: Config['google']): { calendar: CalendarService; mail: MailService }` (googleapis OAuth2 con refresh token; evento con `conferenceData.createRequest` para Meet, `sendUpdates:'all'`; mail vía Gmail API `users.messages.send` RFC 2822 UTF-8). Sin test unitario (adaptador fino).
  - `proposeSlots(cal: CalendarService, now: Date, config: Config, count = 3): Promise<Date[]>` — horarios de inicio dentro de `meetingWindow`, desde el siguiente día hábil, en pasos de 30 min, sin solaparse con `busy`, a lo sumo uno por día.
  - `formatSlot(d: Date, tz): string` → p. ej. `'lunes 9/11 a las 10:00'`.
  - `loadKnowledge(db): Promise<{ ventas: string; producto: string; estilo: string; faq: { question: string; answer: string }[] }>`.
  - `VendedorDecision` (zod, en `decision.ts`):
```ts
{ action: 'responder'|'escalar_pregunta'|'listo_para_cerrar'|'sospecha_bot'|'ofrecer_reunion'|'agendar_reunion'|'baja'|'rechazo',
  message: string|null, question: string|null,
  meeting: { slotIso: string; email: string } | null,
  evaluation: { stage: 'iniciando'|'interesado'|'dudando'|'convencido'|'frio'; summary: string },
  objections: string[] }
```
  - `buildSystemPrompt(k: Knowledge, prospect: Prospect, ownerName: string): string` — rol: sos `ownerName`, vendés el CRM, flexible y no agresivo, objetivo vender (la reunión es opcional); escribí según `estilo`; usá `producto` y `faq` y nunca inventes precios/funciones: si no sabés → `escalar_pregunta` con un `message` neutral; si te preguntan o sospechan que sos un bot → `sospecha_bot` sin `message`; si quiere comprar → `listo_para_cerrar` sin `message`; si pide que no le escriban → `baja`.
  - `createVendedor(deps: { db; llm; gateway: Pick<WaGateway,'enqueueToProspect'|'enqueueToOwner'>; calendar?: CalendarService; mail?: MailService; config }, )` devuelve:
    - `pickOpenerVariant(): Promise<{ id: number; template: string }>` — si hay variante `candidata`, asigna a la que tenga menos prospectos (A/B 50/50); si no, la `activa`.
    - `startConversation(prospectId, now): Promise<void>` — genera el primer mensaje con `llm.text` (plantilla de variante + ficha + estilo), encola, status `contactado`, `contacted_at`, `opener_variant_id`.
    - `handleInbound(prospectId, now): Promise<void>` — no hace nada si `handed_off` o status bloqueado; llama `llm.object` con `VendedorDecision` y aplica:
      - `responder`: encola `message`; `contactado|encontrado` → `conversando`.
      - `escalar_pregunta`: encola `message` si hay; `createEscalation`; `needs_attention='pregunta'`; `enqueueToOwner('❓ {name} pregunta: {question} — respondé en el hub')`.
      - `listo_para_cerrar`: status `listo_para_cerrar`, `handed_off=true`, `needs_attention='listo_para_cerrar'`, owner: `'✅ {name} está listo para cerrar. Resumen: {summary}'`. No envía nada al prospecto.
      - `sospecha_bot`: `handed_off=true`, `needs_attention='sospecha_bot'`, owner: `'⚠️ {name} sospecha que habla con un bot. Tomá la charla.'`. No envía nada.
      - `ofrecer_reunion`: requiere `calendar`; `proposeSlots`; guarda ISO en `attributes.offered_slots`; encola `message` + lista de `formatSlot`; status `interesado`. Sin `calendar` → tratar como `escalar_pregunta` con pregunta `'Quiere una reunión pero la agenda no está configurada'`.
      - `agendar_reunion`: solo si `meeting.slotIso` está en `offered_slots` y `email` válido; si no, encola un pedido del dato faltante y no agenda. Si ok: `createMeeting`, `addMeeting`, `mail.send` de confirmación (asunto `'Reunión confirmada — {fecha}'`), encola `message`, status `reunion_agendada`, owner `'📅 Reunión con {name}: {fecha}'`.
      - `baja`: encola `message` si hay (despedida) y luego `applyOptOut`.
      - `rechazo`: encola `message` si hay; status `rechazado`.
      - Siempre: guarda `evaluation` (+`updated_at`) y une `objections` en `tags.objections` sin duplicados; `tags.last_action = action`.
      - `AllProvidersFailedError` → no encola nada, `logEvent('vendedor_sin_modelo')`, `kvSet('pending_inbound', …)` agrega el prospectId para reintento; relanza no.
    - `answerEscalation(escalationId, answer): Promise<void>` — `answerEscalationRow`, `addFaq(question, answer)`, redacta con `llm.text` en el estilo de Lauri y encola; limpia `needs_attention`.
    - `runFollowups(now): Promise<number>` — prospectos `contactado` sin `last_inbound_at`, `last_outbound_at` hace ≥ `followupDays` días y `followups_sent < maxFollowups` → genera seguimiento breve, encola, incrementa; los que ya agotaron seguimientos y pasaron `closeAfterDays` desde el último → `sin_respuesta`.

- [ ] **Step 1: Tests que fallan** (memory db, fake llm, gateway real con fake transport, fake calendar/mail):
  - `proposeSlots`: viernes 2026-11-06 15:00 con `busy` lunes 10:00–11:00 → primer slot lunes 11:00, luego martes 10:00, miércoles 10:00.
  - `startConversation` → un ítem en outbox, status `contactado`, `opener_variant_id` seteado.
  - `pickOpenerVariant` con una activa (3 prospectos) y una candidata (1) → candidata.
  - decisión `responder` → status `conversando`, outbox con el mensaje.
  - decisión `escalar_pregunta` → escalation abierta, `needs_attention 'pregunta'`, outbox self con la pregunta.
  - decisión `listo_para_cerrar` → `handed_off`, ningún mensaje al prospecto, outbox self.
  - decisión `sospecha_bot` → `handed_off`, ningún mensaje al prospecto.
  - decisión `agendar_reunion` con slot no ofrecido → no `createMeeting`, encola pedido; con slot ofrecido y email → meeting creada, mail enviado, status `reunion_agendada`.
  - decisión `baja` → `isOptedOut` true.
  - llm que lanza `AllProvidersFailedError` → outbox vacía, prospecto en `pending_inbound`.
  - `answerEscalation` → faq guardada, outbox con respuesta, `needs_attention` null.
  - `runFollowups`: contactado hace 4 días sin respuesta → 1 seguimiento; con 1 seguimiento enviado hace 5 días → `sin_respuesta`.
- [ ] **Step 2:** FAIL. **Step 3:** Instalar `googleapis`; implementar. **Step 4:** PASS + `tsc`. **Step 5:** Commit `feat: agente vendedor y herramienta de agenda`.

---

### Task 6: Aprendizaje — estadísticas, A/B y propuestas

**Files:**
- Create: `src/learning/stats.ts`, `src/learning/analysis.ts`, `src/learning/proposals.ts`
- Test: `tests/learning.test.ts`

**Interfaces:**
- Consumes: repo, `Llm` (agent `analista`), `loadKnowledge`.
- Produces:
  - `variantStats(db): Promise<{ variantId: number; status: string; contacted: number; replied: number; advanced: number }[]>` — `replied`: con al menos un mensaje `in`; `advanced`: status en `interesado|reunion_agendada|listo_para_cerrar`.
  - `objectionCounts(db, since: Date): Promise<{ objection: string; count: number }[]>`.
  - `compareVariants(a: {contacted; replied}, b: {contacted; replied}, minPer: number): { verdict: 'insuficiente'|'tendencia'|'confirmado'; pValue: number|null; rateA: number; rateB: number }` — z-test de dos proporciones (dos colas); `insuficiente` si alguna < `minPer`; `confirmado` si p<0.05; si no `tendencia`.
  - `runWeeklyAnalysis(deps: { db; llm; config }, now: Date): Promise<{ created: number }>`:
    1. Si existe candidata y `compareVariants(activa, candidata)` es `confirmado` con candidata mejor → `addProposal('promover_apertura', targetId=candidata)` (si no hay una pendiente igual).
    2. Si es `confirmado` con candidata peor → `setVariantStatus(candidata,'retirada')` y `logEvent`.
    3. Si no hay candidata y hubo ≥ `abMinPerVariant` contactos desde la última propuesta `apertura_nueva` → pedir a `llm.object` una nueva apertura + resumen + evidencia (con stats y objeciones) → `addProposal('apertura_nueva')`.
    4. Si hay ≥ `abMinPerVariant` contactos con objeciones en los últimos 30 días → pedir mejora al manual de ventas → `addProposal('manual', proposedContent = manual completo nuevo)`.
    5. Nunca crea una propuesta si ya hay otra `pendiente` del mismo kind.
  - `approveProposal(db, id)`: `apertura_nueva` → `addVariant(content,'candidata',id)`; `promover_apertura` → target `activa`, la activa anterior `retirada`; `manual` → `addManualVersion('ventas', content, 'propuesta')`. Luego `decideProposal(aprobada)`. `rejectProposal(db, id)` → `decideProposal(rechazada)`.

- [ ] **Step 1: Tests que fallan:**
  - `compareVariants({contacted:100,replied:30},{contacted:100,replied:50},30)` → `confirmado`, pValue < 0.05.
  - `compareVariants({contacted:10,replied:3},{contacted:10,replied:5},30)` → `insuficiente`.
  - `compareVariants({contacted:40,replied:12},{contacted:40,replied:15},30)` → `tendencia`.
  - `runWeeklyAnalysis` con 10 contactos → `created: 0`, no llama al llm.
  - con 35 contactos sin candidata → crea `apertura_nueva`; segunda corrida no duplica.
  - `approveProposal` de `apertura_nueva` → existe variante `candidata`; de `manual` → nueva versión activa de ventas.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** PASS + `tsc`. **Step 5:** Commit `feat: ciclo de aprendizaje con a/b y propuestas`.

---

### Task 7: Orquestador y entrypoint del worker

**Files:**
- Create: `src/orchestrator/orchestrator.ts`, `src/worker.ts`
- Test: `tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces:
  - `createOrchestrator(deps: { db; config; gateway: WaGateway; vendedor; runBuscador: (now: Date) => Promise<unknown>; runWeeklyAnalysis: (now: Date) => Promise<unknown> })` devuelve:
    - `onIncoming(m: IncomingMsg, now: Date): Promise<void>` — pasa por `gateway.handleIncoming`; si `triggerAgent`, programa `vendedor.handleInbound` a `now + replyDebounceSeconds` (reprograma si llega otro mensaje del mismo prospecto antes; una sola respuesta).
    - `runDue(now: Date): Promise<void>` — ejecuta los `handleInbound` cuya hora programada ya pasó (serializados por prospecto). El debounce se guarda en memoria con la hora programada; no usa timers propios, `tick` lo dispara.
    - `tick(now: Date): Promise<void>` — en orden:
      1. `runDue(now)`.
      2. Buscador: si hora local ≥ `searchHour` y `kv 'buscador_last_date'` ≠ fecha local de hoy → `runBuscador`, guardar fecha.
      3. Nuevos contactos: si dentro de `sendWindow`, sin `kv 'pausa_nuevos'`, `countContactedSince(inicio del día local) < dailyNewContacts`, y pasaron ≥ 30 min desde `kv 'last_new_contact_at'` → `pickContactable(1)` → `vendedor.startConversation`.
      4. Seguimientos: una vez por día a partir de las 10:00 locales (`kv 'followups_last_date'`).
      5. Reintentos: prospectos en `kv 'pending_inbound'` → `handleInbound` (máx 5 por tick).
      6. Análisis: lunes desde las 08:00 locales, una vez por semana (`kv 'analysis_last_week'`).
      7. Freno: si ≥ 3 `baja` en los últimos 7 días y no hay pausa → `kvSet('pausa_nuevos', {since, motivo})` + aviso al dueño.
      8. `gateway.flushOutbox(now)`.
      Cada paso en try/catch: un error se loguea (`logEvent('error', {paso, mensaje})`) y no frena los demás; si el mismo paso falla 3 ticks seguidos → aviso al dueño una sola vez hasta que se recupere.
    - `onWaStatus(s: WaStatus): Promise<void>` — `kvSet('wa_status', s)`; en `sesion_cerrada` o `desconectado` > 10 min → `logEvent` (el aviso por WhatsApp no llegaría; queda en hub).
  - `src/worker.ts`: `loadConfig(process.env)`, `createPgDb`, `migrate`, `seedKnowledge`, `createBaileysTransport`, gateway, llm, dnc, fuentes (Places si hay key), servicios Google si hay config, vendedor, orquestador; `transport.onIncoming`/`onStatus` → orquestador; `setInterval(tick, 60_000)`; apagado limpio con SIGTERM.

- [ ] **Step 1: Tests que fallan** (memory db, fakes, `now` explícito):
  - tres mensajes del mismo prospecto en 10 s → `vendedor.handleInbound` llamado una sola vez tras `runDue(now+31s)`.
  - `tick` lunes 09:05 → `runBuscador` una vez; segundo `tick` 09:06 → no de nuevo.
  - con 5 contactados hoy → no inicia otro; con 2 y último hace 40 min → inicia uno; último hace 10 min → no.
  - domingo → no inicia contactos nuevos.
  - 3 bajas en 7 días → `pausa_nuevos` seteado y outbox self con aviso; luego no inicia contactos.
  - `runBuscador` que lanza → los demás pasos corren igual (flush ejecutado).
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** PASS + `tsc`. **Step 5:** Commit `feat: orquestador y worker`.

---

### Task 8: Hub de operaciones (opción B)

**Files:**
- Create: `src/hub/app.tsx`, `src/hub/views.tsx`, `src/hub/server.ts`
- Test: `tests/hub.test.ts`

**Interfaces:**
- Consumes: repo, `variantStats`, `approveProposal`/`rejectProposal`, `createVendedor(...).answerEscalation`.
- Produces:
  - `createHubApp(deps: { db; config; answerEscalation: (id: number, answer: string) => Promise<void> }): Hono`.
  - Auth: Basic Auth con `hubUser`/`hubPassword` en todas las rutas salvo `GET /health` (200 `ok`).
  - `GET /` y `GET /p/:id`: layout opción B. Arriba métricas (encontrados, contactados, respondieron con %, listos para cerrar, rechazados, sin respuesta, te necesitan). Banner de advertencia si `dncMode === 'off'`, si `kv pausa_nuevos`, o si `wa_status` ≠ `conectado`. Izquierda lista de `listProspectsForHub` con nombre, ciudad, estado legible en español e ícono de atención. Derecha (si `:id`): ficha, evaluación (`stage` + `summary`), chat completo con burbujas por autor (prospecto / agente / Lauri), y si hay escalación abierta un formulario de respuesta. Layout responsive (en celular la lista y el detalle se apilan). Auto-refresh cada 30 s con `<meta http-equiv="refresh">` salvo cuando hay formulario visible.
  - `POST /escalations/:id/answer` (form `answer`) → `answerEscalation`, redirect a `/p/:prospectId`.
  - `GET /mejoras`: propuestas pendientes con resumen, evidencia y contenido propuesto; botones aprobar/rechazar; tabla de `variantStats` con `compareVariants` y verdict en palabras ("insuficiente: faltan N contactos", "tendencia sin confirmar", "confirmado"); historial de versiones del manual.
  - `POST /proposals/:id/approve` y `/reject` → redirect `/mejoras`.
  - `GET /sistema`: estado de WhatsApp; si `state === 'qr'`, el QR renderizado como imagen (`qrcode.toDataURL`) para escanear; últimos 50 eventos; reuniones próximas.
  - `src/hub/server.ts`: `serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) })`.

- [ ] **Step 1: Tests que fallan** (`app.request`, memory db):
  - sin auth → 401; con auth → 200; `/health` sin auth → 200.
  - `/` muestra métricas correctas para datos sembrados (p. ej. 3 encontrados, 2 contactados) y lista el prospecto con `needs_attention` primero.
  - `/p/:id` muestra los mensajes del chat y el formulario cuando hay escalación abierta.
  - `POST /escalations/:id/answer` llama a `answerEscalation` con el texto y redirige.
  - `POST /proposals/:id/approve` de `apertura_nueva` crea variante candidata.
  - `dncMode 'off'` → la página contiene la advertencia de No Llame.
  - `wa_status` `{state:'qr', qr:'abc'}` → `/sistema` contiene `<img` con `data:image/png`.
- [ ] **Step 2:** FAIL. **Step 3:** Instalar `hono @hono/node-server qrcode`; implementar (JSX con `jsxImportSource: hono/jsx` en tsconfig). **Step 4:** PASS + `tsc`. **Step 5:** Commit `feat: hub de operaciones`.

---

### Task 9: Despliegue

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `scripts/google-auth.ts`, `README.md`
- Modify: `.env.example` (todas las variables con comentarios en español), `package.json` (script `google:auth`)

**Interfaces:**
- Consumes: entrypoints `src/worker.ts`, `src/hub/server.ts`.
- Produces:
  - `Dockerfile`: `node:24-slim`, `npm ci`, copia fuente, corre con `tsx` (sin build), usuario no root.
  - `docker-compose.yml`: servicios `db` (postgres:16, volumen `pgdata`, healthcheck), `worker` (`npx tsx src/worker.ts`, volumen `wa_auth:/app/wa_auth`, `./content:/app/content`, depende de db sano, `restart: unless-stopped`), `hub` (`npx tsx src/hub/server.ts`, puerto `3000:3000`, `restart: unless-stopped`), `cloudflared` (perfil `tunnel`, `cloudflare/cloudflared`, `tunnel run --token ${CLOUDFLARE_TUNNEL_TOKEN}`). `env_file: .env`. `DATABASE_URL=postgres://seller:seller@db:5432/seller`.
  - `scripts/google-auth.ts`: flujo OAuth local (servidor en `localhost:5555/callback`) con scopes `calendar.events`, `calendar.freebusy`, `gmail.send`; imprime el `GOOGLE_REFRESH_TOKEN`.
  - `README.md` (español): qué es; requisitos; pasos: 1) completar `content/*.md`, 2) conseguir API keys gratis (Gemini, Groq), 3) Google Places key, 4) `npm run google:auth`, 5) configurar `.env`, 6) `docker compose up -d`, 7) abrir hub `/sistema` y escanear QR con WhatsApp > Dispositivos vinculados, 8) acceso 24/7 con Cloudflare Tunnel (`docker compose --profile tunnel up -d`), 9) cómo pasar a modelos pagos (editar `LLM_*`), 10) trámites (No Llame AAIP, registro de base Ley 25.326), 11) riesgos asumidos (WhatsApp personal, datos en proveedores gratuitos).

- [ ] **Step 1:** Crear archivos.
- [ ] **Step 2: Verificación de despliegue local:** `.env` de prueba (sin keys reales, `DNC_MODE=off`) → `docker compose up -d --build` → `docker compose ps` muestra `db`, `worker`, `hub` en running; `curl -s -o /dev/null -w '%{http_code}' localhost:3000/health` → `200`; `curl -u admin:<pass> localhost:3000/sistema` contiene `qr` o `conectando`; `docker compose logs worker` sin errores fatales (muestra estado `qr`).
- [ ] **Step 3:** `npx vitest run && npx tsc --noEmit` → PASS.
- [ ] **Step 4:** Commit `chore: docker compose, script google oauth y readme`.
