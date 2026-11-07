# Kairos — Referencia de estilo del hub

> Instrumento de control: oscuro, sobrio y preciso. Casi todo es gris azulado en distintas opacidades; **un solo acento azul (`signal`)** marca lo que está vivo, activo o pide atención. Datos y etiquetas en monoespaciada mayúscula, como un panel técnico.

Implementación: todo el CSS vive en `src/hub/views.tsx` (constante `CSS`) y `src/hub/pipeline.tsx` (`PIPELINE_CSS`). El hub se renderiza en el servidor con Hono JSX, sin JavaScript en el navegador ni Tailwind. Las fuentes se sirven desde `src/hub/fonts/` (sin CDNs).

## Color

Solo modo oscuro (`color-scheme: dark`).

| Token | Valor | Uso |
|---|---|---|
| `--bg` | `oklch(.145 .012 262)` | Fondo de página |
| `--surface` | `oklch(.172 .012 262)` | Paneles, tarjetas, tiles |
| `--popover` | `oklch(.19 .013 262)` | Celdas de grillas de datos |
| `--sidebar` | `oklch(.13 .012 262)` | Sidebar (más oscuro que el fondo) |
| `--sidebar-accent` | `oklch(.2 .012 262)` | Item de navegación activo |
| `--fg` | `oklch(.965 .004 262)` | Texto principal, botón primario ("bone") |
| `--muted` | `oklch(.69 .012 262)` | Texto secundario, etiquetas |
| `--border` | `oklch(1 0 0 / 8%)` | Bordes y divisores |
| `--input` | `oklch(1 0 0 / 12%)` | Bordes de inputs y botones outline |
| `--signal` | `oklch(.72 .15 250)` | **Único acento** |
| `--chart2` | `oklch(.5 .014 262)` | Datos secundarios en gráficos |

Reglas:
- Las jerarquías salen de **opacidades de blanco**, no de colores nuevos: `oklch(1 0 0/.02)` → `.03` → `.06` (hover) → `.09` (seleccionado). Bordes en hover: `oklch(1 0 0/15–20%)`.
- `signal` solo para: estado vivo/activo, la tarjeta de atención, el indicador de navegación, el foco de inputs, datos principales en gráficos y lo que te necesita. Nunca decorativo.
- Tintes de signal siempre bajos: fondo `/.035–.08`, borde `/25–40%`.
- **Nada de rojo, verde ni amarillo.** Los estados se distinguen con signal vs bone vs muted, punto sólido vs hueco, y tachado. Los errores van en bone con punto hueco.

## Tipografía

| Familia | Variable | Uso |
|---|---|---|
| Sora (600) | `--heading` | H1 de página (34px, 28px en mobile), títulos de panel (15px), nombre del prospecto (22px) |
| Inter | `--sans` | Texto UI 13px, descripciones 15px, KPIs 34px semibold |
| JetBrains Mono | `--mono` | Eyebrows y etiquetas en MAYÚSCULAS 10–11px con tracking `.14–.18em`; horas, fechas, conteos 11px |

Los tamaños en px (13, 15, 11, 34) son parte del estilo: no se redondean.

## Superficies y forma

- Panel estándar (`.card`, `.list`, `.detail`, `.metric`): `--surface` + gradiente sutil arriba + borde `--border` + radio 17px.
- Radios: botones e inputs 12px, paneles 17px, tarjeta de atención 22px, pills `999px`, tags 6px.
- Botón primario: bone (`--fg` sobre `--bg`) con `--shadow-bone`. Secundario (`button.no`): outline.
- Fondo de cada página: grilla de 56px que se desvanece hacia abajo + resplandor radial azul arriba (`main::before/::after`).

## Componentes

| Clase / componente | Para qué |
|---|---|
| `Layout` | Sidebar de 248px + topbar sticky de 56px con blur y breadcrumb mono + encabezado de página (`eyebrow`, `title`, `description`) + tarjeta de avisos |
| `.attn` | "Necesita tu atención": la única superficie teñida de azul. Solo si hay avisos |
| `.metric` | Tile KPI. `.hot` = te necesitan (tinte signal), `.good` = punto signal |
| `Pill` / `StatusPill` | Estado con tono: `live` (signal que late), `positive` (signal), `attention` (bone hueco), `neutral` (bone), `quiet` (muted hueco), `void` (muted tachado) |
| `Dot` | Punto `signal` / `bone` / `muted`, con `pulse` o `hollow` |
| `.item` + `.avatar` | Fila de lista con inicial, nombre, meta mono y pill |
| `.facts` | Grilla de datos con divisores de 1px |
| `.ask` | Pregunta escalada que hay que responder (tinte signal) |
| `.bubble` | Mensajes: prospecto, agente, Lauri (tinte signal) |

Mapa de estados de prospecto → tono: listo para cerrar `live`, reunión agendada `positive`, interesado `attention`, contactado y conversando `neutral`, encontrado y sin respuesta `quiet`, rechazado, baja y descartado `void`.

## Layout

- Contenido `max-width: 1400px`, padding `36px 40px 80px` (24px por lado en tablet, 16px en mobile).
- Orden de página: encabezado → avisos → KPIs (`gap: 16px`) → paneles (`gap: 20px`).
- Debajo de 1024px el sidebar pasa arriba con navegación horizontal; debajo de 640px se ocultan el breadcrumb y el chip de WhatsApp.

## Movimiento

- Easing de marca `cubic-bezier(.32,.72,0,1)` (`--ease`).
- Entrada de página: fade + desplazamiento de 8px en 0.5s.
- Hover: tiles suben 2px, botones `scale(.97)` al presionar.
- Vivo: anillo que late en el punto signal. Barras del embudo crecen al cargar.
- `prefers-reduced-motion` desactiva todo.

## Copy

Frases cortas, en sentence case, que hablan de resultados. Etiquetas mono en MAYÚSCULAS cortas (`CENTRO DE CONTROL`, `AVISO`, `ETAPA`).
