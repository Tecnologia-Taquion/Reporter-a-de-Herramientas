# n8n Workflow: Write Approval to Sheet

Workflow disparado por el panel de líderes cada vez que un líder aprueba una sugerencia. Recibe los datos (equipo, bimestre destino, campos del cambio) y escribe la fila correspondiente en la hoja mensual del Google Sheet de reportería.

---

## Cómo funciona

```
[ Webhook POST ]
       ↓
  recibe body con:
  { equipo, bimestre, herramienta,
    queCambio, nuevaPolitica, deficiencia,
    responsable, proximoPaso, source }
       ↓
[ Google Sheets: Read sheet ]   ← lee la hoja mensual completa (JUNIO 26, JULIO 26, etc.)
       ↓
[ Code: Find Row ]              ← busca la fila correcta del herramienta dentro del equipo
       ↓
       ├── encontrada → [ Google Sheets: Update Row ] → [ Respond Webhook ✓ ]
       └── no encontrada → [ Google Sheets: Append Row ] → [ Respond Webhook ✓ ]
```

Para encontrar la fila, el código:
1. Recorre la hoja mensual fila por fila
2. Detecta el separador de cada equipo (fila con solo el nombre del equipo en la columna C)
3. Cuando está dentro del equipo correcto, busca la herramienta por nombre (case-insensitive)
4. Si la encuentra, devuelve el número de fila para hacer un UPDATE
5. Si no, devuelve `null` y se hace un APPEND al final de la sección de ese equipo

---

## Requisitos previos

1. **Credenciales de Google Sheets** ya configuradas en n8n (las mismas que usás para el workflow de auto-fetch de changelogs).
2. **ID real de la planilla** — necesitás abrir la planilla en Google Sheets y copiar el ID de la URL (formato `https://docs.google.com/spreadsheets/d/{ID}/edit`). El publish ID `2PACX-...` que usa el panel para LEER no sirve para ESCRIBIR.

---

## Importar el workflow

Pegá este JSON en un archivo `.json` y subilo en n8n vía **Import from File**:

```json
{
  "name": "Reportería - Write Approval to Sheet",
  "nodes": [
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "write-approval",
        "options": {
          "responseMode": "responseNode"
        }
      },
      "name": "Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 1.1,
      "position": [200, 400],
      "webhookId": "write-approval-webhook"
    },
    {
      "parameters": {
        "jsCode": "// Valida el body y arma el contexto para los siguientes nodos.\nconst body = $input.first().json.body || $input.first().json;\n\nconst required = ['equipo', 'bimestre', 'herramienta'];\nfor (const f of required) {\n  if (!body[f]) {\n    throw new Error(`Falta campo requerido: ${f}`);\n  }\n}\n\nreturn [{\n  json: {\n    equipo:        String(body.equipo).trim(),\n    bimestre:      String(body.bimestre).trim(),\n    herramienta:   String(body.herramienta).trim(),\n    queCambio:     String(body.queCambio || '').trim(),\n    nuevaPolitica: String(body.nuevaPolitica || '').trim(),\n    deficiencia:   String(body.deficiencia || '').trim(),\n    responsable:   String(body.responsable || '').trim(),\n    proximoPaso:   String(body.proximoPaso || '').trim(),\n    source:        body.source || {},\n  }\n}];"
      },
      "name": "Validate Body",
      "type": "n8n-nodes-base.code",
      "typeVersion": 1,
      "position": [420, 400]
    },
    {
      "parameters": {
        "documentId": {
          "__rl": true,
          "value": "REEMPLAZAR_CON_SPREADSHEET_ID",
          "mode": "id"
        },
        "sheetName": "={{ $json.bimestre }}",
        "operation": "read",
        "options": {
          "outputFormatting": {
            "values": {
              "general": "UNFORMATTED_VALUE"
            }
          }
        }
      },
      "name": "Read Sheet",
      "type": "n8n-nodes-base.googleSheets",
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
        "jsCode": "// Encuentra la fila correcta del herramienta dentro del equipo.\n// El sheet tiene esta estructura:\n//   fila vacía / fila vacía\n//   (col C) TECNOLOGÍA  ← header del equipo\n//   Herramienta | Qué cambió | Nueva política | Deficiencia | Responsable | Próximo paso\n//   Digital Ocean | ... | ... | ... | ... | ...\n//   Cloudflare    | ... | ... | ... | ... | ...\n//   ...\n//   fila vacía\n//   (col C) INSPIRE     ← siguiente equipo\n//   ...\n\nconst ctx = $('Validate Body').first().json;\nconst rows = $input.all().map(it => it.json);\n\nconst targetTeam = ctx.equipo.toLowerCase().trim();\nconst targetTool = ctx.herramienta.toLowerCase().trim();\n\n// La columna A se llama \"Herramienta\" en el header de cada equipo. Pero el read de n8n\n// suele venir con cada fila como objeto con keys de la primera fila o por índices.\n// Para evitar ambigüedad, leemos las raw rows convirtiendo cada item.json a array por orden.\nfunction rowToArr(r) {\n  if (Array.isArray(r)) return r;\n  return Object.values(r);\n}\n\nlet currentTeam = null;\nlet foundRowIndex = -1;     // 0-based para nuestro tracking\nlet lastRowInSection = -1;  // última fila con contenido en la sección actual del equipo\nlet teamSectionFoundAt = -1;\n\nrows.forEach((r, i) => {\n  const arr = rowToArr(r).map(v => (v == null ? '' : String(v)).trim());\n  // Detectar header de equipo: una sola celda con contenido y es el nombre de un equipo\n  const nonEmpty = arr.map((v, idx) => ({v, idx})).filter(x => x.v);\n  if (nonEmpty.length === 1 && /^[A-ZÁÉÍÓÚÑ\\s\\/\\-&]{3,}$/.test(nonEmpty[0].v)) {\n    currentTeam = nonEmpty[0].v.toLowerCase().trim();\n    if (currentTeam === targetTeam) {\n      teamSectionFoundAt = i;\n    }\n    return;\n  }\n  // Saltea fila de headers de columnas\n  if (arr[0] && arr[0].toLowerCase() === 'herramienta') return;\n\n  if (currentTeam === targetTeam) {\n    if (arr[0]) {\n      lastRowInSection = i;\n      if (arr[0].toLowerCase() === targetTool && foundRowIndex < 0) {\n        foundRowIndex = i;\n      }\n    }\n  }\n});\n\nif (teamSectionFoundAt < 0) {\n  return [{ json: { ...ctx, error: `Equipo \"${ctx.equipo}\" no se encontró en la hoja \"${ctx.bimestre}\".` } }];\n}\n\nconst targetRow = foundRowIndex >= 0 ? (foundRowIndex + 1) : null; // Sheets es 1-indexed\nconst appendAfterRow = lastRowInSection >= 0 ? (lastRowInSection + 1) : null;\n\nreturn [{\n  json: {\n    ...ctx,\n    targetRow,\n    appendAfterRow,\n    action: targetRow ? 'update' : 'append',\n  }\n}];"
      },
      "name": "Find Row",
      "type": "n8n-nodes-base.code",
      "typeVersion": 1,
      "position": [860, 400]
    },
    {
      "parameters": {
        "conditions": {
          "string": [
            { "value1": "={{ $json.action }}", "operation": "equal", "value2": "update" }
          ]
        }
      },
      "name": "Update or Append?",
      "type": "n8n-nodes-base.if",
      "typeVersion": 1,
      "position": [1080, 400]
    },
    {
      "parameters": {
        "operation": "update",
        "documentId": {
          "__rl": true,
          "value": "REEMPLAZAR_CON_SPREADSHEET_ID",
          "mode": "id"
        },
        "sheetName": "={{ $json.bimestre }}",
        "columns": {
          "mappingMode": "defineBelow",
          "value": {
            "row_number": "={{ $json.targetRow }}",
            "Herramienta":                      "={{ $json.herramienta }}",
            "Qué cambió":                       "={{ $json.queCambio }}",
            "Nueva política / actualización":   "={{ $json.nuevaPolitica }}",
            "Deficiencia / riesgo detectado":   "={{ $json.deficiencia }}",
            "Responsable":                      "={{ $json.responsable }}",
            "Próximo paso":                     "={{ $json.proximoPaso }}"
          },
          "matchingColumns": ["row_number"]
        },
        "options": {}
      },
      "name": "Update Row",
      "type": "n8n-nodes-base.googleSheets",
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
        "operation": "append",
        "documentId": {
          "__rl": true,
          "value": "REEMPLAZAR_CON_SPREADSHEET_ID",
          "mode": "id"
        },
        "sheetName": "={{ $json.bimestre }}",
        "columns": {
          "mappingMode": "defineBelow",
          "value": {
            "Herramienta":                      "={{ $json.herramienta }}",
            "Qué cambió":                       "={{ $json.queCambio }}",
            "Nueva política / actualización":   "={{ $json.nuevaPolitica }}",
            "Deficiencia / riesgo detectado":   "={{ $json.deficiencia }}",
            "Responsable":                      "={{ $json.responsable }}",
            "Próximo paso":                     "={{ $json.proximoPaso }}"
          }
        },
        "options": {}
      },
      "name": "Append Row",
      "type": "n8n-nodes-base.googleSheets",
      "typeVersion": 4,
      "position": [1300, 500],
      "credentials": {
        "googleSheetsOAuth2Api": {
          "name": "Google Sheets Taquión"
        }
      }
    },
    {
      "parameters": {
        "respondWith": "json",
        "responseBody": "={{ JSON.stringify({ ok: true, action: $json.action, row: $json.targetRow || null }) }}",
        "options": {}
      },
      "name": "Respond Success",
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1,
      "position": [1520, 400]
    }
  ],
  "connections": {
    "Webhook": {
      "main": [[{ "node": "Validate Body", "type": "main", "index": 0 }]]
    },
    "Validate Body": {
      "main": [[{ "node": "Read Sheet", "type": "main", "index": 0 }]]
    },
    "Read Sheet": {
      "main": [[{ "node": "Find Row", "type": "main", "index": 0 }]]
    },
    "Find Row": {
      "main": [[{ "node": "Update or Append?", "type": "main", "index": 0 }]]
    },
    "Update or Append?": {
      "main": [
        [{ "node": "Update Row", "type": "main", "index": 0 }],
        [{ "node": "Append Row", "type": "main", "index": 0 }]
      ]
    },
    "Update Row": {
      "main": [[{ "node": "Respond Success", "type": "main", "index": 0 }]]
    },
    "Append Row": {
      "main": [[{ "node": "Respond Success", "type": "main", "index": 0 }]]
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

1. **Reemplazar `REEMPLAZAR_CON_SPREADSHEET_ID`** en los 3 nodos de Google Sheets:
   - Read Sheet
   - Update Row
   - Append Row
   
   El valor a poner es el ID real de la planilla (el de la URL cuando abrís Google Sheets para editar). Si todavía no lo tenés a mano, abrí la planilla en el browser y copiá lo que va entre `/d/` y `/edit` en la URL.

2. **Mapear credenciales**: si te marca un warning rojo en los nodos de Google Sheets, click en el nodo → seleccioná tu credencial existente de Google Sheets.

3. **Activar el workflow**: switch "Active" arriba a la derecha.

4. **Copiar la URL del webhook**: en el nodo `Webhook`, te aparece "Production URL". Algo tipo:
   ```
   https://easy.getboost.bot/webhook/write-approval
   ```
   Esa URL es la que tenés que poner en EasyPanel como `N8N_WRITE_WEBHOOK_URL`.

5. **Reiniciar el panel** (EasyPanel → reporteria-herramientas → Implementar) para que tome la env var nueva.

---

## Probar manualmente

Antes de probar con el panel, podés disparar el webhook a mano:

```bash
curl -X POST https://easy.getboost.bot/webhook/write-approval \
  -H "Content-Type: application/json" \
  -d '{
    "equipo": "TECNOLOGÍA",
    "bimestre": "JUNIO 26",
    "herramienta": "Notion",
    "queCambio": "Notion Developer Platform lanzada",
    "nuevaPolitica": "Workers para código personalizado disponibles",
    "deficiencia": "",
    "responsable": "Felipe",
    "proximoPaso": "Evaluar si Workers nos sirve para automatizaciones"
  }'
```

Si todo funciona, va a actualizar la fila de Notion dentro de la sección TECNOLOGÍA de la hoja JUNIO 26.

Respuesta esperada:
```json
{ "ok": true, "action": "update", "row": 8 }
```

---

## Troubleshooting

**"Equipo X no se encontró en la hoja Y"**
- El nombre del equipo en el body no matchea exactamente el header del equipo en el Sheet (incluyendo mayúsculas y acentos).
- Verificá que en el dropdown del panel de líderes el equipo se llame igual que en el Sheet.

**"Sheet not found" o error de gid**
- El nombre del bimestre en el body no coincide con un nombre de hoja en la planilla.
- Verificá que el panel esté mandando el nombre exacto (ej: `JUNIO 26`, no `Junio 2026`).

**"Permission denied"**
- La credencial de Google Sheets no tiene permiso de escritura en la planilla. Compartila como Editor con el usuario asociado a la credencial OAuth.

**El webhook tarda o devuelve 504**
- Google Sheets API a veces es lenta. Pode haber rate limits. Esperá 1 min y reintentá.
