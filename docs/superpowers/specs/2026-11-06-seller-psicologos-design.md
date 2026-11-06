# Seller automatizado de CRM para psicólogos — Documento de diseño

Fecha: 2026-11-06
Estado: borrador para aprobación

## 1. Intención y porqué

Lauri vende un CRM para psicólogos en Argentina. Todavía no cerró ninguna venta. Quiere un sistema de agentes que funcione 24/7 en la nube y que, sin su intervención:

1. encuentre psicólogos todos los días,
2. los contacte por WhatsApp (desde su número personal) escribiendo como él,
3. converse con ellos con el objetivo de venderles el CRM, de forma flexible y no agresiva,
4. agende reuniones si hacen falta,
5. le avise solo cuando lo necesita (preguntas que no sabe responder) o cuando un psicólogo está listo para comprar — ahí Lauri toma el chat y cierra la venta él mismo,
6. aprenda de los resultados y proponga mejoras a la técnica de venta.

Lauri supervisa todo desde un **hub de operaciones** web, accesible 24/7 desde cualquier dispositivo.

## 2. Objetivos, no-objetivos y anti-objetivos

### Objetivos
- Prospección diaria automática de psicólogos argentinos.
- Contacto y conversación autónoma por WhatsApp, máximo **5 contactos nuevos por día**.
- Objetivo de la conversación: **vender el CRM**. La reunión es una herramienta opcional, no la meta.
- Escalar a Lauri: (a) preguntas que el agente no sabe responder, (b) psicólogo listo para comprar.
- Hub web con métricas, lista de psicólogos por estado y chats completos.
- Ciclo de mejora: el sistema propone cambios al manual de ventas basados en datos suficientes; Lauri aprueba.

### No-objetivos (por ahora)
- Cerrar la venta, cobrar o dar de alta al cliente en el CRM: eso lo hace Lauri.
- Multiusuario, multi-vendedor o vender otros productos.
- Contacto por canales distintos de WhatsApp (LinkedIn/Instagram se usan solo para *leer* perfiles).

### Anti-objetivos (fallaría aunque "funcione")
- Ser agresivo o insistente; spamear.
- Improvisar respuestas que Lauri no validó (precios, funcionalidades inexistentes, promesas).
- Que un agente lea o escriba en chats personales de Lauri (familia, amigos, grupos).
- Que el manual de ventas cambie sin aprobación de Lauri.
- Que el sistema saque conclusiones de "mejora" con muestras chicas (ruido estadístico).
- Seguir escribiéndole a alguien que pidió no ser contactado o bloqueó.
- Escribirle a un psicólogo ya traspasado a Lauri.

## 3. Restricciones

- **Mercado:** Argentina, español rioplatense.
- **Canal:** WhatsApp Web sobre el **número personal de Lauri** (decisión de Lauri, asumiendo el riesgo de baneo por términos de uso de WhatsApp). No se usa la API oficial de WhatsApp Business.
- **Despliegue:** todo en la nube 24/7. La Mac de Lauri puede estar apagada.
- **Legal (Argentina):**
  - Ley 25.326 de Protección de Datos Personales: la base de prospectos debe poder registrarse ante la AAIP; toda persona que pida baja debe ser borrada/excluida definitivamente.
  - Registro Nacional "No Llame" (Ley 26.951): antes de contactar un número, verificar que no esté inscripto.
- **Fuentes de prospección:** preferir fuentes que no violen términos de uso ni bloqueen cuentas: Google Places API (oficial), sitios web propios de profesionales, Doctoralia/TopDoctors (lectura de páginas públicas, respetando robots.txt), cartillas públicas de prepagas/obras sociales, listados de colegios de psicólogos. LinkedIn e Instagram: solo lectura puntual de perfiles ya identificados, nunca scraping masivo ni mensajes.
- **Costo de IA:** tope diario de gasto configurable; si se supera, el sistema pausa lo no urgente y avisa.

## 4. Componentes (lo decidido)

### 4.1 Agente 1 — Buscador
- Corre **todos los días a las 9:00 (hora Argentina)**.
- Busca **todos los perfiles de psicólogos** en las fuentes de §3, sin filtro geográfico ni de perfil (decisión de Lauri). El filtrado por perfil más adecuado se agregará más adelante en base a resultados, por lo que la ficha debe guardar atributos útiles para filtrar después.
- Por cada psicólogo arma una ficha: nombre, teléfono WhatsApp, mail si existe, zona, fuente, si atiende solo o en equipo, herramientas que parece usar (agenda online, nada, etc.), señales de que el CRM le serviría, links a perfiles.
- Deduplica contra la base (mismo teléfono = misma persona).
- Verifica "No Llame" y la lista de bajas antes de marcarlo como contactable.
- Deja los nuevos en estado **Encontrado**.

