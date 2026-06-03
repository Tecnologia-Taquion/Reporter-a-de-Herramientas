# n8n Workflow: Write Decision (v4 — DECISIONES + bimestre)

Workflow disparado por el panel de líderes cada vez que un líder toma una decisión (aprobar o rechazar). Funcionamiento:

- **Siempre** appendea una fila a la hoja `DECISIONES` (registro de la decisión)
- **Solo si la decisión es `approved`**, además appendea una fila a la hoja del bimestre destino (la novedad pasa al panel público)

> **v4** persiste las decisiones en una hoja `DECISIONES` para que sobrevivan redeploys de EasyPanel y queden visibles para auditoría. Reemplaza la v3 (que solo escribía al bimestre).

---

## Estructura de las dos hojas afectadas

### Hoja `DECISIONES` (nueva — tenés que crearla con estos headers en fila 1)

```
sugerencia_hash	equipo	decision	herramienta	titulo_original	bimestre_destino	fecha
```

Una fila = una decisión de un líder sobre una sugerencia.

### Hoja mensual (sin cambios — `JUNIO 26`, `JULIO 26`, etc.)

```
herramienta	equipo	que_cambio	nueva_politica	deficiencia	responsable	proximo_paso	tipo_cambio	relevancia	aprobado_por	fecha_aprobacion	fuente_url	sugerencia_hash
```

---

## Cómo funciona

```
[ Webhook POST ]
       ↓
[ Validate Body ]
       ↓
[ HTTP append DECISIONES ]   ← siempre
       ↓
[ IF decision == 'approved' ]
       ├── YES → [ HTTP append bimestre ]
       └── NO  → (skip)
       ↓
[ Build Response ]
       ↓
[ Respond ]
```

---

## Importar el workflow

Pegá este JSON, subilo a n8n vía **Import from File**. Si tenés la v3 importada, **borrala** primero (mismo `path` = `write-approval`, choca):

