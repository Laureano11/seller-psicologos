# Agente Buscador

Busca psicólogos en Argentina con un navegador (Chromium sin pantalla, perfil propio) y guarda **nombre, celular y email** para que el Vendedor les escriba. Corre una vez por día desde `SEARCH_HOUR`, en segundo plano. Recorre ciudad por ciudad las consultas de `content/buscador-consultas.md` en Bing (Google y DuckDuckGo de respaldo), abre los resultados, la IA extrae los contactos y el código los filtra (equipo → sin teléfono → duplicado → baja → No Llame → sin WhatsApp) antes de guardarlos como `encontrado`.

Ficha de negocio: [`Business.MD`](../../../Business.MD), Parte 1 §1. Diseño: [`docs/superpowers/specs/2026-11-07-buscador-navegador-design.md`](../../../docs/superpowers/specs/2026-11-07-buscador-navegador-design.md).

## Qué editar para cambiar qué

| Querés cambiar… | Editá | ¿Hay que reiniciar? |
|---|---|---|
| **Qué busca** (las consultas) | `content/buscador-consultas.md`, una por línea, con `{ciudad}` y `{provincia}` | No, se relee en cada corrida |
| **Las instrucciones de la IA** (qué extraer, qué ignorar) | `content/buscador-instrucciones.md` | No, se relee en cada corrida |
| Las ciudades y su orden | `cities.ts` | Sí (`docker compose up -d --build worker`) |
| Redes sociales que nunca abre | `BLACKLIST` en `engines.ts` | Sí |
| Palabras que marcan "equipo" en el nombre | `TEAM_WORDS` en `extract.ts` | Sí |
| Ritmo y topes (búsquedas, páginas, pausas, prospectos, consultas a WhatsApp) | Variables `BUSCADOR_*` en `.env` (ver `CONFIGURACION.md` §9) | `docker compose restart worker` |
| Motor principal | `BUSCADOR_ENGINE=bing \| google \| duckduckgo` en `.env` | `docker compose restart worker` |
| Hora de la búsqueda | `SEARCH_HOUR` en `.env` | `docker compose restart worker` |
| Modelo de IA | `LLM_BUSCADOR` en `.env` | `docker compose restart worker` |

## Mapa de archivos

| Archivo | Qué hace |
|---|---|
| `run.ts` | La corrida: cursor (ciudad + consulta + página de resultados), topes, CAPTCHA, filtros, guardado e informe `buscador_run`. |
| `browser.ts` | Abre Chromium con Playwright y devuelve el texto y los links de cada página. Incluye un navegador falso para las pruebas. |
| `engines.ts` | Bing, Google y DuckDuckGo: URL de búsqueda, resultados orgánicos, detección de CAPTCHA. Lista negra de dominios. |
| `robots.ts` | Respeta el `robots.txt` de cada sitio. |
| `extract.ts` | Llama a la IA con las instrucciones, descarta celulares inventados, lee consultas e instrucciones de `content/`. |
| `sources.ts` | Google Places (opcional, solo con `GOOGLE_PLACES_KEY`). |
| `cities.ts` | Lista de ciudades. |
| `../../buscador-ahora.ts` | Script de `npm run buscador`. |

## Cómo forzar una corrida

```bash
docker compose exec worker npm run buscador
```

El worker la lanza en el próximo minuto, si ya pasó `SEARCH_HOUR`. El resultado se ve en el hub (`/sistema`, evento `buscador_run`), con `stopReason` explicando por qué terminó: `tope_prospectos`, `tope_busquedas`, `tope_paginas`, `tope_whatsapp`, `captcha`, `sin_ia`, `cancelado`, `sin_no_llame` o `fin`.

## Cómo termina una corrida

- Al llegar a un tope, si todos los buscadores piden CAPTCHA o si no hay IA disponible: termina normalmente, guarda el cursor y retoma al día siguiente.
- Si un buscador pide CAPTCHA, te avisa por WhatsApp una vez y sigue con el siguiente.
- Solo un error inesperado (por ejemplo, que Chromium no arranque) cuenta como falla y dispara la alerta "falló 3 veces seguidas".

## Pruebas

`npx vitest run tests/buscador*.test.ts`
