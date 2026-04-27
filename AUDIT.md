# Auditoría de código — `eml2pdf`

Revisión inicial de `main` y notas sobre los fixes aplicados en esta rama.

El servicio renderiza HTML **no confiable** (correo) en Chromium headless y queremos:
- **Cargar imágenes remotas** (modo normal de operación).
- **Fidelidad de render alta** (CSS, fuentes web, layout de email — incluido HTML viejo de Outlook/Word).

Por tanto la postura es: *bloquear ejecución* (JS, scripts, formularios, navegación) sin tocar el resto, y *filtrar destinos peligrosos* en lugar de cortar la red entera.

Clasificación:
- 🔴 **Crítico** — explotable o pérdida de datos / DoS realista.
- 🟠 **Alto** — bug real, race o degradación grave bajo carga.
- 🟡 **Medio** — hardening, robustez, edge cases.
- 🟢 **Bajo / nit** — calidad, mantenibilidad, observabilidad.

✅ marcado = aplicado en esta rama.

---

## 1. Seguridad

### 🔴 1.1 SSRF — `loadRemoteImages` controlable por el cliente y red sin filtrar ✅
[`src/server.js`](src/server.js), [`src/convert.js`](src/convert.js)

Antes: `options.loadRemoteImages` podía elevar sobre la env, y el `waitUntil: 'commit'` no impedía las peticiones — Chromium seguía disparando a `<img src="http://169.254.169.254/...">`, IMDS, red interna, beacons.

Aplicado:
- La env actúa como **techo**, no como default: el cliente sólo puede *desactivar*, nunca *elevar* (`server.js: LOAD_REMOTE_IMAGES && clientWantsRemote`).
- `context.route('**/*', ...)` en todos los renders. Filtra:
  - Esquemas: sólo `http`/`https`/`data`/`about`/`blob`. Bloquea `file:`, `chrome:`, `javascript:`, etc.
  - DNS: resuelve el host con `dns.lookup({ all: true })`. Si **alguna** IP cae en loopback / RFC1918 / link-local 169.254/16 (IMDS) / CGNAT 100.64/10 / ULA `fc00::/7` / link-local v6, se aborta. Esto neutraliza DNS rebinding y multi-A.
  - Hostname denylist: `localhost`, `metadata.google.internal`, `*.local`, `*.localhost`.
  - Cache 30 s para no penalizar latencia.
- Fail-closed: si la resolución DNS falla, se bloquea.
- Cuando `loadRemoteImages=false`, se aborta toda petición http(s) además de los privados.

Ver [`src/netfilter.js`](src/netfilter.js).

---

### 🔴 1.2 HTML del correo se renderizaba con JS habilitado y sin sanitizar ✅
[`src/convert.js`](src/convert.js)

Antes: `mail.html` se inyectaba tal cual; `<script>`, `<iframe srcdoc>`, `onload`, `meta refresh` se ejecutaban en el contexto del render.

Aplicado, manteniendo fidelidad:
- `context.setJavaScriptEnabled(false)`. Ningún cliente de correo serio ejecuta JS — no degrada nada.
- Sanitización con `sanitize-html` en modo permisivo: se conservan **todas** las tags y atributos de layout/typography (tablas, divs, spans, `style`, `class`, `width`/`height`, `bgcolor`, `colspan`, etc.) y se eliminan `script`, `iframe`, `object`, `embed`, `frame`, `form` y derivados, `base`, handlers `on*`, y URLs `javascript:` / `vbscript:` / `data:text/html`.
- CSP permisiva inyectada en `<head>`:
  ```
  default-src 'none';
  img-src http: https: data: cid:;
  style-src 'unsafe-inline' http: https:;
  font-src http: https: data:;
  media-src http: https: data:;
  script-src 'none';
  frame-src 'none';
  object-src 'none';
  base-uri 'none';
  form-action 'none';
  ```
  Imágenes / hojas de estilo / fuentes web siguen funcionando — fidelidad intacta.

---

