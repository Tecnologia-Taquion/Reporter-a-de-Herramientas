const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// Publish ID del Google Sheet (URL "Publicar en la web" → "...spreadsheets/d/e/{PUBLISH_ID}/pubhtml")
// Usamos el publish ID en vez del spreadsheet ID porque la planilla está publicada como página web.
const PUBLISH_ID    = '2PACX-1vT7bY2KlZaI1sZB7jbJ9z4uCqPRrw4Qboxt-n1hxGUQtBQV83gt00geZiqsZv3zRdPaG1Z5haMc-dEX';
const APP_PASSWORD  = process.env.APP_PASSWORD;
const AUTH_ENABLED  = !!APP_PASSWORD;
const COOKIE_SECRET = 'taquion_reporteria_2025';

// ─── Líderes ───
// LEADERS_PASSWORDS es un JSON con { equipo: contraseña } configurado en EasyPanel.
// N8N_WRITE_WEBHOOK_URL es la URL del workflow de n8n que escribe en el Sheet.
let LEADERS_PASSWORDS = {};
try {
  LEADERS_PASSWORDS = process.env.LEADERS_PASSWORDS ? JSON.parse(process.env.LEADERS_PASSWORDS) : {};
} catch (err) {
  console.error('LEADERS_PASSWORDS env var no es JSON válido:', err.message);
  LEADERS_PASSWORDS = {};
}
const N8N_WRITE_WEBHOOK_URL = process.env.N8N_WRITE_WEBHOOK_URL || '';
const LEADERS_ENABLED = Object.keys(LEADERS_PASSWORDS).length > 0;

// Almacenamiento de decisiones. Para persistir entre redeploys, montá un volumen
// en EasyPanel en /app/data. Si no hay volumen, las decisiones se pierden al
// redeployar (pero las novedades aprobadas ya quedan escritas en el Sheet vía n8n).
const DATA_DIR = path.join(__dirname, 'data');
const DECISIONS_FILE = path.join(DATA_DIR, 'leader-decisions.json');

function loadDecisions() {
  try {
    if (!require('fs').existsSync(DATA_DIR)) require('fs').mkdirSync(DATA_DIR, { recursive: true });
    if (!require('fs').existsSync(DECISIONS_FILE)) return { decisions: [] };
    return JSON.parse(require('fs').readFileSync(DECISIONS_FILE, 'utf8'));
  } catch (err) {
    console.error('Error leyendo decisiones:', err.message);
    return { decisions: [] };
  }
}

