# Agente Buscador

Busca psicólogos en Argentina y guarda **nombre, celular y email** en `data/prospectos.json`. Corre **en tu Mac, sin Docker**: lanza un agente de Claude (`claude -p`, con tu sesión de Claude Code) que navega con un navegador propio (Playwright MCP, perfil `browser_profile/`, nunca tu Chrome). **No usa claves ni variables de entorno.**

El worker (Docker) lee ese archivo cada 10 minutos y pasa a la base a los que tienen WhatsApp y no están en el No Llame ni dados de baja. Desde ahí los toma el Vendedor.

Ficha de negocio: [`Business.MD`](../../../Business.MD), Parte 1 §1. Diseño: [`docs/superpowers/specs/2026-11-11-buscador-claude-design.md`](../../../docs/superpowers/specs/2026-11-11-buscador-claude-design.md).

## Cómo correrlo

Requisitos: Node 24, `npm install` hecho una vez y Claude Code instalado y logueado (`claude` en la terminal). La primera corrida descarga el navegador de Playwright MCP con `npx`. Usa Google Chrome instalado como motor, pero con un perfil aparte.

```bash
npm run buscador          # hasta 10 psicólogos nuevos
npm run buscador -- 20    # otro máximo
```

**Cada hora, sola:** instalá el `launchd` (una vez, desde la raíz del repo):

```bash
sed "s#__REPO__#$(pwd)#g; s#__PATH__#$PATH#g" scripts/buscador.launchd.plist > ~/Library/LaunchAgents/com.seller-psicologos.buscador.plist
launchctl load ~/Library/LaunchAgents/com.seller-psicologos.buscador.plist
```

Para frenarlo: `launchctl unload ~/Library/LaunchAgents/com.seller-psicologos.buscador.plist`. El log queda en `data/buscador.log`. Si una corrida sigue en curso cuando arranca la siguiente, la nueva no hace nada (candado `data/buscador.lock`).

## Qué hace una corrida

1. Borra de `prospectos.json` a los números de `data/bajas.json` (los publica el worker).
2. Toma la ciudad que sigue (`data/buscador-estado.json`, orden de `cities.ts`).
3. Lanza Claude con `content/buscador-instrucciones.md`, las consultas de `content/buscador-consultas.md` para esa ciudad, el máximo y los celulares que ya tenemos.
4. Filtra lo que devuelve, en este orden: **equipo** (por el nombre) → **sin teléfono** válido → **red social** → **baja** → **duplicado** → **no figura en la página** (el código descarga la página y el celular tiene que estar escrito ahí: así Claude no puede inventar números).
5. Agrega los nuevos a `prospectos.json` y anota el resumen en `data/buscador-corridas.json` (lo muestra el hub).

Si Claude falla (no instalado, sin sesión, se pasó de 30 minutos), no se toca el archivo ni se avanza de ciudad.

## Qué editar para cambiar qué

| Querés cambiar… | Editá | ¿Hay que reiniciar? |
|---|---|---|
| **Qué busca** (las consultas) | `content/buscador-consultas.md`, una por línea, con `{ciudad}` y `{provincia}` | No |
| **Las instrucciones del agente** | `content/buscador-instrucciones.md` | No |
| Las ciudades y su orden | `cities.ts` | No (es la Mac) |
| Redes sociales que descarta | `BLACKLIST` en `extract.ts` | No |
| Palabras que marcan "equipo" | `TEAM_WORDS` en `extract.ts` | No |
| Máximo por corrida, modelo, tiempo máximo | `src/buscador.ts` (`DEFAULT_MAX`, `model`, `timeoutMs`) | No |
| Tope de consultas a WhatsApp al importar | `BUSCADOR_MAX_WA_CHECKS` en `.env` | `docker compose restart worker` |

## Mapa de archivos

| Archivo | Qué hace |
|---|---|
| `../../buscador.ts` | Script de `npm run buscador`: candado, máximo, descarga de páginas, resumen. |
| `corrida.ts` | Una corrida: bajas, ciudad, Claude, filtros, guardado, informe. |
| `claude.ts` | Arma el prompt y lanza `claude -p` con el navegador y la salida en JSON. |
| `archivo.ts` | Formato de `prospectos.json` y lectura/escritura segura (temporal + rename). |
| `extract.ts` | Consultas, instrucciones, filtro de equipos, lista negra y verificación del celular en la página. |
| `importar.ts` | En el worker: pasa los nuevos del `.json` a la base y publica `bajas.json`. |
| `cities.ts` | Lista de ciudades. |

## Importación en el worker

Cada 10 minutos, en segundo plano. Por cada psicólogo del `.json` que no está en la base ni fue descartado: **baja** → **No Llame** → **¿tiene WhatsApp?**. Los que pasan quedan como `encontrado` con fuente `claude` y el link de la página. Si falta el archivo No Llame, no carga a nadie. El resultado se ve en el hub (`/pipeline` y `/sistema`, evento `buscador_import`).

## Protección del número de WhatsApp

- Tope de `BUSCADOR_MAX_WA_CHECKS` (150) consultas "¿tiene WhatsApp?" **por día** (contador en `kv`, clave `buscador_wa_checks`).
- Pausa aleatoria de 2 a 6 s antes de cada consulta.
- Un número sin WhatsApp se recuerda 60 días y no se vuelve a consultar (`kv`, clave `buscador_sin_wa`).
- Los descartes por baja o No Llame no se vuelven a revisar (`kv`, clave `importador_descartados`).

## Pruebas

`npx vitest run tests/buscador*.test.ts`