```json
{
  "name": "Reportería - Write Decision to Sheet",
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
      "webhookId": "write-decision-webhook"
    },
    {
      "parameters": {
        "jsCode": "// Valida el body y arma todas las URLs y rows que va a usar el resto del workflow.\n// IMPORTANTE: reemplazar SPREADSHEET_ID por el ID real de la planilla.\nconst SPREADSHEET_ID = 'REEMPLAZAR_CON_SPREADSHEET_ID';\n\nconst body = $input.first().json.body || $input.first().json;\nconst decision = String(body.decision || '').toLowerCase().trim();\nif (decision !== 'approved' && decision !== 'rejected') {\n  throw new Error('decision debe ser \"approved\" o \"rejected\"');\n}\nfor (const f of ['sugerencia_hash', 'equipo', 'herramienta']) {\n  if (!body[f]) throw new Error('Falta campo requerido: ' + f);\n}\n\nconst fecha = String(body.fecha || new Date().toISOString().slice(0, 10)).trim();\n\n// === DECISIONES (siempre) ===\nconst decisionesRange = `'DECISIONES'!A:G`;\nconst decisionesUrl   = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(decisionesRange)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;\nconst decisionesRow = [\n  String(body.sugerencia_hash  || '').trim(),\n  String(body.equipo           || '').trim(),\n  decision,\n  String(body.herramienta      || '').trim(),\n  String(body.titulo_original  || '').trim(),\n  decision === 'approved' ? String(body.bimestre || '').trim() : '',\n  fecha,\n];\n\n// === BIMESTRE (solo si aprobada) ===\nlet bimestreUrl  = null;\nlet bimestreBody = null;\nif (decision === 'approved') {\n  const sheetName = String(body.bimestre || '').trim();\n  if (!sheetName) throw new Error('Falta campo bimestre para una aprobación');\n  const sheetEsc = sheetName.replace(/'/g, \"''\");\n  const bimRange = `'${sheetEsc}'!A:M`;\n  bimestreUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(bimRange)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;\n  // Orden EXACTO de columnas del sheet mensual:\n  // herramienta | equipo | que_cambio | nueva_politica | deficiencia | responsable\n  // proximo_paso | tipo_cambio | relevancia | aprobado_por | fecha_aprobacion\n  // fuente_url | sugerencia_hash\n  bimestreBody = {\n    range: bimRange,\n    majorDimension: 'ROWS',\n    values: [[\n      String(body.herramienta     || '').trim(),\n      String(body.equipo          || '').trim(),\n      String(body.que_cambio      || '').trim(),\n      String(body.nueva_politica  || '').trim(),\n      String(body.deficiencia     || '').trim(),\n      String(body.responsable     || '').trim(),\n      String(body.proximo_paso    || '').trim(),\n      String(body.tipo_cambio     || '').trim(),\n      String(body.relevancia      || '').trim(),\n      String(body.aprobado_por    || body.equipo || '').trim(),\n      fecha,\n      String(body.fuente_url      || '').trim(),\n      String(body.sugerencia_hash || '').trim(),\n    ]],\n  };\n}\n\nreturn [{\n  json: {\n    decision,\n    isApproved: decision === 'approved',\n    decisionesUrl,\n    decisionesBody: { range: decisionesRange, majorDimension: 'ROWS', values: [decisionesRow] },\n    bimestreUrl,\n    bimestreBody,\n    herramienta: body.herramienta,\n    equipo:      body.equipo,\n    bimestre:    body.bimestre || '',\n  }\n}];"
      },
      "name": "Validate Body",
      "type": "n8n-nodes-base.code",
      "typeVersion": 1,
      "position": [420, 400]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $json.decisionesUrl }}",
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
        "jsonBody": "={{ JSON.stringify($json.decisionesBody) }}",
        "options": {
          "response": { "response": { "neverError": true, "fullResponse": true } }
        }
      },
      "name": "Append DECISIONES",
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
        "jsCode": "// Pasa el contexto original + status del primer append al siguiente nodo.\nconst ctx = $('Validate Body').first().json;\nconst resp = $input.first().json;\nconst decisionesStatus = resp.statusCode || 0;\nreturn [{ json: { ...ctx, decisionesStatus } }];"
      },
      "name": "Pass Context",
      "type": "n8n-nodes-base.code",
      "typeVersion": 1,
      "position": [860, 400]
    },
    {
      "parameters": {
        "conditions": {
          "boolean": [
            { "value1": "={{ $json.isApproved }}", "value2": true }
          ]
        }
      },
      "name": "Approved?",
      "type": "n8n-nodes-base.if",
      "typeVersion": 1,
      "position": [1080, 400]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $json.bimestreUrl }}",
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
        "jsonBody": "={{ JSON.stringify($json.bimestreBody) }}",
        "options": {
          "response": { "response": { "neverError": true, "fullResponse": true } }
        }
      },
      "name": "Append Bimestre",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4,
      "position": [1300, 300],
      "credentials": {
        "googleSheetsOAuth2Api": {
          "name": "Google Sheets Taquión"
        }
      }
    },
    {
      "parameters": {
        "jsCode": "// Construye respuesta exitosa cuando ambos appends terminaron OK.\nconst ctx  = $('Pass Context').first().json;\nconst resp = $input.first().json;\nconst bimestreStatus = resp.statusCode || 0;\nconst overallOK = ctx.decisionesStatus >= 200 && ctx.decisionesStatus < 300 && bimestreStatus >= 200 && bimestreStatus < 300;\nreturn [{ json: {\n  ok: overallOK,\n  action: 'approved-written',\n  decision: ctx.decision,\n  herramienta: ctx.herramienta,\n  equipo:      ctx.equipo,\n  bimestre:    ctx.bimestre,\n  decisionesStatus: ctx.decisionesStatus,\n  bimestreStatus,\n  error: overallOK ? null : ('decisiones HTTP ' + ctx.decisionesStatus + ', bimestre HTTP ' + bimestreStatus),\n  httpStatus: overallOK ? 200 : 502,\n} }];"
      },
      "name": "Build Approved Response",
      "type": "n8n-nodes-base.code",
      "typeVersion": 1,
      "position": [1520, 300]
    },
    {
      "parameters": {
        "jsCode": "// Construye respuesta para rechazos (solo se appendea DECISIONES).\nconst ctx = $('Pass Context').first().json;\nconst ok = ctx.decisionesStatus >= 200 && ctx.decisionesStatus < 300;\nreturn [{ json: {\n  ok,\n  action: 'rejected-tracked',\n  decision: ctx.decision,\n  herramienta: ctx.herramienta,\n  equipo:      ctx.equipo,\n  decisionesStatus: ctx.decisionesStatus,\n  error: ok ? null : ('decisiones HTTP ' + ctx.decisionesStatus),\n  httpStatus: ok ? 200 : 502,\n} }];"
      },
      "name": "Build Rejected Response",
      "type": "n8n-nodes-base.code",
      "typeVersion": 1,
      "position": [1300, 500]
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
      "position": [1740, 400]
    }
  ],
  "connections": {
    "Webhook": {
      "main": [[{ "node": "Validate Body", "type": "main", "index": 0 }]]
    },
    "Validate Body": {
      "main": [[{ "node": "Append DECISIONES", "type": "main", "index": 0 }]]
    },
    "Append DECISIONES": {
      "main": [[{ "node": "Pass Context", "type": "main", "index": 0 }]]
    },
    "Pass Context": {
      "main": [[{ "node": "Approved?", "type": "main", "index": 0 }]]
    },
    "Approved?": {
      "main": [
        [{ "node": "Append Bimestre", "type": "main", "index": 0 }],
        [{ "node": "Build Rejected Response", "type": "main", "index": 0 }]
      ]
    },
    "Append Bimestre": {
      "main": [[{ "node": "Build Approved Response", "type": "main", "index": 0 }]]
    },
    "Build Approved Response": {
      "main": [[{ "node": "Respond", "type": "main", "index": 0 }]]
    },
    "Build Rejected Response": {
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

1. **Borrá la v3 antes de importar la v4** (chocan en `path = write-approval`). En n8n, abrí el workflow viejo → menú `...` → **Delete**.
2. **Reemplazar `SPREADSHEET_ID`** dentro del nodo **Validate Body**.
3. **Mapear credenciales** en los nodos `Append DECISIONES` y `Append Bimestre` (Google Sheets OAuth2).
4. **Activar** el workflow.
5. La URL del webhook sigue siendo `https://easy.getboost.bot/webhook/write-approval` (mismo `path`), así que **no hace falta cambiar `N8N_WRITE_WEBHOOK_URL` en EasyPanel**.

