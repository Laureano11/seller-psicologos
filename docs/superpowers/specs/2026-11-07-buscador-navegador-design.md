# Buscador con navegador: diseño

Fecha: 2026-11-07 · Pieza: Agente Buscador (`src/agents/buscador/`) · Contexto: [`Business.MD`](../../../Business.MD), Parte 1 §1.

## Intención

El Buscador llena el embudo. Hoy solo consulta Google Places con una búsqueda fija por ciudad. Queremos que además **busque en la web abriendo un navegador**, para conseguir **volumen**: muchos psicólogos con lo mínimo para escribirles por WhatsApp.

La calificación (si atiende solo, si tiene sistema, si es buen cliente) **no es trabajo del Buscador**: la hace el Vendedor en la charla. El Buscador tiene que ser rápido y simple.

## Objetivos

- Encontrar psicólogos en Argentina buscando en Google (y DuckDuckGo como respaldo) con un navegador automatizado, ciudad por ciudad.
- Extraer de cada página solo: **nombre, celular, email**.
- Pasar los filtros que ya existen y guardar el prospecto como `encontrado`.
- Cero APIs pagas.

## No-objetivos

- No investiga a cada psicólogo: no abre su web para buscar obras sociales, especialidad, herramientas, modalidad, matrícula, etc.
- No fusiona datos de varias fuentes. Si el número ya existe, es duplicado y se descarta.
- No usa LinkedIn ni redes sociales.
- No califica (solo / equipo / sin sistema).

## Anti-objetivos (sería un fracaso aunque funcione)

- Que el navegador use el Chrome personal de Lauri, sus sesiones o su cuenta de Google.
- Que intente esquivar CAPTCHAs o bloqueos.
- Que guarde a alguien sin pasar por el Registro No Llame o la lista de bajas.
- Que invente datos: nombre, celular y email salen textuales de la página.
- Que la ficha se convierta en una planilla larga.

## Restricciones

- Corre en la misma compu secundaria que el resto (servidor 24/7, Docker Compose), dentro del contenedor `worker`, con Chromium **headless** y un **perfil propio** del agente.
- Sale con la IP de la casa: hay que mantener un ritmo bajo con Google.
- Modelos de IA gratuitos (cadena `LLM_BUSCADOR`), igual que hoy.
- Leyes: Registro No Llame (Ley 26.951) y bajas (Ley 25.326), sin cambios respecto de hoy.
- Respetar `robots.txt`; no entrar a páginas con login, no completar formularios.

## Lo que decidió Lauri

- Fuentes: Google y páginas que salgan de ahí (listados, cartillas, directorios, webs de psicólogos), más Maps. **Sin LinkedIn.**
- El agente busca **con un navegador**, no con APIs de búsqueda pagas.
- Corre en la compu secundaria 24/7, junto con todos los agentes.
- Ficha mínima: **nombre, celular, email**. Nada más de cada psicólogo.
- Prioridad: velocidad y volumen por sobre detalle.

## Diseño

### Ficha del prospecto

Se usa la tabla `prospects` que ya existe, sin columnas nuevas. Lo que el Buscador completa:

| Campo | De dónde |
|---|---|
| `name` | Textual de la página. |
| `phone_raw` / `wa_id` | Celular de la página, normalizado con `toWaId`. Tiene que tener WhatsApp. |
| `email` | Textual de la página, si aparece. |
| `city`, `province` | De la ciudad que se está buscando. |
| `source` | `google`, `duckduckgo` o `google_places`. |
| `source_ref` | **URL exacta de la página** donde apareció el dato (para responder "¿de dónde sacaste mi número?"). Para Places sigue siendo el id del lugar. |
| `status` | `encontrado`. |

El resto de las columnas queda con sus valores por defecto (`practice_type = 'desconocido'`, etc.).

### Flujo de una corrida

Lo despierta el Orquestador una vez por día desde `SEARCH_HOUR` (sin cambios). Para cada ciudad, retomando desde el cursor `buscador_cursor`:

1. **Buscar.** Abre el buscador en el navegador y corre las consultas de la ciudad (ver "Consultas").
2. **Elegir resultados.** Toma los primeros resultados orgánicos de cada búsqueda (hasta `BUSCADOR_RESULTS_PER_QUERY`, 10 por defecto), salteando dominios de la lista negra (LinkedIn, Facebook, Instagram, X, TikTok, YouTube) y URLs ya visitadas en esta corrida.
3. **Leer la página.** La abre en el navegador, espera a que cargue, toma el texto visible y los links `tel:`, `mailto:` y `wa.me` / `api.whatsapp.com`.
4. **Extraer contactos.** La IA recibe ese texto y devuelve una lista de `{ nombre, celular, email }`. Una página puede traer muchos (un listado) o uno (una web personal). Reglas para la IA: solo psicólogos/as personas, datos textuales, nada inventado, descartar lo que sea claramente un centro, instituto o equipo por su nombre.
5. **Filtrar** cada contacto con la cadena que ya existe, en este orden: sin celular → duplicado → baja → No Llame → sin WhatsApp. Además, filtro barato por nombre: descartar si contiene "centro", "instituto", "equipo", "fundación", "clínica", "asociación" (motivo `equipo`).
6. **Guardar** como `encontrado`.
7. Cortar al llegar a `BUSCADOR_MAX_PER_DAY` (50) insertados, al agotar el presupuesto de búsquedas/páginas, o si hay un CAPTCHA.

Google Places sigue como otra fuente más, igual que hoy, **solo si hay `GOOGLE_PLACES_KEY`** configurada (tiene cupo gratuito mensual). Sin la clave, se usa solo el navegador.

### Consultas

Plantillas fijas en código, rotando por ciudad (no las inventa la IA, para que sea predecible y rápido). Punto de partida:

- `psicólogo {ciudad} whatsapp`
- `psicóloga {ciudad} consultorio`
- `listado psicólogos {ciudad} {provincia}`
- `cartilla psicólogos {ciudad}`
- `psicólogo particular {ciudad} turnos`

La lista vive en un archivo propio (`queries.ts`) para que Lauri la pueda editar.

### Navegador

- **Playwright** con **Chromium headless** instalado en la imagen del `worker`.
- **Perfil persistente propio** en un volumen (`/app/browser_profile`), separado de cualquier navegador de Lauri.
- Una sola pestaña, una página a la vez.
- Locale `es-AR`, zona horaria de `config.tz`.
- Timeout por página: 15 s. Si falla, se saltea.

### Ritmo y límites (todo configurable en `.env`)

| Variable | Defecto | Para qué |
|---|---|---|
| `BUSCADOR_MAX_PER_DAY` | 50 | Ya existe. Tope de prospectos nuevos. |
| `BUSCADOR_MAX_SEARCHES` | 25 | Búsquedas en el buscador por corrida. |
| `BUSCADOR_MAX_PAGES` | 150 | Páginas abiertas por corrida. |
| `BUSCADOR_RESULTS_PER_QUERY` | 10 | Resultados a abrir por búsqueda. |
| `BUSCADOR_SEARCH_DELAY` | 20–60 s | Pausa aleatoria entre búsquedas. |
| `BUSCADOR_PAGE_DELAY` | 3–8 s | Pausa aleatoria entre páginas. |
| `BUSCADOR_ENGINE` | `google` | Motor principal; `duckduckgo` como respaldo. |

### CAPTCHA y bloqueos

- Si Google muestra CAPTCHA o la página de "tráfico inusual": **no se intenta resolver**. Se pasa a DuckDuckGo para el resto de la corrida, se registra el evento y se avisa a Lauri por WhatsApp ("Mensaje a mí mismo") una sola vez por día.
- Si DuckDuckGo también bloquea: se termina la corrida, se guarda el cursor y se retoma al día siguiente.
- Una página de un sitio que pide login o tiene un formulario como única forma de ver datos (típico de cartillas): se saltea.
- `robots.txt`: se consulta una vez por dominio por corrida (con caché); si prohíbe la ruta, no se abre.

### La corrida no frena al resto del sistema

Con el ritmo bajo, una corrida puede durar entre 45 y 90 minutos. Hoy el Orquestador espera (`await`) al Buscador dentro de su ronda, y eso dejaría sin responder los chats durante todo ese tiempo. **Inaceptable.** La corrida se lanza **en segundo plano**:

- El paso `buscador` del Orquestador la arranca y sigue con su ronda sin esperar.
- Un candado en memoria evita dos corridas a la vez.
- Al terminar (bien, por CAPTCHA o por error) se cierra el navegador y se registra la corrida del día.
- Si el worker se apaga a mitad, el cursor guardado permite retomar al día siguiente.

### Cursor y cobertura