### 🟠 1.3 Aislamiento débil del browser ✅ (parcial)
- `BrowserContext` por request con JS off (1.2).
- `browser.on('disconnected', …)` invalida la promesa singleton — el siguiente request relanza limpio.
- Pendiente (🟢): reciclado proactivo cada N renders para mitigar leaks de Chromium en uptime largo.

### 🟠 1.4 Contenedor como root + `--no-sandbox` ✅
[`Dockerfile`](Dockerfile)

`USER pwuser` añadido. `chown` a `pwuser` en build. `--no-sandbox` se mantiene (necesario fuera de un sandbox del kernel) pero ahora compensado con: usuario no root, `cap_drop: ALL`, `no-new-privileges:true` en compose.

### 🟠 1.5 Sin auth ni rate-limit ✅ (parcial)
- `API_KEY` opcional vía header `X-API-Key`, comparado con `crypto.timingSafeEqual`.
- Bind a `127.0.0.1:3005` por defecto en compose — se asume reverse proxy o red Docker compartida.
- Pendiente (🟢): rate-limit por IP. Mejor delegado a un reverse proxy (nginx/caddy/traefik) que reimplementarlo.

### 🟡 1.6 Errores literales al cliente ✅
5xx ahora devuelve `"Internal error"` y se logea con `requestId`. 4xx mantiene mensaje útil.

### 🟡 1.7 Colisión de filenames en ZIP ✅
`extractAttachments` lleva contador por nombre y desambigua: `photo.jpg`, `photo_1.jpg`, `photo_2.jpg`. Filenames sanitizados también contra control chars y `..` líder.

### 🟡 1.8 Base64 inválido aceptado en silencio ✅
Validación con regex y rechazo explícito (`400 Invalid base64 payload`) para `rawBase64Url` y `emlBase64`.

---

## 2. Concurrencia y resiliencia

### 🔴 2.1 Race en `getBrowser()` → fugas de Chromium ✅
Ahora un **promise singleton** en `convert.js`. La primera llamada lanza, las concurrentes esperan a la misma promesa. Si falla, `_browserPromise` se nulea. Si el browser se desconecta, también.

### 🔴 2.2 Sin límite de concurrencia ✅
Semáforo simple en `server.js` con `MAX_CONCURRENT_RENDERS` (default 3). Las peticiones por encima del cupo esperan en cola FIFO. Cuando la cola sea problema (no hoy), devolver 503 con `Retry-After`.

### 🟠 2.3 `parseMultipart`: reject/resolve duplicados ✅
Flag `settled` + helpers `safeReject`/`safeResolve`. `req.unpipe(bb)` y `req.destroy()` en reject. Listener de `stream 'limit'` y `req 'aborted'`. Límites adicionales: `files: 1`, `fields: 20`, `fieldSize: 1MB`.

### 🟠 2.4 `readJsonBody` corrompía UTF-8 multibyte ✅
Cambiado a `Buffer.concat(chunks).toString('utf8')`.

### 🟠 2.5 Sin timeouts de socket ✅
```js
server.headersTimeout = 30_000;
server.requestTimeout = 5 * 60_000;
server.keepAliveTimeout = 5_000;
```

### 🟠 2.6 Sin shutdown limpio ✅
Handlers `SIGTERM`/`SIGINT`: `server.close()`, espera a in-flight (deadline 30s), `browser.close()`. Exporta `shutdownBrowser()` desde `convert.js`.

### 🟡 2.7 ZIP enteramente en memoria
Pendiente. `archiver` se sigue acumulando en `chunks[]`. Para escalar, hacer `zip.pipe(res)` y `res.writeHead(...)` antes. Bajo riesgo con `MAX_REQUEST_MB=50` y concurrencia 3.

### 🟡 2.8 Medición de altura con remoto ✅
Con remoto: `waitUntil: 'networkidle'` + `document.fonts.ready` + 2× `requestAnimationFrame` antes de leer `scrollHeight`. Fuentes web no fastidian la medida.

### 🟡 2.9 CIDs no referenciados se perdían como adjunto ✅
`buildHtml` ahora marca como “inline usado” *sólo* las imágenes con `cid:` realmente referenciadas en el HTML. Las que tienen `Content-ID` pero nadie las cita, salen como adjunto normal en `attachments/`.

