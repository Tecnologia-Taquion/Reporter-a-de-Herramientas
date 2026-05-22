# Auto-fetch de Changelogs — Workflow n8n

Workflow que monitorea las páginas de release notes / changelogs de tus herramientas, usa Claude para extraer y resumir las novedades, las escribe en una hoja "Sugerencias" del Google Sheet, y te notifica por email si alguna fuente se rompe.

---

## Qué hace en cada corrida

```
[ Schedule diario 9 AM ]
        ↓
[ Lista de fuentes a chequear (configurable) ]
        ↓  por cada fuente:
        ├─→ [ HTTP GET de la página ]
        │        ↓
        │   [ Limpia HTML / parsea RSS ]
        │        ↓
        │   [ Claude lee el texto y extrae las últimas entries en JSON ]
        │        ↓
        │   [ Compara contra "last_seen" (staticData del workflow) ]
        │        ↓  solo las nuevas:
        │   [ Claude resume cada novedad en 2 líneas + sugiere "Próximo paso" ]
        │        ↓
        │   [ Append row en Google Sheet "Sugerencias" ]
        │        ↓
        │   [ Si hubo error en cualquier paso → marca esta fuente como ROTA ]
        ↓
[ Si hay fuentes rotas → email a vos con el listado ]
```

**Diseño clave:** la extracción la hace el LLM sobre el HTML pelado. Eso significa que **si cambia el layout de la página, el workflow no se rompe** — el LLM se adapta. Solo se rompe si:
- La URL devuelve 404/500 (URL cambió de path)
- El LLM no encuentra ninguna entrada parseable (el formato es radicalmente distinto)

En ambos casos te llega un mail.

---

## Fuentes incluidas en el workflow

| ID | Herramienta | URL | Tipo |
|---|---|---|---|
| `notion` | Notion | https://www.notion.so/releases | HTML |
| `github` | GitHub Blog | https://github.blog/changelog/feed/ | RSS |
| `claude` | Claude / Anthropic | https://www.anthropic.com/news | HTML |
| `openai` | ChatGPT / OpenAI | https://help.openai.com/en/articles/6825453-chatgpt-release-notes | HTML |
| `figma` | Figma | https://www.figma.com/release-notes/ | HTML |
| `vercel` | Vercel | https://vercel.com/changelog/feed.xml | RSS |
| `cloudflare` | Cloudflare | https://blog.cloudflare.com/tag/release-notes/rss/ | RSS |
| `n8n` | n8n | https://docs.n8n.io/release-notes/ | HTML |

Las podés editar después en el primer nodo Code (`Define Sources`).

---

## Setup previo (una sola vez)

### 1) Credenciales en n8n

Tenés que crear 3 credenciales antes de importar el workflow:

**a) Anthropic API**
- Andá a https://console.anthropic.com → Settings → API Keys → Create Key
- Copiá el key (`sk-ant-...`)
- En n8n: Settings → Credentials → New → "HTTP Header Auth"
- Name: `Anthropic API`
- Header Name: `x-api-key`
- Header Value: el key
- Save

**b) Google Sheets**
- En n8n: Credentials → New → "Google Sheets OAuth2 API" (o Service Account si preferís)
- Seguí el flujo de autenticación de Google
- Nombre sugerido: `Google Sheets Taquión`

**c) Email (SMTP o Gmail)**
- Credentials → New → "SMTP" (Gmail funciona con App Password)
- O usá el nodo "Send Email" con credenciales SMTP
- Nombre sugerido: `Email Notificaciones`

### 2) Preparar la hoja "Sugerencias"

En tu Google Sheet `https://docs.google.com/spreadsheets/d/116pmPoOiZ5CVwTYRYHpBUaV1FcdLw8KH/edit`:

1. Creá una hoja nueva llamada `SUGERENCIAS`
2. Pegá esta primera fila como encabezado:

```
fecha_deteccion | herramienta | fuente_url | titulo_original | resumen | proximo_paso | estado | bimestre_destino
```

