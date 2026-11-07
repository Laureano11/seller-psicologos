# PsycoPy: negocio, producto e infraestructura

> Documento de contexto para agentes (Claude Code u otros). Resume **qué es** PsycoPy, **para quién**, **qué hace hoy**, **qué no se puede romper** y **cómo está montado**. Para el detalle técnico fino ver [`docs/arquitectura.md`](docs/arquitectura.md); para instalar y deployar, el [`README.md`](README.md).
>
> Estado al 2026-11-07: tramos M0–M6 terminados, más el rediseño visual (oscuro) y la pantalla de Inicio. Próximo: M7 (solicitudes públicas).

---

## 1. La idea de negocio

### 1.1 Problema

Los psicólogos que atienden en consultorio propio en Argentina gestionan su práctica con **WhatsApp + Excel + cuaderno**: los turnos están en el chat, los cobros en una planilla (o en la memoria), las notas clínicas en papel o en un Word suelto. Eso genera:

- Turnos olvidados o pisados, y pacientes que "se pierden" sin próximo turno.
- No saber cuánto se cobró en el mes ni quién debe sesiones.
- Liquidación de obras sociales (OSDE, PAMI, etc.) a mano, buscando DNI y n.º de afiliado.
- Notas clínicas (datos de salud, sensibles por Ley 25.326) guardadas sin ninguna protección.

### 1.2 Solución

**PsycoPy es un CRM mono-profesional para psicólogos argentinos**: un solo psicólogo, su cartera de pacientes, su agenda, sus cobros y sus notas clínicas cifradas, en una web app que funciona en la compu del consultorio y en el celular.

### 1.3 Cliente objetivo

- Psicólogo/a **independiente** en Argentina, con consultorio propio (presencial u online).
- Atiende particulares y pacientes con **obra social / prepaga**.
- No es técnico: la herramienta tiene que ser obvia, rápida y calma.
- **Fuera de alcance por ahora:** consultorios con varios profesionales, clínicas, otros países (ver Fase 2 en §8).

### 1.4 Propuesta de valor

1. **Todo el consultorio en un lugar**: paciente → turno → cobro → nota.
2. **Saber qué hacer hoy**: próxima sesión, agenda del día, quién no tiene turno, qué falta cobrar.
3. **Cobros claros**: por método (efectivo, transferencia, MercadoPago, obras sociales) con los datos que pide cada una, cobros parciales y resumen mensual.
4. **Confidencialidad real**: notas clínicas cifradas en la app; ni una fuga de la base ni un backup exponen texto clínico.
5. **Diferenciador futuro**: recordatorios por WhatsApp (Fase 1).

### 1.5 Modelo de ingresos

- **Suscripción mensual** del psicólogo (SaaS). Cobro manual al principio; integración con suscripciones de MercadoPago en M9 (opcional).
- Prueba gratis (`trial`) prevista en M9; al vencer, **modo solo lectura**: nunca se bloquea el acceso a los datos ni se borra nada.
- **Precio: no definido todavía.** Un agente no debe inventarlo ni mostrar precios en la UI sin confirmación del dueño.
- Fase 2: precio plano por consultorio (multi-profesional).

### 1.6 Objetivo y regla de corte

- **Meta del MVP:** que **5 psicólogos desconocidos paguen en 30 días**.
- Todo lo que no sirve a esa meta está recortado. Ante la duda sobre una feature nueva, la pregunta es: *¿ayuda a que esos 5 paguen?*
- **Regla de corte:** si a los 30 días no hay 5 pagos de desconocidos, se corta el proyecto.

### 1.7 Equipo y forma de trabajo

- Un solo desarrollador (dueño del producto). Sin equipo, sin PRs.
- Se trabaja **directo sobre `main`**: commit + push después de cada paso verificado. Nada de branches de feature ni worktrees escondidos.
- Cada push a `main` deploya a producción.

---

## 2. Funcionalidades actuales (lo que existe en el código)

### 2.1 Cuenta y perfil
- Registro y login con email + contraseña (Supabase Auth). Sin confirmación de email por ahora.
- Al registrarse, un trigger crea el perfil `psicologo` con un **slug** derivado del email (será el link público `/s/<slug>` de M7).
- **Ajustes** (`/ajustes`): editar nombre y slug.
- Logout desde la sidebar.

### 2.2 Inicio (`/`)
- Saludo según la hora argentina ("Buen día / Buenas tardes / Buenas noches") con el primer nombre (ignora "Lic.", "Dra.").
- **Próxima sesión** del día ("En 12 minutos", "Empezó a las 10:00", "A las 16:00").
- **Agenda de hoy** y **resto de la semana**.
- **Cobrado del mes** hasta hoy, con variación % contra los mismos días del mes anterior y sparkline.
- **Sin turno próximo**: cuántos pacientes no tienen turno programado (link a la lista filtrada).
- Pacientes recientes.