### 🟡 2.10 Colisión de filename del PDF
Aceptable: cada ZIP es independiente. Si downstream descomprime varios al mismo destino, será problema del orquestador.

---

## 3. Robustez / corrección

### 🟡 3.1 `escapeHtml` sin `'` ✅
Añadido `&#39;`.

### 🟡 3.2 Strip de `@page` con regex frágil
Sin cambios — heurístico aceptable.

### 🟡 3.3 `messageId` del usuario sin validar ✅
Trunca a 998 chars y elimina control chars antes de meterlo en `metadata.json`.

### 🟡 3.4 `widthPx`/`maxHeightPx`/`timeout` sin clamp ✅
Helper `clamp()` con bounds:
- `widthPx`: 200..2400
- `maxHeightPx`: 200..200000
- `timeout`: 1000..300000 ms

### 🟢 3.5 `/health` siempre OK
Sin cambios — el `HEALTHCHECK` del Dockerfile usa ese endpoint, y Chromium se relanza on-demand.

---

## 4. Build / despliegue

### 🟡 4.1 Imagen base por tag mutable
Sin cambios — sugerido pinear por digest con Renovate.

### 🟡 4.2 `playwright` vs `playwright-core`
Sin cambios — la duplicación de browsers ocupa disco pero no rompe nada.

### 🟡 4.3 Falta `HEALTHCHECK` ✅
Añadido al Dockerfile (interval 30 s, timeout 5 s, start-period 10 s).

### 🟡 4.4 `docker-compose.yml` sin límites ✅
`mem_limit: 2g`, `cpus: 2.0`, `cap_drop: [ALL]`, `security_opt: no-new-privileges`.

### 🟢 4.5 Bind a `0.0.0.0` ✅
Cambiado a `127.0.0.1:3005:3000`. Para uso interno con n8n en misma red Docker, mejor `expose: ["3000"]` y red compartida.

---

## 5. Observabilidad / mantenimiento

- 🟢 **Logs** — ahora estructurados (JSON) con `requestId`, `durationMs`, `emlBytes`, `zipBytes`, `attachments`, `warnings`. Sin contenido del email.
- 🟢 **Métricas** — pendiente (`prom-client` + `/metrics`).
- 🟢 **Tests / CI** — pendiente.
- 🟢 **Vulns transitivas** — `npm audit fix` aplicado al lockfile (mailparser 3.7.2 → 3.x parcheada, nodemailer transitivo).

---

## 6. Resumen de lo aplicado en esta rama

✅ JS off + sanitize-html permisivo + CSP permisiva (1.2)
✅ Filtro de red por DNS resolve + denylist de rangos privados (1.1)
✅ `loadRemoteImages` env como techo (1.1)
✅ getBrowser singleton-promise + listener disconnected (2.1)
✅ Semáforo de concurrencia configurable (2.2)
✅ USER pwuser + cap_drop + no-new-privileges + límites de recursos (1.4, 4.4)
✅ Bind a 127.0.0.1 + opción API_KEY (1.5)
✅ parseMultipart settled-flag + límites Busboy + handler 'limit'/'aborted' (2.3)
✅ readJsonBody con Buffer.concat (2.4)
✅ Socket timeouts + SIGTERM/SIGINT (2.5, 2.6)
✅ Clamp de opciones, validación de base64, mensaje de error 5xx genérico (1.6, 1.8, 3.4)
✅ Colisión de filenames en ZIP (1.7)
✅ CIDs no usados ahora viajan como adjuntos (2.9)
✅ messageId saneado (3.3)
✅ HEALTHCHECK + `document.fonts.ready` para fidelidad (4.3, 2.8)
✅ Logs estructurados con requestId (5)
✅ npm audit fix aplicado al lockfile

**Pendiente** (futuras iteraciones):
- Streaming directo del ZIP a `res` (2.7)
- Reciclado proactivo del browser cada N renders (1.3)
- Rate-limit (delegable a reverse proxy)
- Tests + CI con smoke fixture
- `/metrics` Prometheus
- Pin de imagen base por digest