### 4.2 Agente 2 — Vendedor
- Toma los contactos asignados por el orquestador (máx. 5 nuevos/día).
- Envía el primer mensaje como si fuera Lauri, personalizado con la ficha.
- Mantiene la conversación con el objetivo de vender, de forma flexible y no agresiva, siguiendo el **manual de ventas** (`.md` provisto por Lauri), la **ficha de producto del CRM** (`.md` provisto por Lauri: precio, planes, funciones, prueba gratis, comparativas) y el **documento de patrones de escritura** de Lauri (provisto más adelante; hasta entonces, tono neutro y cordial).
- Si el psicólogo prefiere reunión/demo, la ofrece y usa la herramienta de agenda (§4.3).
- Si no sabe responder algo: responde neutral ("dejame chequearlo y te confirmo") y **escala a Lauri** en el hub. La respuesta de Lauri se envía con su estilo y se guarda como conocimiento reutilizable (base de preguntas frecuentes).
- Cuando el psicólogo está listo para comprar: **deja de escribir**, marca el chat como **Listo para cerrar / traspasado a Lauri**, y notifica. Ningún agente vuelve a escribir en ese chat.
- Si el psicólogo pide no ser contactado, bloquea, o no responde tras el seguimiento definido en el manual: cierra el contacto definitivamente.
- Solo envía mensajes en horario laboral razonable (configurable, p. ej. lun–vie 9–20 h); responde a mensajes entrantes también dentro de esa franja.

### 4.3 Herramienta de agenda y mail (antes "Agente 3")
Decisión de diseño (mía): **no es un agente autónomo**, es una herramienta que usa el Vendedor, porque sus tareas son acotadas. En el hub se muestra como función separada.
- Consulta Google Calendar de Lauri y propone 2–3 huecos libres dentro de una franja configurable.
- Al confirmar: crea el evento con link de Google Meet e invita al psicólogo.
- Envía mail de confirmación desde el Gmail de Lauri, con su estilo.
- El Vendedor debe obtener el mail del psicólogo durante la charla.

### 4.4 Orquestador — Supervisor
- No tiene rol de negocio propio; coordina y vigila.
- Dispara al Buscador a las 9:00; reparte hasta 5 contactos nuevos por día al Vendedor.
- Detecta conversaciones que necesitan seguimiento, trabadas, o que piden ayuda.
- Notifica a Lauri: en el hub y por **WhatsApp al chat "Mensaje a mí mismo"** de Lauri. Eventos que notifican: "te necesito" (pregunta sin respuesta), "listo para cerrar", "reunión agendada", fallas del sistema.
- Vigila salud: sesión de WhatsApp desvinculada (pide reescanear QR), agentes con fallas repetidas, tope de gasto diario de IA, señales de bloqueos/reportes (freno de envíos nuevos).

### 4.5 Hub de operaciones (opción B elegida)
Web privada, en la nube, con login, usable desde Mac y celular.
- **Arriba:** métricas — encontrados, contactados, respondieron (%), listos para cerrar, rechazados, sin respuesta, "te necesitan". Se ajustarán con el tiempo.
- **Izquierda:** lista de psicólogos ordenada por urgencia (primero "te necesitan", luego "listo para cerrar", luego por actividad reciente), con su estado.
- **Derecha:** al seleccionar uno, chat completo de WhatsApp, ficha, y evaluación del agente sobre cómo va la charla.
- **Responder escalaciones** desde el hub.
- **Sección de mejoras:** propuestas de cambio al manual con su evidencia; botón aprobar/rechazar; historial de versiones y resultados.
- **Estados iniciales** (editables sin rehacer el sistema): Encontrado, Contactado, Conversando, Interesado, Reunión agendada, Listo para cerrar, Rechazado, Sin respuesta, Baja.

### 4.6 Ciclo de mejora de la técnica de venta
- Cada conversación queda etiquetada: versión del manual/primer mensaje, objeciones, punto de corte, resultado.
- Análisis periódico (semanal) busca patrones.
- Propone cambios al manual en el hub, con evidencia. **Lauri aprueba**; nada cambia solo.
- Los cambios aprobados se prueban como A/B contra la versión anterior sobre contactos nuevos.
- **Umbral estadístico:** no se declara un resultado (ni se propone un cambio como "probado") sin una cantidad mínima de casos por variante; por debajo, se informa como "tendencia sin confirmar".
- Manual versionado con rollback.