### 3) Configurar el destinatario del email de alertas

En el nodo final `Send Email Alert`, cambiá el campo "To Email" a tu mail.

---

## Importar el workflow en n8n

1. Abrí n8n → Workflows → **Add workflow** → menú `⋮` arriba a la derecha → **Import from File** (o **Import from URL**).
2. Pegá el siguiente JSON en un archivo `.json` y subilo:

```json
{
  "name": "Auto-fetch Changelogs Herramientas",
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [
            {
              "field": "hours",
              "hoursInterval": 24,
              "triggerAtHour": 9
            }
          ]
        }
      },
      "name": "Schedule Trigger",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1,
      "position": [200, 400]
    },
    {
      "parameters": {
        "jsCode": "// Edita acá la lista de fuentes a monitorear.\n// type: 'html' o 'rss'\n// Para agregar una herramienta: pegá un objeto nuevo siguiendo el formato.\n\nconst sources = [\n  { id: 'notion',     name: 'Notion',             url: 'https://www.notion.so/releases',                                            type: 'html' },\n  { id: 'github',     name: 'GitHub',             url: 'https://github.blog/changelog/feed/',                                       type: 'rss'  },\n  { id: 'claude',     name: 'Claude / Anthropic', url: 'https://www.anthropic.com/news',                                            type: 'html' },\n  { id: 'openai',     name: 'ChatGPT / OpenAI',   url: 'https://help.openai.com/en/articles/6825453-chatgpt-release-notes',         type: 'html' },\n  { id: 'figma',      name: 'Figma',              url: 'https://www.figma.com/release-notes/',                                      type: 'html' },\n  { id: 'vercel',     name: 'Vercel',             url: 'https://vercel.com/changelog/feed.xml',                                     type: 'rss'  },\n  { id: 'cloudflare', name: 'Cloudflare',         url: 'https://blog.cloudflare.com/tag/release-notes/rss/',                        type: 'rss'  },\n  { id: 'n8n',        name: 'n8n',                url: 'https://docs.n8n.io/release-notes/',                                        type: 'html' },\n];\n\nreturn sources.map(s => ({ json: s }));"
      },
      "name": "Define Sources",
      "type": "n8n-nodes-base.code",
      "typeVersion": 1,
      "position": [420, 400]
    },
    {
      "parameters": {
        "batchSize": 1,
        "options": {}
      },
      "name": "Loop Sources",
      "type": "n8n-nodes-base.splitInBatches",
      "typeVersion": 2,
      "position": [640, 400]
    },
    {
      "parameters": {
        "url": "={{ $json.url }}",
        "options": {
          "timeout": 20000,
          "redirect": {
            "redirect": {
              "followRedirects": true
            }
          },
          "response": {
            "response": {
              "responseFormat": "text",
              "neverError": true,
              "fullResponse": true
            }
          }
        },
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            { "name": "User-Agent", "value": "Mozilla/5.0 (compatible; TaquionBot/1.0)" }
          ]
        }
      },
      "name": "Fetch Page",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4,
      "position": [860, 400],
      "continueOnFail": true
    },
    {
      "parameters": {
        "jsCode": "// Limpia HTML / RSS para pasarle al LLM\n// Detecta también si la URL devolvió error.\n\nconst out = [];\nfor (const item of $input.all()) {\n  const src = item.json;\n  const statusCode = item.json.statusCode || (item.json.response && item.json.response.statusCode) || 200;\n  const body = item.json.body || item.json.data || '';\n\n  if (typeof statusCode === 'number' && (statusCode >= 400 || statusCode === 0)) {\n    out.push({ json: { ...src, error: `HTTP ${statusCode}`, errorStage: 'fetch' } });\n    continue;\n  }\n  if (!body || typeof body !== 'string' || body.length < 200) {\n    out.push({ json: { ...src, error: 'Respuesta vacía o demasiado corta', errorStage: 'fetch' } });\n    continue;\n  }\n\n  let cleaned = body;\n  if (src.type === 'html') {\n    cleaned = body\n      .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')\n      .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')\n      .replace(/<!--[\\s\\S]*?-->/g, ' ')\n      .replace(/<[^>]+>/g, ' ')\n      .replace(/&nbsp;/g, ' ')\n      .replace(/&amp;/g, '&')\n      .replace(/&lt;/g, '<')\n      .replace(/&gt;/g, '>')\n      .replace(/&quot;/g, '\"')\n      .replace(/&#39;/g, \"'\")\n      .replace(/\\s+/g, ' ')\n      .trim();\n  } else if (src.type === 'rss') {\n    // Para RSS dejamos el XML; el LLM lo entiende bien.\n    cleaned = body.replace(/\\s+/g, ' ').trim();\n  }\n\n  // Limita el contexto al LLM\n  cleaned = cleaned.slice(0, 12000);\n\n  out.push({ json: { ...src, cleanedText: cleaned } });\n}\nreturn out;"
      },
      "name": "Clean Content",
      "type": "n8n-nodes-base.code",
      "typeVersion": 1,
      "position": [1080, 400]
    },
    {
      "parameters": {
        "conditions": {
          "string": [
            { "value1": "={{ $json.error }}", "operation": "isEmpty" }
          ]
        }
      },
      "name": "Has Content?",
      "type": "n8n-nodes-base.if",
      "typeVersion": 1,
      "position": [1300, 400]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "https://api.anthropic.com/v1/messages",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            { "name": "anthropic-version", "value": "2023-06-01" },
            { "name": "content-type", "value": "application/json" }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({\n  model: 'claude-haiku-4-5',\n  max_tokens: 1500,\n  temperature: 0.2,\n  system: 'Sos un asistente que extrae las novedades más recientes de una página de changelog/release notes de una herramienta SaaS. Devolvés JSON estricto. Si no encontrás entradas reconocibles, devolvés {\"entries\": [], \"reason\": \"no se detectó estructura de changelog\"}. No agregues texto fuera del JSON.',\n  messages: [{\n    role: 'user',\n    content: 'Herramienta: ' + $json.name + '\\nURL: ' + $json.url + '\\n\\nContenido de la página:\\n\\n' + $json.cleanedText + '\\n\\n---\\n\\nExtraé las 5 entradas más recientes del changelog. Para cada una devolvé: title (string), date (ISO YYYY-MM-DD si es claro, sino el string original), url (link absoluto si encontrás, sino el de la página principal), excerpt (1-3 oraciones describiendo el cambio).\\n\\nResponde SOLO con un JSON con esta forma exacta: {\"entries\": [{\"title\": \"...\", \"date\": \"...\", \"url\": \"...\", \"excerpt\": \"...\"}], \"reason\": null}'\n  }]\n}) }}",
        "options": {
          "timeout": 30000,
          "response": {
            "response": {
              "neverError": true,
              "fullResponse": true
            }
          }
        }
      },
      "name": "LLM Extract Entries",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4,
      "position": [1520, 300],
      "continueOnFail": true,
      "credentials": {
        "httpHeaderAuth": {
          "name": "Anthropic API"
        }
      }
    },
    {
      "parameters": {
        "jsCode": "// Parsea la respuesta del LLM y detecta si extrajo entradas válidas.\n// Compara contra staticData['lastSeen'][sourceId] para filtrar solo lo nuevo.\n\nconst staticData = $getWorkflowStaticData('global');\nstaticData.lastSeen = staticData.lastSeen || {};\n\nconst out = [];\nfor (const item of $input.all()) {\n  const src = item.json;\n  const apiResp = src.body || src;\n  let textBlock = null;\n\n  try {\n    if (apiResp && apiResp.content && Array.isArray(apiResp.content)) {\n      textBlock = apiResp.content.find(c => c.type === 'text');\n    }\n  } catch (e) {}\n\n  if (!textBlock) {\n    out.push({ json: { ...src, error: 'LLM no devolvió contenido', errorStage: 'llm_extract' } });\n    continue;\n  }\n\n  let parsed;\n  try {\n    const jsonMatch = textBlock.text.match(/\\{[\\s\\S]*\\}/);\n    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : textBlock.text);\n  } catch (e) {\n    out.push({ json: { ...src, error: 'JSON inválido del LLM: ' + e.message, errorStage: 'llm_extract' } });\n    continue;\n  }\n\n  const entries = parsed.entries || [];\n  if (!entries.length) {\n    out.push({ json: { ...src, error: 'LLM no detectó entradas (posible cambio de layout): ' + (parsed.reason || 'sin razón'), errorStage: 'no_entries' } });\n    continue;\n  }\n\n  // Filtrar contra last seen\n  const sourceId = src.id;\n  const lastSeen = staticData.lastSeen[sourceId];\n  const lastSeenSet = new Set((lastSeen && lastSeen.titles) || []);\n\n  // Primera corrida: tomar solo las 2 más recientes para no inundar\n  const newEntries = lastSeen\n    ? entries.filter(e => !lastSeenSet.has(e.title))\n    : entries.slice(0, 2);\n\n  // Actualizar last seen con todos los títulos vistos en esta corrida (top 10)\n  staticData.lastSeen[sourceId] = {\n    titles: entries.slice(0, 10).map(e => e.title),\n    updatedAt: new Date().toISOString(),\n  };\n\n  if (newEntries.length === 0) {\n    // No hay nada nuevo, no es error\n    continue;\n  }\n\n  for (const entry of newEntries) {\n    out.push({\n      json: {\n        source: src,\n        entry,\n      }\n    });\n  }\n}\nreturn out;"
      },
      "name": "Filter New Entries",
      "type": "n8n-nodes-base.code",
      "typeVersion": 1,
      "position": [1740, 300]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "https://api.anthropic.com/v1/messages",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            { "name": "anthropic-version", "value": "2023-06-01" },
            { "name": "content-type", "value": "application/json" }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({\n  model: 'claude-haiku-4-5',\n  max_tokens: 600,\n  temperature: 0.3,\n  system: 'Sos un analista que resume novedades técnicas de herramientas SaaS para un equipo no-técnico de marketing/operaciones. Devolvés JSON estricto, sin texto fuera del JSON.',\n  messages: [{\n    role: 'user',\n    content: 'Herramienta: ' + $json.source.name + '\\nTítulo: ' + $json.entry.title + '\\nFecha: ' + ($json.entry.date || 'sin fecha') + '\\nDetalle:\\n' + ($json.entry.excerpt || $json.entry.title) + '\\n\\nResumí esta novedad en español neutro siguiendo estas reglas:\\n- resumen: 1-2 líneas, máximo 220 caracteres, qué cambió y por qué importa\\n- proximo_paso: 1 línea, máximo 140 caracteres, qué debería evaluar el equipo (revisar política, probar feature, comunicar al equipo, etc.)\\n- relevancia: alta | media | baja, según qué tan importante sea para un equipo que usa la herramienta\\n\\nDevolvé SOLO este JSON: {\"resumen\": \"...\", \"proximo_paso\": \"...\", \"relevancia\": \"alta|media|baja\"}'\n  }]\n}) }}",
        "options": {
          "timeout": 30000,
          "response": {
            "response": {
              "neverError": true,
              "fullResponse": true
            }
          }
        }
      },
      "name": "LLM Summarize",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4,
      "position": [1960, 300],
      "continueOnFail": true,
      "credentials": {
        "httpHeaderAuth": {
          "name": "Anthropic API"
        }
      }
    },
    {
      "parameters": {
        "jsCode": "// Parsea el resumen del LLM y arma la fila para Google Sheets\n\nconst out = [];\nfor (const item of $input.all()) {\n  const apiResp = item.json.body || item.json;\n  let textBlock = null;\n  try {\n    if (apiResp && apiResp.content && Array.isArray(apiResp.content)) {\n      textBlock = apiResp.content.find(c => c.type === 'text');\n    }\n  } catch (e) {}\n\n  let summary = { resumen: '(no se pudo resumir)', proximo_paso: '', relevancia: 'media' };\n  if (textBlock) {\n    try {\n      const m = textBlock.text.match(/\\{[\\s\\S]*\\}/);\n      summary = JSON.parse(m ? m[0] : textBlock.text);\n    } catch (e) {}\n  }\n\n  // El objeto fuente y entry vienen del input original. n8n preserva $json en el contexto\n  // de cada paso, así que reconstruimos desde el item anterior si está disponible.\n  const source = item.json.source || {};\n  const entry  = item.json.entry  || {};\n\n  out.push({\n    json: {\n      fecha_deteccion: new Date().toISOString().split('T')[0],\n      herramienta: source.name || 'desconocida',\n      fuente_url: entry.url || source.url || '',\n      titulo_original: entry.title || '',\n      resumen: summary.resumen,\n      proximo_paso: summary.proximo_paso,\n      relevancia: summary.relevancia,\n      estado: 'pendiente',\n      bimestre_destino: ''\n    }\n  });\n}\nreturn out;"
      },
      "name": "Format for Sheet",
      "type": "n8n-nodes-base.code",
      "typeVersion": 1,
      "position": [2180, 300]
    },
    {
      "parameters": {
        "operation": "append",
        "documentId": "116pmPoOiZ5CVwTYRYHpBUaV1FcdLw8KH",
        "sheetName": "SUGERENCIAS",
        "columns": {
          "mappingMode": "defineBelow",
          "value": {
            "fecha_deteccion": "={{ $json.fecha_deteccion }}",
            "herramienta": "={{ $json.herramienta }}",
            "fuente_url": "={{ $json.fuente_url }}",
            "titulo_original": "={{ $json.titulo_original }}",
            "resumen": "={{ $json.resumen }}",
            "proximo_paso": "={{ $json.proximo_paso }}",
            "relevancia": "={{ $json.relevancia }}",
            "estado": "={{ $json.estado }}",
            "bimestre_destino": "={{ $json.bimestre_destino }}"
          }
        },
        "options": {}
      },
      "name": "Append to Sheet",
      "type": "n8n-nodes-base.googleSheets",
      "typeVersion": 4,
      "position": [2400, 300],
      "credentials": {
        "googleSheetsOAuth2Api": {
          "name": "Google Sheets Taquión"
        }
      }
    },
    {
      "parameters": {
        "jsCode": "// Junta los errores de todas las fuentes para enviar un único mail al final.\n\nconst errors = [];\nfor (const item of $input.all()) {\n  if (item.json && item.json.error) {\n    errors.push({\n      herramienta: item.json.name || item.json.source?.name || 'desconocida',\n      url: item.json.url || '',\n      stage: item.json.errorStage || 'unknown',\n      error: item.json.error,\n    });\n  }\n}\nif (errors.length === 0) return [];\nreturn [{ json: { errors, count: errors.length, fecha: new Date().toISOString() } }];"
      },
      "name": "Collect Errors",
      "type": "n8n-nodes-base.code",
      "typeVersion": 1,
      "position": [1740, 540]
    },
    {
      "parameters": {
        "fromEmail": "alertas@taquion.com.ar",
        "toEmail": "tecnologia@taquion.com.ar",
        "subject": "⚠️ Auto-fetch Changelogs: {{ $json.count }} fuente(s) con problemas",
        "emailFormat": "html",
        "html": "=<h2>El workflow detectó problemas al chequear novedades</h2>\n<p>Fecha: {{ $json.fecha }}</p>\n<table border=\"1\" cellpadding=\"6\" cellspacing=\"0\" style=\"border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px\">\n  <tr style=\"background:#f3f4f6\"><th>Herramienta</th><th>Etapa</th><th>Error</th><th>URL</th></tr>\n  {{ $json.errors.map(e => `<tr><td>${e.herramienta}</td><td>${e.stage}</td><td>${e.error}</td><td><a href=\"${e.url}\">${e.url}</a></td></tr>`).join('') }}\n</table>\n<p><strong>Qué hacer:</strong></p>\n<ul>\n  <li><b>fetch</b> → la URL devolvió error. Verificá si la página cambió de URL.</li>\n  <li><b>no_entries</b> → el LLM no detectó entradas. Probable cambio fuerte de layout. Visitá la URL y, si el formato es nuevo, considerá actualizar el prompt o el tipo (html/rss).</li>\n  <li><b>llm_extract</b> → fallo del LLM al parsear. Reintentar manualmente o revisar quota de Anthropic.</li>\n</ul>",
        "options": {}
      },
      "name": "Send Email Alert",
      "type": "n8n-nodes-base.emailSend",
      "typeVersion": 2,
      "position": [1960, 540],
      "credentials": {
        "smtp": {
          "name": "Email Notificaciones"
        }
      }
    }
  ],
  "connections": {
    "Schedule Trigger": {
      "main": [[{ "node": "Define Sources", "type": "main", "index": 0 }]]
    },
    "Define Sources": {
      "main": [[{ "node": "Loop Sources", "type": "main", "index": 0 }]]
    },
    "Loop Sources": {
      "main": [
        [{ "node": "Fetch Page", "type": "main", "index": 0 }]
      ]
    },
    "Fetch Page": {
      "main": [[{ "node": "Clean Content", "type": "main", "index": 0 }]]
    },
    "Clean Content": {
      "main": [[{ "node": "Has Content?", "type": "main", "index": 0 }]]
    },
    "Has Content?": {
      "main": [
        [{ "node": "LLM Extract Entries", "type": "main", "index": 0 }],
        [{ "node": "Collect Errors", "type": "main", "index": 0 }]
      ]
    },
    "LLM Extract Entries": {
      "main": [[{ "node": "Filter New Entries", "type": "main", "index": 0 }]]
    },
    "Filter New Entries": {
      "main": [[{ "node": "LLM Summarize", "type": "main", "index": 0 }]]
    },
    "LLM Summarize": {
      "main": [[{ "node": "Format for Sheet", "type": "main", "index": 0 }]]
    },
    "Format for Sheet": {
      "main": [[{ "node": "Append to Sheet", "type": "main", "index": 0 }]]
    },
    "Collect Errors": {
      "main": [[{ "node": "Send Email Alert", "type": "main", "index": 0 }]]
    }
  },
  "settings": {
    "executionOrder": "v1"
  },
  "active": false
}
```

---

## Después de importar

1. **Mapear las credenciales** en cada nodo de la flecha de error rojita que va a aparecer:
   - `LLM Extract Entries` y `LLM Summarize` → seleccioná tu credencial `Anthropic API`
   - `Append to Sheet` → seleccioná `Google Sheets Taquión`
   - `Send Email Alert` → seleccioná `Email Notificaciones`
2. **Cambiar el email destinatario** en `Send Email Alert` (campo "To Email"). Por defecto está `tecnologia@taquion.com.ar`.
3. **Probar manualmente** clickeando "Execute Workflow" arriba a la derecha. Va a correr para todas las fuentes y deberías ver filas nuevas en la hoja `SUGERENCIAS`.
4. **Activar el schedule**: switch "Active" arriba a la derecha. A partir de ahí corre solo todos los días a las 9 AM.

---

## Cómo agregar una herramienta nueva

Abrí el nodo `Define Sources` y agregá un objeto más al array:

```js
{ id: 'donweb', name: 'Donweb', url: 'https://blog.donweb.com/category/novedades/feed/', type: 'rss' },
```

Reglas:
- `id`: identificador único en lowercase (sin espacios). Usado como key en `staticData.lastSeen`.
- `name`: el nombre que va a aparecer en la hoja "Sugerencias" (que debería matchear con el nombre en tu planilla principal).
- `url`: URL del changelog. Si la herramienta tiene RSS oficial, usá esa URL. Si no, la URL del HTML.
- `type`: `'html'` o `'rss'`. El RSS suele ser más estable.

Guardás y la próxima corrida ya lo incluye.

---

## Cómo conectar las sugerencias con el panel

Hoy las sugerencias caen en la hoja `SUGERENCIAS` del Sheet. Hay dos formas de integrarlas con el panel web:

**Opción 1 (rápida, sin desarrollo):** los líderes abren la hoja `SUGERENCIAS`, filtran por su herramienta, copian el resumen y lo pegan en la celda correspondiente del bimestre actual. Después marcan `estado = aceptada` en la hoja `SUGERENCIAS`.

**Opción 2 (integrada, requiere extender el panel):** agregamos en el panel una pestaña "📥 Sugerencias pendientes" que muestra todas las filas con `estado = pendiente`. Cada una con dos botones: "Aceptar (mover al bimestre actual)" y "Descartar". Eso requiere extender el panel para escribir en el Sheet (necesita service account + ~2 días de desarrollo).

Para arrancar, **opción 1**. Si después de 1-2 bimestres ves que efectivamente te ahorra trabajo, pasamos a la 2.

---

## Costos

- **Anthropic Claude Haiku 4.5**: ~$0.80/M input, ~$4/M output. Por corrida diaria con 8 fuentes:
  - Extract: 8 × ~5000 tokens in + ~600 out ≈ ~$0.04
  - Summarize: ~5 nuevas entradas/día × 200 in + 150 out ≈ ~$0.003
  - **Total: ~$0.05/día ≈ ~$1.50/mes**

Despreciable.

---

## Troubleshooting

**"Me llegó un mail de no_entries para X herramienta"**
- Abrí la URL en el browser. ¿Cambió radicalmente el layout? ¿La página requiere login ahora?
- Si la página existe pero el formato es muy distinto, probá visitar el cache de Google con `cache:URL` y ver el HTML anterior.
- Solución: a veces hay que cambiar la URL a una más específica (ej. en vez de la home del blog, ir directo al feed RSS).

**"Me llegó un mail de fetch HTTP 404"**
- La URL cambió. Buscá la nueva URL del changelog y actualizá en `Define Sources`.

**"El LLM se inventa entradas"**
- Bajá temperature de 0.2 a 0.0 en el nodo `LLM Extract Entries`.
- O cambiá Haiku 4.5 por Sonnet 4.5 (más caro pero más confiable). Cambiar `claude-haiku-4-5` por `claude-sonnet-4-5` en ese nodo.

**"Sigue trayendo las mismas novedades cada día"**
- El staticData se perdió. n8n lo guarda en el workflow. Si exportás/importás, se pierde.
- Solución: dejá que corra un día más, las entradas se van a marcar como "seen" y dejará de duplicar.

**"Querés ver qué hay en staticData"**
- En cualquier Code node, agregá temporalmente: `console.log(JSON.stringify($getWorkflowStaticData('global'), null, 2));`
- Mirá la pestaña "Executions" del workflow → última ejecución → output del Code node.

---

## Próximos pasos opcionales

- **Filtrar por relevancia**: solo escribir a la hoja las entries con `relevancia = alta` o `media`. Agregar un nodo IF antes de `Append to Sheet`.
- **Notificación Slack/Telegram** además del email: agregar nodo paralelo a `Send Email Alert`.
- **Resumen semanal en vez de individual**: agregar workflow secundario que lee la hoja `SUGERENCIAS`, agrupa por herramienta, y manda un único mail los lunes con todo lo de la semana.
- **Auto-llenar la planilla principal**: cuando aceptás una sugerencia, escribir directamente en la celda del bimestre actual. Requiere service account de Google + nodo Google Sheets en modo update.