- El cursor guarda **ciudad + consulta + página de resultados**, porque el presupuesto de búsquedas corta a mitad de una ciudad.
- Cada ciudad corre sus 5 plantillas en orden antes de pasar a la siguiente.
- Al terminar la lista de ciudades, la vuelta siguiente usa la **página 2 de resultados**, después la 3, y así hasta un máximo de 3. Recién ahí el ciclo vuelve a empezar.
- Ampliar `cities.ts` queda como tarea aparte. Si los duplicados empiezan a dominar el informe, es la señal para hacerlo.

### Ahorro de IA y de chequeos de WhatsApp

- **Antes de llamar a la IA**, se busca con una regex si la página tiene algún teléfono argentino o un link `tel:` / `wa.me`. Si no tiene ninguno, se saltea sin gastar una llamada.
- Si se agota la cadena `LLM_BUSCADOR` (cupo o límites de los modelos gratis): **se corta la corrida y se guarda el cursor**. No hay extracción de respaldo sin IA, porque sin la IA no hay forma confiable de sacar el nombre.
- **Antes de preguntar a WhatsApp** si un número tiene cuenta, se descartan los que no son **celulares** según `libphonenumber` (motivo `fijo`). Así se evitan cientos de consultas por los fijos de los directorios.
- Tope de **`BUSCADOR_MAX_WA_CHECKS`** (150 por defecto) consultas de WhatsApp por corrida, para no exponer el número de Lauri. Al llegar al tope, la corrida termina.

### Cómo termina una corrida

Que termine por tope, por CAPTCHA o por falta de IA **es un final normal**: `runBuscador` devuelve el resultado con el motivo de corte y el día queda marcado como hecho. Solo un error inesperado (por ejemplo, que Chromium no arranque) cuenta como falla y usa los reintentos y la alerta "falló 3 veces" que ya existen.

### Informe de la corrida

Se mantiene el evento `buscador_run` (encontrados, insertados, motivos de descarte) y se suman: búsquedas hechas, páginas abiertas, si hubo CAPTCHA y qué motor se usó. Sirve para ver en el hub si el ritmo alcanza.

### Qué cambia en el código (orientativo)

- `sources.ts`: nueva fuente `createBrowserSearchSource` que implementa `ProspectSource` (búsqueda + lectura + extracción). Places queda como está.
- `enrich.ts`: deja de usarse en el flujo (la extracción ya trae nombre, celular y email). Se puede borrar.
- `run.ts`: sumar el filtro por nombre, el presupuesto de búsquedas/páginas y el corte por CAPTCHA. `processRaw` deja de enriquecer.
- `queries.ts`: nuevo.
- `config.ts`: variables nuevas.
- `worker.ts`: crear la fuente del navegador y cerrarlo al terminar la corrida.
- `Dockerfile` / `docker-compose.yml`: dependencias de Chromium y volumen del perfil.
- `Business.MD`: actualizar la ficha del Buscador.

## Pruebas

- La lógica de corrida y filtros con una fuente falsa (como hoy en `tests/buscador.test.ts`).
- La extracción con HTML de ejemplo guardado (un listado y una web personal), con la IA simulada.
- La detección de CAPTCHA con una página de ejemplo.
- Sin pruebas que abran Google de verdad. Se verifica a mano una corrida real con un tope bajo.

## Lo que queda a criterio del implementador

- Selectores exactos para leer resultados de Google y DuckDuckGo (conviene la versión HTML simple de DuckDuckGo).
- Cómo detectar el CAPTCHA (URL `/sorry/`, texto de la página, etc.).
- Si la IA recibe el texto entero o recortado, y el tamaño del recorte.
- Normalizar celulares fijos vs. móviles (lo resuelve `toWaId` + el chequeo de WhatsApp).

## Decisiones de Claude (revisar)

- Consultas con **plantillas fijas** en vez de que la IA las invente.
- Filtro de "equipo" **solo por palabras en el nombre**, sin investigar.
- Places se mantiene si hay clave, porque tiene cupo gratis.
- DuckDuckGo como respaldo automático ante CAPTCHA.
- Los valores por defecto de ritmo y límites de la tabla.
- `source_ref` guarda la URL de la página (antes era el id de Places).
- La corrida va en segundo plano para no frenar las respuestas del Vendedor.
- Cursor por ciudad + consulta + página; hasta 3 páginas de resultados por consulta antes de reiniciar el ciclo.
- Sin IA disponible, la corrida se corta (no hay extracción de respaldo).
- Solo se consulta WhatsApp para celulares, con un tope de 150 consultas por corrida.
- Cortar por CAPTCHA, tope o falta de IA cuenta como corrida hecha, no como falla.