### 4.7 Seguridad de WhatsApp personal
- **Lista blanca:** los agentes solo leen y escriben en chats de prospectos iniciados por el sistema (o registrados como prospectos). Todo otro chat se ignora a nivel código, no por instrucción al modelo.
- Ritmo: máx. 5 nuevos/día, espaciados, en horario laboral; nunca en ráfaga.
- Freno: si se acumulan bloqueos/reportes o señales de restricción, se pausan los contactos nuevos y se avisa.
- Si un psicólogo pregunta o sospecha que habla con un bot: el Vendedor **deja de escribir**, responde a lo sumo algo neutral breve, y **escala a Lauri** en el hub (notificación "sospecha de bot"); Lauri toma la charla. (Decisión de Lauri.)

## 5. Infraestructura (decisiones mías, cambiables)

- **Un VPS Linux** (≈10–20 USD/mes) con todo: hub, agentes, base de datos, y un navegador headless que mantiene la sesión de WhatsApp Web.
- **Stack sugerido:** TypeScript/Node.js (las librerías de WhatsApp Web maduras son Node, p. ej. whatsapp-web.js o Baileys), Vercel AI SDK (multi-proveedor, ver IA abajo) para los agentes, PostgreSQL como base de datos y cola de mensajes entre agentes (o Redis si hace falta), hub en Next.js. Procesos gestionados con Docker Compose, con reinicio automático.
- **Acceso administrativo** al servidor por Tailscale/SSH; el hub público con HTTPS y login.
- **IA (decisión de Lauri): modelos gratuitos en esta etapa.** Proveedores con plan gratuito vía API (p. ej. Google Gemini, Groq, modelos gratuitos de OpenRouter). Lauri adaptará luego a sus modelos pagos.
  - **Capa de modelos intercambiable (requisito):** ningún agente llama a un proveedor directamente; todo pasa por una capa común configurable por agente (proveedor + modelo + API key en variables de entorno). Cambiar de modelo gratis a pago debe ser editar configuración, no código. Por eso se usa un SDK multi-proveedor (p. ej. Vercel AI SDK, que soporta Gemini, Groq, OpenRouter, Anthropic y Ollama) en lugar del Claude Agent SDK.
  - **Fallback:** si un proveedor gratuito devuelve límite de uso, se reintenta con otro proveedor configurado; si todos fallan, la conversación espera (nunca se envía un mensaje vacío o roto) y el Orquestador avisa.
  - **Riesgos aceptados:** límites diarios de los planes gratuitos; algunos proveedores gratuitos usan los datos para entrenamiento (las conversaciones con psicólogos pasarían por ellos); calidad conversacional menor que modelos pagos.
- **Servidor:** lo elige y contrata Lauri. Requisitos mínimos: Linux, 2 vCPU, 4 GB RAM, Docker, IP fija.
- **Credenciales:** Google (Calendar + Gmail) vía OAuth de la cuenta de Lauri; secretos fuera del código.

## 6. Qué queda a criterio del constructor
- Esquema exacto de base de datos y formato de mensajes entre agentes.
- Elección final entre whatsapp-web.js y Baileys.
- Estrategia concreta de scraping/búsqueda por fuente, respetando §3.
- Diseño visual del hub (respetando el layout de §4.5).
- Umbral estadístico concreto y método de comparación A/B.
- Secuencia de seguimiento por defecto si el manual no la define.

## 7. Pendientes

1. **IA:** resuelto — modelos gratuitos con capa intercambiable (ver §5).
2. **Insumos que provee Lauri antes de producción:** manual de ventas (`.md`), ficha de producto del CRM (`.md`), patrones de escritura (`.md`, puede llegar después).
3. **Trámites de Lauri:** alta como usuario del Registro "No Llame" ante la AAIP para consulta automatizada; evaluar registro de la base de datos ante la AAIP (Ley 25.326).

## 8. Decisiones tomadas por el diseñador (revisar)
- Agenda/mail como herramienta del Vendedor, no agente propio.
- Respuestas de Lauri a escalaciones se guardan como conocimiento reutilizable.
- Notificaciones a Lauri por WhatsApp "Mensaje a mí mismo" además del hub.
- Stack TypeScript/Node + Vercel AI SDK (multi-proveedor) + PostgreSQL + Next.js + Docker Compose.
- Horarios de envío y de reuniones configurables (por defecto lun–vie, 9–20 h envíos; 10–18 h reuniones).
- Análisis de mejoras semanal, con umbral mínimo de casos antes de proponer.