---

## Probar manualmente

**Aprobación:**

```bash
curl -X POST https://easy.getboost.bot/webhook/write-approval \
  -H "Content-Type: application/json" \
  -d '{
    "decision": "approved",
    "sugerencia_hash": "test-abc",
    "equipo": "TECNOLOGÍA",
    "herramienta": "Notion",
    "titulo_original": "Plan Mode",
    "bimestre": "JUNIO 26",
    "que_cambio": "Notion Developer Platform",
    "nueva_politica": "Workers para código personalizado",
    "deficiencia": "",
    "responsable": "Felipe",
    "proximo_paso": "Evaluar",
    "tipo_cambio": "funcionalidad",
    "relevancia": "alta",
    "aprobado_por": "TECNOLOGÍA",
    "fecha": "2026-05-28",
    "fuente_url": "https://www.notion.so/releases"
  }'
```

Esperado: 200 OK con `{ ok: true, action: 'approved-written', ... }`. Vas a ver una fila nueva en `DECISIONES` Y una en `JUNIO 26`.

**Rechazo:**

```bash
curl -X POST https://easy.getboost.bot/webhook/write-approval \
  -H "Content-Type: application/json" \
  -d '{
    "decision": "rejected",
    "sugerencia_hash": "test-xyz",
    "equipo": "INSPIRE",
    "herramienta": "Figma",
    "titulo_original": "Bulk edit en Figma Buzz",
    "fecha": "2026-05-28"
  }'
```

Esperado: 200 OK con `{ ok: true, action: 'rejected-tracked', ... }`. Vas a ver UNA fila nueva en `DECISIONES` (con `decision = rejected` y `bimestre_destino` vacío). Nada se escribe en ningún bimestre.

---

## Troubleshooting

**Sheets API HTTP 400 en Append DECISIONES**
- La hoja `DECISIONES` no existe o el nombre tiene typo. Verificá que la pestaña se llame exactamente `DECISIONES` (en mayúscula).

**Sheets API HTTP 403**
- La credencial OAuth no tiene scope o la cuenta no es Editor de la planilla.

**El panel sigue mostrando sugerencias ya decididas tras redeploy**
- Verificá que la hoja `DECISIONES` esté siendo poblada (debería tener filas con las decisiones recientes).
- El cache del server tarda 60s máximo en refrescar. Si querés forzarlo, apretá ↻ en el panel de líderes.

**Una aprobación quedó en DECISIONES pero NO apareció en el bimestre**
- Mirá la ejecución del workflow en n8n → el segundo append (Append Bimestre) probablemente falló. Causas comunes: nombre de bimestre mal escrito (`JUNIO 26` vs `Junio 26`), o el sheet no existe.
- El server responde con `ok: false` y muestra error en el toast del panel.