function saveDecisions(data) {
  try {
    if (!require('fs').existsSync(DATA_DIR)) require('fs').mkdirSync(DATA_DIR, { recursive: true });
    require('fs').writeFileSync(DECISIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error guardando decisiones:', err.message);
  }
}

function makeLeaderToken(team, pw) {
  return crypto.createHash('sha256').update(`${team}:${pw}:${COOKIE_SECRET}:leader`).digest('hex');
}

function getLeaderFromCookie(req) {
  const cookies = parseCookies(req);
  const raw = cookies['leader_auth'];
  if (!raw) return null;
  const [encodedTeam, token] = raw.split('|');
  if (!encodedTeam || !token) return null;
  let team;
  try { team = decodeURIComponent(encodedTeam); } catch (e) { return null; }
  const expectedPw = LEADERS_PASSWORDS[team];
  if (!expectedPw) return null;
  if (makeLeaderToken(team, expectedPw) !== token) return null;
  return team;
}

function suggestionHash(s) {
  // Identidad estable de una sugerencia, basada en herramienta + título original.
  // Si la IA re-procesa el mismo cambio, el hash queda igual y no se duplica para el líder.
  const key = `${(s.herramienta || '').toLowerCase().trim()}|${(s.titulo_original || '').toLowerCase().trim()}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// Los bimestres se descubren automáticamente leyendo la lista de hojas del Google
// Sheet en runtime (función discoverBimestres). Si agregás, eliminás o renombrás
// una hoja en la planilla, el panel se actualiza solo en la próxima carga (o al
// apretar Actualizar para invalidar la cache).

const MONTHS = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9,
  sept: 9, oct: 10, nov: 11, dic: 12, diciem: 12,
};

function parseSheetMeta(sheetName) {
  const tokens = sheetName.toLowerCase().match(/[a-záéíóúñ]+|\d{2,4}/gi) || [];
  const monthIndices = [];
  let year = null;
  for (const t of tokens) {
    const norm = t.replace(/[áéíóú]/g, c => ({á:'a',é:'e',í:'i',ó:'o',ú:'u'}[c]));
    if (MONTHS[norm] != null) monthIndices.push(MONTHS[norm]);
    else if (/^\d{2,4}$/.test(t)) {
      let n = parseInt(t, 10);
      if (n < 100) n += 2000;
      year = n;
    }
  }
  if (monthIndices.length === 0) return null;
  const startMonth = monthIndices[0];
  const endMonth = monthIndices[monthIndices.length - 1];
  const endYear = year != null ? year : new Date().getFullYear();
  const startYear = endMonth < startMonth ? endYear - 1 : endYear;
  return { startMonth, endMonth, startYear, endYear };
}

function slugify(s) {
  return s.toLowerCase().replace(/[áéíóú]/g, c => ({á:'a',é:'e',í:'i',ó:'o',ú:'u'}[c]))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function prettyLabel(sheetName) {
  const fixed = sheetName.replace(/DICIEMRE/gi, 'Diciembre');
  return fixed.toLowerCase()
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s|-)([a-záéíóúñ])/g, (_, p, c) => p + c.toUpperCase())
    .replace(/\b(\d{2})\b/g, (_, n) => `20${n}`);
}

async function discoverBimestres() {
  const url = `https://docs.google.com/spreadsheets/d/e/${PUBLISH_ID}/pubhtml`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No se pudo listar hojas: ${r.status}`);
  const html = await r.text();
  const items = [];
  const re = /items\.push\(\{name:\s*"([^"]+)"[\s\S]*?gid:\s*"(\d+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const name = m[1];
    const gid = m[2];
    const meta = parseSheetMeta(name);
    if (!meta) continue;
    items.push({
      id: slugify(name),
      sheet: name,
      gid,
      label: prettyLabel(name),
      sortKey: meta.startYear * 100 + meta.startMonth,
    });
  }
  items.sort((a, b) => a.sortKey - b.sortKey);
  return items;
}

// Estructura tabular plana: cada fila de la hoja mensual es una novedad.
// Columnas esperadas (case-insensitive, configurables por nombre de header):
const SHEET_COLUMNS = [
  'herramienta',
  'equipo',
  'que_cambio',
  'nueva_politica',
  'deficiencia',
  'responsable',
  'proximo_paso',
  'tipo_cambio',
  'relevancia',
  'aprobado_por',
  'fecha_aprobacion',
  'fuente_url',
  'sugerencia_hash',
];

// Orden fijo de equipos para mostrar en el panel (los que no aparezcan en los datos
// igual van a renderearse pero sin tools).
const TEAMS_ORDER = [
  'TECNOLOGÍA',
  'INSPIRE',
  'INSIGHTS',
  'IGNITE',
  'GESTIÓN DE CUENTAS',
  'ADMINISTRACIÓN',
];

// Catálogo de herramientas por equipo. El líder al aprobar elige una de éstas
// (dropdown en el panel) para mantener consistencia entre bimestres.
const TEAMS_TOOLS = {
  'TECNOLOGÍA':         ['Digital Ocean', 'Cloudflare', 'Easypanel', 'Github', 'n8n', 'Notion', 'Unify / Ubiquiti'],
  'INSPIRE':            ['Adobe', 'CapCut', 'Figma', 'Gamma App', 'OpusClip', 'Mirage Captions', 'ElevenLabs', 'Dropbox', 'Vercel'],
  'INSIGHTS':           ['Typeform', 'SurveyMonkey', 'Digimind / Onclusive', 'Power BI', 'Claude', 'ChatGPT'],
  'IGNITE':             ['Donweb', 'ChatGPT', 'APOLLO', 'hostinger', 'windsor'],
  'GESTIÓN DE CUENTAS': ['ChatGPT', 'Claude'],
  'ADMINISTRACIÓN':     ['Microsoft', 'Colppy', 'Claude / Anthropic API', 'Loom', 'Netlify', 'ChatGPT', 'Workspace'],
};

/* ─── Auth ─── */
function makeToken(pw) {
  return crypto.createHash('sha256').update(pw + COOKIE_SECRET).digest('hex');
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) out[k.trim()] = v.join('=').trim();
  });
  return out;
}
function isAuthenticated(req) {
  if (!AUTH_ENABLED) return true;
  return parseCookies(req)['auth'] === makeToken(APP_PASSWORD);
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.urlencoded({ extended: false }));

// Rutas que NO requieren la contraseña principal (los líderes tienen su propio sistema)
const LEADER_PATHS = ['/lideres', '/lideres/login', '/lideres/logout', '/api/lideres'];
function isLeaderPath(p) {
  return LEADER_PATHS.some(prefix => p === prefix || p.startsWith(prefix + '/') || p.startsWith(prefix + '?'));
}

app.use((req, res, next) => {
  if (!AUTH_ENABLED) return next();
  if (req.path === '/login' || req.path === '/logout') return next();
  if (isLeaderPath(req.path)) return next();
  if (isAuthenticated(req)) return next();
  res.redirect('/login');
});

