# n8n Workflow: Write Approval to Sheet (v3 — formato plano)

Workflow disparado por el panel de líderes cuando un líder aprueba una sugerencia. Recibe los datos y los **appendea como una fila nueva** en la hoja del bimestre destino.

> **v3** asume que las hojas mensuales (`JUNIO 26`, `JULIO 26`, …) son **tabulares planas** con 13 columnas, una fila = una novedad. Sin secciones, sin pre-listados.

---

## Estructura de columnas que espera el sheet

Cada hoja mensual debe tener estos headers en la fila 1, en este orden:

```
A: herramienta
B: equipo
C: que_cambio
D: nueva_politica
E: deficiencia
F: responsable
G: proximo_paso
H: tipo_cambio
I: relevancia
J: aprobado_por
K: fecha_aprobacion
L: fuente_url
M: sugerencia_hash
```

---

## Cómo funciona

```
[ Webhook POST ]
       ↓
[ Validate Body ]      ← chequea campos requeridos
       ↓
[ HTTP POST values:append ]   ← appendea fila a la API de Sheets
       ↓
[ Respond ]            ← 200 si OK, 4xx/5xx si error
```

Mucho más simple que las versiones anteriores. Sin search, sin update, sin lógica de secciones.

---

## Requisitos previos

1. **Credencial "Google Sheets OAuth2 API"** ya configurada en n8n (la misma del workflow de auto-fetch).
2. **Spreadsheet ID real** (de la URL de Google Sheets entre `/d/` y `/edit`).
3. **Permisos de edición** del usuario OAuth sobre la planilla.
4. **Las hojas mensuales tienen los 13 headers en fila 1** (formato nuevo plano).

---

## Importar el workflow

Pegá este JSON y subilo a n8n vía **Import from File**:

```json
{
  "name": "Reportería - Write Approval to Sheet",
  "nodes": [
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "write-approval",
        "responseMode": "responseNode",
        "options": {}
      },
      "name": "Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 1.1,
      "position": [200, 400],
      "webhookId": "write-approval-webhook"
    },
    {
      "parameters": {
        "jsCode": "// Valida el body y arma el payload de append.\n// IMPORTANTE: reemplazar SPREADSHEET_ID por el ID real de la planilla.\nconst SPREADSHEET_ID = 'REEMPLAZAR_CON_SPREADSHEET_ID';\n\nconst body = $input.first().json.body || $input.first().json;\nconst required = ['bimestre', 'herramienta', 'equipo'];\nfor (const f of required) {\n  if (!body[f]) throw new Error('Falta campo requerido: ' + f);\n}\n\nconst sheetName = String(body.bimestre).trim();\nconst sheetEsc  = sheetName.replace(/'/g, \"''\");\nconst range     = `'${sheetEsc}'!A:M`;\nconst appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;\n\n// Orden EXACTO de columnas en el sheet:\n// herramienta | equipo | que_cambio | nueva_politica | deficiencia | responsable\n// proximo_paso | tipo_cambio | relevancia | aprobado_por | fecha_aprobacion\n// fuente_url | sugerencia_hash\nconst rowValues = [\n  String(body.herramienta      || '').trim(),\n  String(body.equipo           || '').trim(),\n  String(body.que_cambio       || '').trim(),\n  String(body.nueva_politica   || '').trim(),\n  String(body.deficiencia      || '').trim(),\n  String(body.responsable      || '').trim(),\n  String(body.proximo_paso     || '').trim(),\n  String(body.tipo_cambio      || '').trim(),\n  String(body.relevancia       || '').trim(),\n  String(body.aprobado_por     || '').trim(),\n  String(body.fecha_aprobacion || new Date().toISOString().slice(0, 10)).trim(),\n  String(body.fuente_url       || '').trim(),\n  String(body.sugerencia_hash  || '').trim(),\n];\n\nreturn [{\n  json: {\n    appendUrl,\n    sheetName,\n    appendBody: {\n      range,\n      majorDimension: 'ROWS',\n      values: [rowValues],\n    },\n    herramienta: body.herramienta,\n    equipo:      body.equipo,\n    bimestre:    body.bimestre,\n  }\n}];"
      },
      "name": "Validate Body",
      "type": "n8n-nodes-base.code",
      "typeVersion": 1,
      "position": [420, 400]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $json.appendUrl }}",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "googleSheetsOAuth2Api",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            { "name": "Content-Type", "value": "application/json" }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify($json.appendBody) }}",
        "options": {
          "response": { "response": { "neverError": true, "fullResponse": true } }
        }
      },
      "name": "Append Row",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4,
      "position": [640, 400],
      "credentials": {
        "googleSheetsOAuth2Api": {
          "name": "Google Sheets Taquión"
        }
      }
    },
    {
      "parameters": {
        "jsCode": "// Construye la respuesta para el panel.\nconst ctx  = $('Validate Body').first().json;\nconst resp = $input.first().json;\nconst status = resp.statusCode || 0;\n\nif (status >= 200 && status < 300) {\n  return [{ json: {\n    ok: true,\n    action: 'appended',\n    herramienta: ctx.herramienta,\n    equipo:      ctx.equipo,\n    bimestre:    ctx.bimestre,\n    httpStatus:  200,\n  } }];\n}\n\nreturn [{ json: {\n  ok: false,\n  error: 'Sheets API HTTP ' + status + ' al hacer append en \"' + ctx.sheetName + '\".',\n  detail: resp.body || null,\n  httpStatus: 502,\n} }];"
      },
      "name": "Build Response",
      "type": "n8n-nodes-base.code",
      "typeVersion": 1,
      "position": [860, 400]
    },
    {
      "parameters": {
        "respondWith": "json",
        "responseBody": "={{ JSON.stringify($json) }}",
        "options": {
          "responseCode": "={{ $json.httpStatus || 200 }}"
        }
      },
      "name": "Respond",
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1,
      "position": [1080, 400]
    }
  ],
  "connections": {
    "Webhook": {
      "main": [[{ "node": "Validate Body", "type": "main", "index": 0 }]]
    },
    "Validate Body": {
      "main": [[{ "node": "Append Row", "type": "main", "index": 0 }]]
    },
    "Append Row": {
      "main": [[{ "node": "Build Response", "type": "main", "index": 0 }]]
    },
    "Build Response": {
      "main": [[{ "node": "Respond", "type": "main", "index": 0 }]]
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

1. **Reemplazar `SPREADSHEET_ID`** dentro del nodo **Validate Body** (línea `const SPREADSHEET_ID = ...`).
2. **Mapear credenciales** en el nodo `Append Row` si te marca warning rojo (seleccioná tu credencial existente de Google Sheets).
3. **Activar** el workflow (switch arriba a la derecha).
4. **Copiar la Production URL** del nodo Webhook (`https://easy.getboost.bot/webhook/write-approval` aprox).
5. **Actualizar `N8N_WRITE_WEBHOOK_URL`** en EasyPanel con esa URL.