### 2.3 Pacientes (`/pacientes`)
- Alta, edición y **archivo** (soft delete con confirmación en dos pasos).
- Campos: nombre, DNI (se guarda sin puntos), teléfono, email, obra social (con sugerencias: PAMI, OSDE, Swiss Medical, Galeno, IOMA…; "Particular" = sin obra social), n.º de afiliado, **motivo de consulta** y **notas generales** (estos dos cifrados).
- Búsqueda por nombre o DNI (también desde el buscador de la sidebar).
- Filtros: Todos / Con turno / Sin turno próximo / Particulares, con conteos.

### 2.4 Ficha del paciente (`/pacientes/[id]`)
Pestañas (`?tab=`): **Sesiones** (por defecto), **Pagos**, **Notas clínicas**, **Detalles**.
- Próximo turno y última consulta (calculados, no guardados).
- Deuda: suma de saldos de sesiones realizadas sin cobrar completo.
- Notas clínicas por fecha, en tipografía serif, tipo cuaderno. Crear, editar, archivar.

### 2.5 Agenda (`/agenda`)
- Grilla **semana** (por defecto) y **mes**; navegación por día (`?dia=YYYY-MM-DD`).
- Agendar desde la grilla, a un paciente existente **o a alguien nuevo** (se da de alta con nombre y teléfono en el mismo paso).
- Cada turno: fecha/hora, **precio** (obligatorio en la app) y **duración** (15–120 min, de a 5; por defecto 45).
- Al agendar se proponen el precio y la duración de la última sesión de ese paciente, más 3 precios sugeridos con un click. Hora y precio se ajustan con flechas ‹ › (hora de a 15 min, precio de a $500).
- Estados: `programado` / `realizado` / `cancelado`. Reprogramar (vuelve a `programado`) y quitar.
- Panel del día con cobro directo desde el turno.
- Turnos **sueltos**: no hay recurrencia todavía.

### 2.6 Cobros (`/cobros`)
- **Todo cobro sale de un turno** (un turno admite varios cobros parciales). Solo se cobra un turno que ya ocurrió y no fue cancelado (la base lo exige).
- Métodos y datos que pide cada uno (config en `src/modules/cobros/metodos.ts`, sin migración para sumar uno):

  | Método | Datos |
  |---|---|
  | Efectivo, Transferencia, MercadoPago | — |
  | OSDE | DNI*, n.º de afiliado* |
  | PAMI | n.º de beneficiario* |
  | Otra obra social | nombre de la obra social*, n.º de afiliado |

- El método y los datos se **precargan** desde la cobertura del paciente. Montos sugeridos con un click (últimos del paciente, luego los generales).
- Resumen del mes con curvas acumuladas por grupo, comparación con el mes anterior y navegación por meses (`?mes=YYYY-MM`).
- **Por cobrar**: turnos ya ocurridos con saldo pendiente.
- Anular un cobro (soft delete, confirmación en dos pasos).

### 2.7 Sidebar
Inicio, Agenda, Pacientes, Cobros, Ajustes; buscador; contador de turnos de hoy por estado; nombre y email del psicólogo; salir. En celular se vuelve una barra superior.

---

## 3. Restricciones y reglas que NO se pueden romper

### 3.1 Legales y de datos
- Son **datos de salud** (Ley 25.326 de Protección de Datos Personales). Una fuga es el único daño irreversible del proyecto: **la seguridad nunca se pospone**.
- **Aislamiento por psicólogo vía RLS en Postgres**: toda tabla de dominio tiene `psicologo_id` y políticas `= auth.uid()`. No confiar el aislamiento a filtros de la app.
- **FKs compuestas** `(paciente_id, psicologo_id)` (y `turno_id` con el mismo paciente) para que nadie cuelgue datos de un paciente ajeno.
- **Privilegios mínimos**: cada migración hace `revoke all ... from anon, authenticated` y otorga solo `select/insert/update`. **Nunca** `delete` ni `truncate` (TRUNCATE saltea RLS). `anon` no tiene acceso a nada.
- **Sin borrado físico**: soft delete con `deleted_at`; las lecturas filtran `deleted_at is null`.
- **Cifrado AES-256-GCM en la app** de `paciente.motivo_consulta`, `paciente.notas_generales` y `nota.contenido`. Formato `v1:<iv>:<ciphertext>:<tag>`. La base **rechaza** texto plano en esas columnas (`check public.es_cifrado(...)`). Nombre, DNI, teléfono y email **no** se cifran (tienen que poder buscarse).
- La clave `NOTES_ENC_KEY` vive solo en env vars (local y Vercel, **la misma** en ambos). Nunca en la DB, nunca en el repo, nunca en logs. Perderla = perder las notas.
- `service_role` **no se usa**. Solo podrá aparecer, acotado, en M7 (form público) y M9 (webhook de MercadoPago).
- No loguear texto clínico. Cuidado con URLs: `?q=` puede contener nombres de pacientes.

