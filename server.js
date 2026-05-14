const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

const SHEET_ID      = '116pmPoOiZ5CVwTYRYHpBUaV1FcdLw8KH';
const APP_PASSWORD  = process.env.APP_PASSWORD;
const AUTH_ENABLED  = !!APP_PASSWORD;
const COOKIE_SECRET = 'taquion_reporteria_2025';

const BIMESTRES = [
  { id: 'jun-jul',  sheet: 'JUNIO- JULIO',     label: 'Junio - Julio' },
  { id: 'ago-sep',  sheet: 'AGOSTO- SEPT',     label: 'Agosto - Septiembre' },
  { id: 'oct-nov',  sheet: 'OCTUBRE - NOV',    label: 'Octubre - Noviembre' },
  { id: 'dic-ene',  sheet: 'DICIEMRE- ENERO',  label: 'Diciembre - Enero' },
];

const COL_MAP = {
  herramienta:   0,
  queCambio:     1,
  nuevaPolitica: 2,
  deficiencia:   3,
  responsable:   4,
  proximoPaso:   5,
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

app.use((req, res, next) => {
  if (!AUTH_ENABLED) return next();
  if (req.path === '/login' || req.path === '/logout') return next();
  if (isAuthenticated(req)) return next();
  res.redirect('/login');
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
function parseBimestre(csvText) {
  const rows = parseCSV(csvText);
  const teams = [];
  let currentTeam = null;
  let headerSeen = false;

  for (const row of rows) {
    const cells = row.map(c => (c || '').trim());
    const nonEmpty = cells.filter(Boolean);
    if (nonEmpty.length === 0) continue;

    // Section header: a row where the only non-empty cell is NOT in column 0
    // (the herramienta column) and looks like a team name (uppercase).
    // This prevents a tool with an all-uppercase name (e.g. "APOLLO") from
    // being misread as a team header.
    if (nonEmpty.length === 1 && !cells[COL_MAP.herramienta]) {
      const candidate = nonEmpty[0];
      if (candidate.toLowerCase() !== 'herramienta' && /^[A-ZÁÉÍÓÚÑÜ\s\/\-&]{3,}$/.test(candidate)) {
        currentTeam = { name: candidate, tools: [] };
        teams.push(currentTeam);
        headerSeen = false;
        continue;
      }
    }

    // Column header row
    if (cells[COL_MAP.herramienta]?.toLowerCase() === 'herramienta') {
      headerSeen = true;
      continue;
    }

    // Data row
    if (currentTeam && headerSeen) {
      const herramienta = cells[COL_MAP.herramienta];
      if (!herramienta) continue;
      currentTeam.tools.push({
        herramienta,
        queCambio:     cells[COL_MAP.queCambio]     || '',
        nuevaPolitica: cells[COL_MAP.nuevaPolitica] || '',
        deficiencia:   cells[COL_MAP.deficiencia]   || '',
        responsable:   cells[COL_MAP.responsable]   || '',
        proximoPaso:   cells[COL_MAP.proximoPaso]   || '',
      });
    }
  }
  return teams;
}

async function fetchSheet(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Sheet "${sheetName}" returned ${r.status}`);
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

    const results = [];
    for (const b of BIMESTRES) {
      try {
        const csv = await fetchSheet(b.sheet);
        const teams = parseBimestre(csv);
        results.push({ id: b.id, label: b.label, sheet: b.sheet, teams });
      } catch (err) {
        console.error(`Error fetching ${b.sheet}:`, err.message);
        results.push({ id: b.id, label: b.label, sheet: b.sheet, teams: [], error: err.message });
      }
    }

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

app.listen(PORT, () => {
  console.log(`\n✅ Servidor corriendo en http://localhost:${PORT}`);
  if (AUTH_ENABLED) console.log('🔒 Autenticación activada');
  else console.log('⚠️  Sin contraseña (APP_PASSWORD no configurada)');
});