---

## Probar manualmente

```bash
curl -X POST https://easy.getboost.bot/webhook/write-approval \
  -H "Content-Type: application/json" \
  -d '{
    "bimestre": "JUNIO 26",
    "herramienta": "Notion",
    "equipo": "TECNOLOGÍA",
    "que_cambio": "Notion Developer Platform",
    "nueva_politica": "Workers para código personalizado",
    "deficiencia": "",
    "responsable": "Felipe",
    "proximo_paso": "Evaluar si nos sirve",
    "tipo_cambio": "funcionalidad",
    "relevancia": "alta",
    "aprobado_por": "TECNOLOGÍA",
    "fecha_aprobacion": "2026-05-28",
    "fuente_url": "https://www.notion.so/releases",
    "sugerencia_hash": "abc123"
  }'
```

Esperado:
```json
{ "ok": true, "action": "appended", "herramienta": "Notion", ... }
```

Vas a ver una fila nueva al final de la hoja JUNIO 26 con esos 13 valores.

---

## Troubleshooting

**HTTP 400** del Sheets API al hacer append
- Lo más común: el sheet con el nombre del bimestre no existe. Verificá que `JUNIO 26` (o lo que mandes) sea exactamente el nombre de la pestaña.

**HTTP 403**
- La credencial OAuth no tiene scope `spreadsheets` o no tiene permiso de Editor sobre la planilla.

**Append no aparece en la hoja**
- El range `'JUNIO 26'!A:M` debería append al final automáticamente. Si ves filas vacías saltadas, es normal — Sheets busca la primera fila vacía después del último contenido.

**Datos cargados en columnas incorrectas**
- El orden del array `rowValues` en Validate Body **DEBE** coincidir con el orden de headers en la fila 1 del sheet. Si moviste columnas, ajustá el código.