### 3.2 Arquitectura (contrato de módulos)
```
src/modules/<modulo>/
  schema.ts    # zod: valida y normaliza inputs (mismo schema en form y servidor)
  db.ts        # ÚNICO lugar que habla con Supabase; cifra/descifra; importa server-only
  actions.ts   # server actions: validan con zod, requireUser(), llaman a db.ts
  components/  # UI del módulo
src/app/...    # rutas finas que componen módulos
```
- Client components → solo `actions.ts`. Páginas (server components) → pueden leer `db.ts` después de `requireUser()`.
- Cada página **y cada action** llama a `requireUser()`/`getUserOrNull()` (las actions se pueden invocar sin pasar por el proxy).
- Dependencias permitidas entre módulos: `turnos → cobros`, `turnos → pacientes`, `inicio → turnos`. Sin ciclos. Lo compartido va a `src/lib/` o `src/components/`.
- Un módulo nuevo = una carpeta nueva + una migración + tests pgTAP.

### 3.3 Fechas
- Todo se muestra en **hora argentina, UTC−3 fijo** (sin horario de verano). La conversión vive solo en `src/lib/fechas.ts`.
- `timestamptz` para turnos; `date` para notas y cobros. Semana = lunes 00:00 a lunes 00:00 hora AR.

### 3.4 Producto
- Mono-profesional: un psicólogo = una cuenta. No hay roles ni organizaciones (eso es Fase 2).
- Lo derivable no se guarda (próximo turno, última consulta, saldo).
- Sumar una obra social o un método de cobro es editar código (`metodos.ts`, `obras-sociales.ts`), no migrar la base.
- Un error de validación **nunca borra lo tipeado** (los valores vuelven en el estado de la action).
- IDs inválidos o ajenos → 404, nunca 500 ni datos de otro.
- UI en **español rioplatense** (voseo: "Elegí", "Cargá"), montos en pesos argentinos.

### 3.5 Etapa actual (decisiones aceptadas por el dueño)
- **Una sola base** Supabase para local, tests y producción, con **datos de prueba**. Lo que se hace en local se ve en producción. No replantearlo salvo que aparezcan pacientes reales.
- Sin backups ni PITR por ahora. Confirmación de email desactivada.
- **No cargar pacientes reales** hasta terminar M8.

---

## 4. Infraestructura

| Pieza | Qué | Notas |
|---|---|---|
| App | **Next.js 16.3** (App Router, server actions, React 19.2), TypeScript | Next 16 trae cambios de API: leer `node_modules/next/dist/docs/` antes de escribir código (ver `AGENTS.md`). El "middleware" se llama `src/proxy.ts`. |
| Hosting | **Vercel**, proyecto `psicopy` | Producción: https://psicopy.vercel.app. Cada push a `main` deploya. |
| Base de datos + Auth | **Supabase cloud** (Postgres + Auth), región São Paulo (`sa-east-1`) | Un único proyecto (`psicopy-dev`) para todo. |
| Sesión | `@supabase/ssr` con cookies; `getClaims()` verifica el JWT localmente (ES256) | El proxy refresca la sesión y redirige a `/login` en rutas no públicas (públicas: `/login`, `/signup`, `/s/`, `/dev-login`). |
| UI | Tailwind 4 + shadcn/ui (Base UI) + lucide-react | Tema **solo oscuro**, grafito frío con acento azul. Geist (UI), Geist Mono (cifras), Newsreader serif (solo texto clínico). Tokens en `src/app/globals.css`. |
| Validación | zod 4 | |
| Migraciones | `supabase/migrations/*.sql` | El build de producción (`scripts/vercel-build.sh`) corre `supabase db push` antes de `next build`; si falla, el deploy falla y queda el anterior. Previews no tocan la base. Local: `npm run db:push:dev` (afecta producción). |

### Variables de entorno
| Variable | Uso |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Cliente Supabase |
| `SUPABASE_DB_URL` | Session pooler: migraciones y tests pgTAP |
| `NOTES_ENC_KEY` | Clave AES-256 (32 bytes base64). **Crítica.** |
| `DEV_AUTOLOGIN`, `DEV_LOGIN_EMAIL`, `DEV_LOGIN_PASSWORD` | Auto-login con cuenta de prueba, solo con `next dev` |

Los `.env*` están en `.gitignore`. Nunca commitear ni imprimir secretos.