// Gate de líderes: protege /lideres y /api/lideres/* salvo el login.
app.use((req, res, next) => {
  if (!isLeaderPath(req.path)) return next();
  if (req.path === '/lideres/login' || req.path === '/lideres/logout') return next();
  const team = getLeaderFromCookie(req);
  if (team) {
    req.leaderTeam = team;
    return next();
  }
  if (req.path.startsWith('/api/lideres')) return res.status(401).json({ error: 'No autenticado' });
  res.redirect('/lideres/login');
});

app.get('/login', (req, res) => {
  const error = req.query.error;
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>📋</text></svg>"/>
  <title>Acceso — Reportería de Herramientas</title>
  <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Nunito',sans-serif;background:#FDFCF0;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:#fff;border-radius:24px;padding:44px 36px;width:380px;max-width:92vw;box-shadow:0 8px 30px rgba(0,0,0,0.08);text-align:center}
    .icon{width:56px;height:56px;background:linear-gradient(135deg,#E3F2FD,#F3E5F5);border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:1.5rem;margin:0 auto 16px}
    h1{font-size:1.2rem;font-weight:800;color:#374151;margin-bottom:6px}
    .sub{font-size:0.8rem;color:#9CA3AF;font-weight:600;margin-bottom:28px}
    input[type=password]{width:100%;padding:12px 18px;border:1.5px solid #E5E7EB;border-radius:50px;font-family:'Nunito',sans-serif;font-size:0.88rem;font-weight:600;color:#374151;outline:none;margin-bottom:12px;background:#FDFCF0;transition:border-color .2s}
    input[type=password]:focus{border-color:#C4B5FD}
    button{width:100%;padding:12px;background:#374151;color:#fff;border:none;border-radius:50px;font-family:'Nunito',sans-serif;font-size:0.88rem;font-weight:800;cursor:pointer;transition:background .2s}
    button:hover{background:#1F2937}
    .error{margin-top:14px;color:#DC2626;font-size:0.76rem;font-weight:700;background:#FEF2F2;padding:8px 16px;border-radius:50px;display:inline-block}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📋</div>
    <h1>Reportería de Herramientas</h1>
    <p class="sub">Ingresá la contraseña para acceder</p>
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="Contraseña" autofocus autocomplete="current-password"/>
      <button type="submit">Ingresar →</button>
    </form>
    ${error ? '<p class="error">Contraseña incorrecta, intentá de nuevo</p>' : ''}
  </div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  if (req.body.password === APP_PASSWORD) {
    const maxAge = 7 * 24 * 60 * 60;
    res.setHeader('Set-Cookie',
      `auth=${makeToken(APP_PASSWORD)}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/`
    );
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'auth=; HttpOnly; Max-Age=0; Path=/');
  res.redirect('/login');
});

/* ─── Login de líderes ─── */
app.get('/lideres/login', (req, res) => {
  if (!LEADERS_ENABLED) {
    return res.status(503).send('<h1>Líderes no configurados</h1><p>Falta la variable de entorno <code>LEADERS_PASSWORDS</code> en el servidor.</p>');
  }
  const error = req.query.error;
  const teams = Object.keys(LEADERS_PASSWORDS);
  const optionsHTML = teams.map(t => `<div class="dropdown-option" data-value="${t.replace(/"/g, '&quot;')}">${t}</div>`).join('');
  const firstTeam = teams[0] || '';
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>👥</text></svg>"/>
  <title>Acceso Líderes — Reportería de Herramientas</title>
  <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Nunito',sans-serif;background:#FDFCF0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{background:#fff;border-radius:24px;padding:44px 36px;width:420px;max-width:92vw;box-shadow:0 8px 30px rgba(0,0,0,0.08);text-align:center}
    .icon{width:56px;height:56px;background:linear-gradient(135deg,#E3F2FD,#F3E5F5);border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:1.5rem;margin:0 auto 16px}
    h1{font-size:1.2rem;font-weight:800;color:#374151;margin-bottom:6px}
    .sub{font-size:0.8rem;color:#9CA3AF;font-weight:600;margin-bottom:28px}
    label{display:block;text-align:left;font-size:0.7rem;font-weight:800;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;margin-top:14px}
    input[type=password]{width:100%;padding:12px 18px;border:1.5px solid #E5E7EB;border-radius:50px;font-family:'Nunito',sans-serif;font-size:0.88rem;font-weight:600;color:#374151;outline:none;background:#FDFCF0;transition:border-color .2s}
    input[type=password]:focus{border-color:#C4B5FD}

    .dropdown{position:relative;width:100%;text-align:left}
    .dropdown-trigger{width:100%;padding:12px 40px 12px 18px;border:1.5px solid #E5E7EB;border-radius:50px;font-family:'Nunito',sans-serif;font-size:0.88rem;font-weight:600;color:#374151;background:#FDFCF0;outline:none;cursor:pointer;text-align:left;display:flex;align-items:center;position:relative;transition:border-color .2s}
    .dropdown-trigger:hover, .dropdown.open .dropdown-trigger{border-color:#C4B5FD}
    .dropdown-trigger::after{content:"";position:absolute;right:18px;top:50%;width:7px;height:7px;border-right:1.8px solid #6B7280;border-bottom:1.8px solid #6B7280;transform:translateY(-70%) rotate(45deg);transition:transform .2s}
    .dropdown.open .dropdown-trigger::after{transform:translateY(-30%) rotate(-135deg)}
    .dropdown-panel{position:absolute;top:calc(100% + 6px);left:0;right:0;background:#fff;border:1.5px solid #E5E7EB;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,0.08);padding:6px;z-index:50;display:none;max-height:260px;overflow-y:auto}
    .dropdown.open .dropdown-panel{display:block}
    .dropdown-option{padding:9px 14px;border-radius:10px;font-family:'Nunito',sans-serif;font-size:0.85rem;font-weight:600;color:#374151;cursor:pointer;transition:background .15s}
    .dropdown-option:hover{background:#F9FAFB}
    .dropdown-option.selected{background:#374151;color:#fff;font-weight:700}
    .dropdown-option.selected:hover{background:#374151}

    button.primary{width:100%;padding:12px;background:#374151;color:#fff;border:none;border-radius:50px;font-family:'Nunito',sans-serif;font-size:0.88rem;font-weight:800;cursor:pointer;transition:background .2s;margin-top:22px}
    button.primary:hover{background:#1F2937}
    .error{margin-top:14px;color:#DC2626;font-size:0.76rem;font-weight:700;background:#FEF2F2;padding:8px 16px;border-radius:50px;display:inline-block}
    .footer-link{margin-top:24px;font-size:0.74rem;color:#9CA3AF;font-weight:600}
    .footer-link a{color:#7C3AED;text-decoration:none}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">👥</div>
    <h1>Acceso Líderes</h1>
    <p class="sub">Ingresá con la contraseña de tu equipo</p>
    <form method="POST" action="/lideres/login">
      <label>Equipo</label>
      <div class="dropdown" id="teamDropdown">
        <input type="hidden" name="team" id="teamInput" value="${firstTeam.replace(/"/g, '&quot;')}"/>
        <button type="button" class="dropdown-trigger" id="teamTrigger">${firstTeam || 'Elegí tu equipo'}</button>
        <div class="dropdown-panel">${optionsHTML}</div>
      </div>
      <label for="password">Contraseña</label>
      <input type="password" name="password" id="password" placeholder="•••••••••" autocomplete="current-password" required/>
      <button type="submit" class="primary">Ingresar →</button>
    </form>
    ${error ? '<p class="error">Equipo o contraseña incorrectos</p>' : ''}
    <p class="footer-link">¿Sos admin? <a href="/login">Acceder al panel principal</a></p>
  </div>
<script>
  (function(){
    const root = document.getElementById('teamDropdown');
    const trigger = document.getElementById('teamTrigger');
    const input = document.getElementById('teamInput');
    // Marca la opción inicial como selected
    const initial = input.value;
    root.querySelectorAll('.dropdown-option').forEach(o => {
      if (o.dataset.value === initial) o.classList.add('selected');
    });
    trigger.addEventListener('click', function(e){
      e.stopPropagation();
      root.classList.toggle('open');
    });
    root.querySelectorAll('.dropdown-option').forEach(opt => {
      opt.addEventListener('click', function(e){
        e.stopPropagation();
        input.value = opt.dataset.value;
        trigger.textContent = opt.textContent;
        root.querySelectorAll('.dropdown-option.selected').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        root.classList.remove('open');
      });
    });
    document.addEventListener('click', function(){
      root.classList.remove('open');
    });
  })();
</script>
</body>
</html>`);
});

app.post('/lideres/login', (req, res) => {
  const { team, password } = req.body || {};
  if (!team || !password) return res.redirect('/lideres/login?error=1');
  const expectedPw = LEADERS_PASSWORDS[team];
  if (!expectedPw || expectedPw !== password) {
    return res.redirect('/lideres/login?error=1');
  }
  const maxAge = 7 * 24 * 60 * 60;
  const token = makeLeaderToken(team, expectedPw);
  // El valor de cookie es "team|token" para poder leer el equipo desde el server.
  res.setHeader('Set-Cookie',
    `leader_auth=${encodeURIComponent(team)}|${token}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/`
  );
  res.redirect('/lideres');
});

app.get('/lideres/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'leader_auth=; HttpOnly; Max-Age=0; Path=/');
  res.redirect('/lideres/login');
});

app.use(express.static(path.join(__dirname, 'public')));

/* ─── CSV parser (RFC 4180) ─── */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/* ─── Bimester parser ─── */
// Parser tabular plano: lee la primera fila como headers (case-insensitive) y mapea
// las siguientes filas a objetos novedad. Agrupa por columna `equipo`. El orden
// de los equipos respeta TEAMS_ORDER; los equipos que no estén en TEAMS_ORDER se
// agregan al final en el orden que aparezcan.
function parseBimestre(csvText) {
  const rows = parseCSV(csvText);
  if (rows.length === 0) return [];

  const headers = rows[0].map(h => (h || '').trim().toLowerCase());
  const colIndex = name => headers.findIndex(h => h === name);
  const cols = {};
  for (const c of SHEET_COLUMNS) cols[c] = colIndex(c);

  // Si no encuentra ni herramienta ni equipo, el sheet probablemente no tiene
  // el formato esperado (o está vacío). Devolvemos solo los equipos del orden fijo
  // con tools vacíos para que el panel los renderee.
  if (cols.herramienta < 0 || cols.equipo < 0) {
    return TEAMS_ORDER.map(name => ({ name, tools: [] }));
  }

  const get = (row, key) => cols[key] >= 0 ? ((row[cols[key]] || '').toString().trim()) : '';

  const itemsByTeam = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const herramienta = get(row, 'herramienta');
    const equipo      = get(row, 'equipo');
    if (!herramienta || !equipo) continue;

    if (!itemsByTeam.has(equipo)) itemsByTeam.set(equipo, []);
    itemsByTeam.get(equipo).push({
      herramienta,
      queCambio:        get(row, 'que_cambio'),
      nuevaPolitica:    get(row, 'nueva_politica'),
      deficiencia:      get(row, 'deficiencia'),
      responsable:      get(row, 'responsable'),
      proximoPaso:      get(row, 'proximo_paso'),
      tipoCambio:       get(row, 'tipo_cambio'),
      relevancia:       get(row, 'relevancia'),
      aprobadoPor:      get(row, 'aprobado_por'),
      fechaAprobacion:  get(row, 'fecha_aprobacion'),
      fuenteUrl:        get(row, 'fuente_url'),
      sugerenciaHash:   get(row, 'sugerencia_hash'),
    });
  }

  // Render en el orden fijo + extras al final.
  const teams = [];
  const seenTeams = new Set();
  for (const name of TEAMS_ORDER) {
    teams.push({ name, tools: itemsByTeam.get(name) || [] });
    seenTeams.add(name);
  }
  for (const [name, tools] of itemsByTeam) {
    if (!seenTeams.has(name)) teams.push({ name, tools });
  }

  return teams;
}

async function fetchSheetByGid(gid) {
  const url = `https://docs.google.com/spreadsheets/d/e/${PUBLISH_ID}/pub?output=csv&single=true&gid=${encodeURIComponent(gid)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Sheet gid=${gid} returned ${r.status}`);
  return r.text();
}

/* ─── Cache ─── */
let dataCache = null;
let cacheTTL = 0;
const CACHE_DURATION_MS = 30 * 60 * 1000;

app.get('/api/novedades', async (req, res) => {
  try {
    const now = Date.now();
    if (dataCache && now < cacheTTL) return res.json(dataCache);

    const bimestres = await discoverBimestres();
    if (bimestres.length === 0) {
      return res.json({ bimestres: [], fetchedAt: new Date().toISOString(), warning: 'No se detectaron hojas con nombres de bimestre en la planilla.' });
    }

    const results = await Promise.all(bimestres.map(async b => {
      try {
        const csv = await fetchSheetByGid(b.gid);
        return { id: b.id, label: b.label, sheet: b.sheet, gid: b.gid, teams: parseBimestre(csv) };
      } catch (err) {
        console.error(`Error fetching ${b.sheet}:`, err.message);
        return { id: b.id, label: b.label, sheet: b.sheet, gid: b.gid, teams: [], error: err.message };
      }
    }));

    const payload = { bimestres: results, fetchedAt: new Date().toISOString() };
    dataCache = payload;
    cacheTTL = now + CACHE_DURATION_MS;
    res.json(payload);
  } catch (err) {
    console.error('Error fetching sheet data:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/refresh', (req, res) => {
  dataCache = null;
  cacheTTL = 0;
  res.json({ ok: true });
});

/* ─── API: Líderes ─── */

// Encuentra el gid de una hoja por nombre (case-insensitive, exact match).
async function findSheetGid(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/e/${PUBLISH_ID}/pubhtml`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No se pudo listar hojas: ${r.status}`);
  const html = await r.text();
  const re = /items\.push\(\{name:\s*"([^"]+)"[\s\S]*?gid:\s*"(\d+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1].trim().toLowerCase() === sheetName.toLowerCase()) return m[2];
  }
  return null;
}

// Cache para las decisiones leídas del sheet (TTL corto).
let decisionsRemoteCache = null;
let decisionsRemoteCacheTTL = 0;
const DECISIONS_REMOTE_TTL_MS = 60 * 1000;

// Lee la hoja DECISIONES como source of truth de qué decidió cada líder.
// Columnas esperadas (fila 1): sugerencia_hash | equipo | decision | herramienta
// | titulo_original | bimestre_destino | fecha
async function fetchDecisionsFromSheet() {
  const now = Date.now();
  if (decisionsRemoteCache && now < decisionsRemoteCacheTTL) return decisionsRemoteCache;

  let decisions = [];
  try {
    const gid = await findSheetGid('DECISIONES');
    if (!gid) {
      decisionsRemoteCache = [];
      decisionsRemoteCacheTTL = now + DECISIONS_REMOTE_TTL_MS;
      return [];
    }
    const csv = await fetchSheetByGid(gid);
    const rows = parseCSV(csv);
    if (rows.length === 0) {
      decisionsRemoteCache = [];
      decisionsRemoteCacheTTL = now + DECISIONS_REMOTE_TTL_MS;
      return [];
    }
    const headers = rows[0].map(h => (h || '').trim().toLowerCase());
    const idx = name => headers.findIndex(h => h === name);
    const cols = {
      sugerencia_hash:  idx('sugerencia_hash'),
      equipo:           idx('equipo'),
      decision:         idx('decision'),
      herramienta:      idx('herramienta'),
      titulo_original:  idx('titulo_original'),
      bimestre_destino: idx('bimestre_destino'),
      fecha:            idx('fecha'),
    };
    if (cols.sugerencia_hash < 0 || cols.equipo < 0 || cols.decision < 0) {
      console.warn('DECISIONES sheet: faltan columnas requeridas (sugerencia_hash, equipo, decision)');
      decisionsRemoteCache = [];
      decisionsRemoteCacheTTL = now + DECISIONS_REMOTE_TTL_MS;
      return [];
    }
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const get = key => cols[key] >= 0 ? ((row[cols[key]] || '').toString().trim()) : '';
      const hash = get('sugerencia_hash');
      const equipo = get('equipo');
      const decision = get('decision');
      if (!hash || !equipo || !decision) continue;
      decisions.push({
        sugerencia_hash: hash,
        equipo,
        decision,
        herramienta:      get('herramienta'),
        titulo_original:  get('titulo_original'),
        bimestre_destino: get('bimestre_destino'),
        fecha:            get('fecha'),
      });
    }
  } catch (err) {
    console.error('Error leyendo DECISIONES sheet:', err.message);
    // En error devolvemos cache previa (si existe) o vacío
    return decisionsRemoteCache || [];
  }

  decisionsRemoteCache = decisions;
  decisionsRemoteCacheTTL = now + DECISIONS_REMOTE_TTL_MS;
  return decisions;
}

// Fetcha y parsea la hoja SUGERENCIAS (la del workflow de auto-fetch de n8n).
// La hoja tiene columnas: fecha_deteccion | herramienta | fuente_url | titulo_original
// | resumen | proximo_paso | relevancia | estado | bimestre_destino
async function fetchSugerencias() {
  // Encontramos el gid de la hoja "SUGERENCIAS" via discover (cache 30 min igual que el resto)
  const bimestres = await discoverBimestres(); // discoverBimestres filtra hojas con meses; SUGERENCIAS no aparece
  // Para SUGERENCIAS tenemos que listarla aparte. Hacemos un re-fetch del pubhtml
  // y buscamos cualquier hoja llamada exactamente SUGERENCIAS.
  const url = `https://docs.google.com/spreadsheets/d/e/${PUBLISH_ID}/pubhtml`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No se pudo listar hojas: ${r.status}`);
  const html = await r.text();
  const re = /items\.push\(\{name:\s*"([^"]+)"[\s\S]*?gid:\s*"(\d+)"/g;
  let m, sugGid = null;
  while ((m = re.exec(html)) !== null) {
    if (/sugerencias/i.test(m[1])) { sugGid = m[2]; break; }
  }
  if (!sugGid) throw new Error('No se encontró la hoja SUGERENCIAS en la planilla.');

  const csv = await fetchSheetByGid(sugGid);
  const rows = parseCSV(csv);
  if (rows.length === 0) return [];
  // Primera fila = headers
  const headers = rows[0].map(h => (h || '').trim());
  const idx = name => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const cols = {
    fecha_deteccion:  idx('fecha_deteccion'),
    herramienta:      idx('herramienta'),
    fuente_url:       idx('fuente_url'),
    titulo_original:  idx('titulo_original'),
    resumen:          idx('resumen'),
    proximo_paso:     idx('proximo_paso'),
    relevancia:       idx('relevancia'),
    estado:           idx('estado'),
    bimestre_destino: idx('bimestre_destino'),
  };
  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const get = key => cols[key] >= 0 ? (row[cols[key]] || '').trim() : '';
    const herramienta = get('herramienta');
    if (!herramienta) continue; // saltea filas vacías
    items.push({
      fecha_deteccion:  get('fecha_deteccion'),
      herramienta,
      fuente_url:       get('fuente_url'),
      titulo_original:  get('titulo_original'),
      resumen:          get('resumen'),
      proximo_paso:     get('proximo_paso'),
      relevancia:       get('relevancia'),
      estado:           get('estado'),
      bimestre_destino: get('bimestre_destino'),
    });
  }
  return items.map(s => ({ ...s, _hash: suggestionHash(s) }));
}

// Endpoint: GET /api/lideres/sugerencias
// Devuelve las sugerencias que aún no decidió ESTE líder, + la lista de bimestres
// disponibles para elegir destino.
app.get('/api/lideres/sugerencias', async (req, res) => {
  try {
    const team = req.leaderTeam;
    const sugerencias = await fetchSugerencias();
    const local = loadDecisions();
    const remote = await fetchDecisionsFromSheet().catch(() => []);

    // Unión de hashes decididos por este equipo (local + remoto)
    const decidedHashes = new Set();
    local.decisions.filter(d => d.leaderTeam === team).forEach(d => decidedHashes.add(d.suggestionHash));
    remote.filter(d => d.equipo === team).forEach(d => decidedHashes.add(d.sugerencia_hash));

    const pendientes = sugerencias.filter(s => !decidedHashes.has(s._hash));
    const bimestres = (await discoverBimestres()).map(b => ({ sheet: b.sheet, label: b.label, sortKey: b.sortKey }));
    const herramientasMiEquipo = TEAMS_TOOLS[team] || [];
    res.json({ team, pendientes, bimestres, herramientasMiEquipo });
  } catch (err) {
    console.error('Error /api/lideres/sugerencias:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: GET /api/lideres/aprobadas
// Devuelve las decisiones tomadas por ESTE líder, mergeando lo del sheet
// (source of truth, persiste entre redeploys) con el JSON local (datos ricos
// como queCambio/nuevaPolitica que no se guardan en DECISIONES).
app.get('/api/lideres/aprobadas', async (req, res) => {
  try {
    const team = req.leaderTeam;
    const local = loadDecisions();
    const remote = await fetchDecisionsFromSheet().catch(() => []);

    // Mapa por hash con la versión "rica" (local) preferida sobre la "remota" (sheet).
    const byHash = new Map();
    remote.filter(d => d.equipo === team).forEach(d => {
      byHash.set(d.sugerencia_hash, {
        id: 'remote-' + d.sugerencia_hash,
        leaderTeam: team,
        suggestionHash: d.sugerencia_hash,
        decision: d.decision,
        decidedAt: d.fecha ? `${d.fecha}T00:00:00.000Z` : '',
        fields: {
          herramienta: d.herramienta || '',
          titulo_original: d.titulo_original || '',
          queCambio: '', nuevaPolitica: '', deficiencia: '',
          responsable: '', proximoPaso: '',
        },
        bimestreDestino: d.bimestre_destino || null,
        source: 'remote',
      });
    });
    // Local sobreescribe (tiene los campos ricos)
    local.decisions.filter(d => d.leaderTeam === team).forEach(d => {
      byHash.set(d.suggestionHash, { ...d, source: 'local' });
    });

    const mias = Array.from(byHash.values())
      .sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || ''));
    res.json({ team, decisiones: mias });
  } catch (err) {
    console.error('Error /api/lideres/aprobadas:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: POST /api/lideres/decision
// Body: { suggestionHash, decision: 'approved'|'rejected', bimestreDestino?,
//         herramienta?, queCambio?, nuevaPolitica?, deficiencia?, responsable?, proximoPaso? }
// Si decision='approved', además dispara el webhook de n8n para escribir en el Sheet.
app.use('/api/lideres', express.json({ limit: '512kb' }));
app.post('/api/lideres/decision', async (req, res) => {
  try {
    const team = req.leaderTeam;
    const body = req.body || {};
    const { suggestionHash: hash, decision } = body;
    if (!hash) return res.status(400).json({ error: 'Falta suggestionHash' });
    if (decision !== 'approved' && decision !== 'rejected') {
      return res.status(400).json({ error: 'decision debe ser approved o rejected' });
    }

    // Guardar decisión local primero (siempre)
    const data = loadDecisions();
    // Reemplazá decisión previa del mismo líder sobre la misma sugerencia (re-decisión).
    data.decisions = data.decisions.filter(d => !(d.leaderTeam === team && d.suggestionHash === hash));
    const decisionRecord = {
      id: crypto.randomBytes(8).toString('hex'),
      leaderTeam: team,
      suggestionHash: hash,
      decision,
      decidedAt: new Date().toISOString(),
      // Siempre guardamos herramienta + título para poder mostrarlo en "Mis decisiones",
      // incluso cuando es un rechazo (en cuyo caso los demás fields quedan vacíos).
      fields: {
        herramienta:     body.herramienta     || '',
        titulo_original: body.titulo_original || '',
        queCambio:       body.queCambio       || '',
        nuevaPolitica:   body.nuevaPolitica   || '',
        deficiencia:     body.deficiencia     || '',
        responsable:     body.responsable     || '',
        proximoPaso:     body.proximoPaso     || '',
      },
      bimestreDestino: decision === 'approved' ? (body.bimestreDestino || '') : null,
    };
    data.decisions.push(decisionRecord);
    saveDecisions(data);

    // Disparamos el webhook de n8n SIEMPRE (tanto aprobaciones como rechazos)
    // para que quede registrado en la hoja DECISIONES. Si es aprobación, n8n
    // además appendea a la hoja del bimestre destino.
    let n8nResult = null;
    if (!N8N_WRITE_WEBHOOK_URL || N8N_WRITE_WEBHOOK_URL === 'PENDIENTE') {
      n8nResult = { warning: 'N8N_WRITE_WEBHOOK_URL no configurada — decisión guardada local pero no se persistió en el Sheet.' };
    } else if (decision === 'approved' && !decisionRecord.bimestreDestino) {
      n8nResult = { warning: 'No se especificó bimestreDestino — aprobación guardada local pero no se escribió en ninguna hoja.' };
    } else {
      try {
        const r = await fetch(N8N_WRITE_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision,                                    // 'approved' | 'rejected'
            sugerencia_hash:  hash,
            equipo:           team,
            herramienta:      decisionRecord.fields.herramienta,
            titulo_original:  decisionRecord.fields.titulo_original || '',
            bimestre:         decisionRecord.bimestreDestino || '',
            // Campos del cambio (vacíos para rechazos)
            que_cambio:       decisionRecord.fields.queCambio,
            nueva_politica:   decisionRecord.fields.nuevaPolitica,
            deficiencia:      decisionRecord.fields.deficiencia,
            responsable:      decisionRecord.fields.responsable,
            proximo_paso:     decisionRecord.fields.proximoPaso,
            tipo_cambio:      body.tipo_cambio || '',
            relevancia:       body.relevancia  || '',
            aprobado_por:     team,
            fecha:            new Date().toISOString().slice(0, 10),
            fuente_url:       body.fuente_url || '',
          }),
        });
        n8nResult = { status: r.status, ok: r.ok };
        if (r.ok) {
          // Invalidar caches para que cambios aparezcan al toque.
          dataCache = null;
          cacheTTL = 0;
          decisionsRemoteCache = null;
          decisionsRemoteCacheTTL = 0;
        }
      } catch (err) {
        console.error('Error llamando a n8n webhook:', err.message);
        n8nResult = { error: err.message };
      }
    }

    res.json({ ok: true, decision: decisionRecord, n8n: n8nResult });
  } catch (err) {
    console.error('Error /api/lideres/decision:', err);
    res.status(500).json({ error: err.message });
  }
});

// HTML principal del panel de líderes (servido vía estático, pero gated por el
// middleware). Sirve lideres.html.
app.get('/lideres', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lideres.html'));
});

app.listen(PORT, () => {
  console.log(`\n✅ Servidor corriendo en http://localhost:${PORT}`);
  if (AUTH_ENABLED) console.log('🔒 Autenticación admin activada');
  else console.log('⚠️  Sin contraseña admin (APP_PASSWORD no configurada)');
  if (LEADERS_ENABLED) {
    console.log(`👥 Líderes habilitados: ${Object.keys(LEADERS_PASSWORDS).join(', ')}`);
    if (!N8N_WRITE_WEBHOOK_URL || N8N_WRITE_WEBHOOK_URL === 'PENDIENTE') {
      console.log('   ⚠️  N8N_WRITE_WEBHOOK_URL pendiente — las aprobaciones no escribirán en el Sheet hasta configurarla.');
    }
  } else {
    console.log('⚠️  Líderes deshabilitados (LEADERS_PASSWORDS no configurada)');
  }
});