### Modelo de datos (resumen)
- `psicologo` (id = `auth.users.id`, nombre, email, slug único).
- `paciente` (datos personales, obra social, n.º afiliado, motivo y notas generales cifrados, `deleted_at`).
- `nota` (paciente, fecha, contenido cifrado).
- `turno` (paciente, `fecha_hora`, estado enum, precio, `duracion_min`).
- `pago` (paciente, `turno_id` obligatorio, fecha, monto > 0, método, `datos_metodo jsonb`).

### Testing
| Comando | Qué |
|---|---|
| `npm test` | Unitarios (Vitest): cifrado, schemas, fechas, cálculos puros |
| `npm run test:int` | Integración contra Supabase (`*.int.test.ts`) |
| `npm run test:db` | RLS, grants, prohibición de delete/truncate (pgTAP vía `psql`, con rollback) |
| `npm run test:e2e` | Playwright: auth, pacientes, flujo clínico nota → turno → cobro, inicio |
| `npm run lint` | ESLint |

Cada test crea sus propios usuarios (en la base compartida). La lógica de negocio se extrae a funciones puras (`resumen.ts`, `saldo.ts`, `sugerencias.ts`, `calendario.ts`…) para testearla sin base.

---

## 5. Hoja de ruta

| Tramo | Contenido | Listo cuando |
|---|---|---|
| **M7 — Solicitudes** | Form público `/s/<slug>` (mobile-first) donde un posible paciente deja nombre, contacto, motivo (cifrado) y disponibilidad. Turnstile + honeypot + zod; insert con admin client, respuesta genérica (no revela si el slug existe). Bandeja `/solicitudes` con contador en la sidebar: aceptar (crea el paciente) o descartar. Botón "copiar mi link" en Ajustes. | e2e anónimo envía → psicólogo acepta → aparece el paciente; test de que `anon` no lee ni inserta vía PostgREST. |
| **M8 — Endurecimiento** (antes del primer paciente real) | Headers de seguridad (CSP, X-Frame-Options), revisión de logs/URLs, timeouts de sesión, separar dev de prod, Supabase Pro con PITR, `pg_dump` diario a Cloudflare R2 + semanal a Backblaze B2, dominio propio, confirmación de email. | Un restore de prueba funciona y descifra las notas. |
| **M9 — Suscripción MercadoPago** (opcional) | `suscripcion_estado`, `trial_hasta`, `mp_preapproval_id` en `psicologo`; preapproval + webhook con firma verificada; página de plan; banner y modo solo lectura al vencer. | Alta → webhook → estado `activa` en el sandbox de MP. |
| **Fase 1** (cuando los 5 pagos pidan más) | Recordatorios por WhatsApp, turnos recurrentes. | |
| **Fase 2** (consultorio de 3+ psicólogos) | Multitenancy: organización, membresías, roles, aislamiento de historia clínica entre profesionales por RLS. | |
| **Fase 3** (escala u obligación legal) | Inscripción en AAIP, auditoría de accesos a datos clínicos, borrar cuenta. | |

Pendientes menores: búsqueda sin acentos (`unaccent`), tipos generados de Supabase (`supabase gen types`).

---

## 6. Guía rápida para un agente

1. **Antes de tocar código Next**, leer la guía relevante en `node_modules/next/dist/docs/`.
2. Respetar el contrato de módulos (§3.2) y las dependencias permitidas.
3. Toda tabla nueva: `psicologo_id default auth.uid()`, RLS con `with check`, FKs compuestas, `revoke all` + grants explícitos, `deleted_at`, y su test pgTAP en `supabase/tests/database/`.
4. Todo texto clínico nuevo: cifrado en `db.ts` + `check public.es_cifrado(...)` en la base.
5. Fechas siempre vía `src/lib/fechas.ts`.
6. Verificar con `npm test`, `npm run lint` y, si se toca la base o un flujo, `test:db` / `test:e2e`.
7. Recordar que **la base es la de producción**: una migración aplicada en local ya está en prod.
8. Commit + push directo a `main` al terminar cada paso verificado.
9. Ante una decisión de negocio (precio, alcance, features fuera del MVP), preguntar al dueño en lugar de suponer.

---

## 7. Desfasajes conocidos entre documentación y código

- `docs/arquitectura.md` §6 describe una paleta "blanco y azules"; el código actual es **solo oscuro** (rediseño fase 1). Manda el código.
- `docs/arquitectura.md` §3.5 dice que se usa `getUser()`; el código usa `getClaims()` (verificación local del JWT) en el proxy y en `requireUser()`.
- `docs/arquitectura.md` §6 describe la ficha con notas como columna principal; hoy la ficha está organizada en **pestañas** (Sesiones, Pagos, Notas clínicas, Detalles).
