import { readFileSync } from 'node:fs';
import express from 'express';
import { env, getRuntimeConfig, skTorrentConfigured, withRuntimeConfig } from './env.js';
import { configEncryptionReady, decryptConfig, encryptConfig } from './config-token.js';
import { parseStremioId } from './domain/media.js';
import { buildStreams } from './services/streams.js';
import { startTorrentDownload } from './services/torbox.js';

const torboxDownloadingVideo = readFileSync(new URL('./assets/torbox-downloading.mp4', import.meta.url));

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '8kb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const manifestCore = Object.freeze({
  id: env.addonId,
  version: '2.0.0',
  name: env.addonName,
  description: 'Personal SKTorrent stream addon with Czech/Slovak metadata matching and optional TorBox acceleration.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt']
});

const unconfiguredManifest = Object.freeze({
  ...manifestCore,
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
    p2p: true
  }
});

const configuredManifest = Object.freeze({
  ...manifestCore,
  behaviorHints: {
    configurable: true,
    configurationRequired: false,
    p2p: true
  }
});

function normalizeOrigin(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function publicOrigin(req) {
  const configured = normalizeOrigin(process.env.PUBLIC_URL);
  if (configured) return configured;

  const vercelProduction = normalizeOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  if (vercelProduction) return vercelProduction;

  const host = String(req.get('host') || '').trim();
  let protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  if (/\.vercel\.app(?::\d+)?$/i.test(host)) protocol = 'https';
  return `${protocol}://${host}`;
}

function torboxStartBaseUrl(req) {
  const config = getRuntimeConfig();
  if (!config.torboxKey || !env.torboxDirectLinks) return '';

  const origin = publicOrigin(req);
  return req.params.token
    ? `${origin}/c/${encodeURIComponent(req.params.token)}`
    : origin;
}

function stremioUrl(manifestUrl) {
  return manifestUrl.replace(/^https?:\/\//i, 'stremio://');
}

function readFormConfig(body) {
  return {
    sktUid: String(body?.sktUid || '').trim(),
    sktPass: String(body?.sktPass || '').trim(),
    torboxKey: String(body?.torboxKey || '').trim(),
    tmdbKey: String(body?.tmdbKey || '').trim()
  };
}

function validateFormConfig(config) {
  if (!config.sktUid) return 'SKTorrent UID is required.';
  if (!config.sktPass) return 'SKTorrent PASS cookie is required.';
  if (config.sktUid.length > 200 || config.sktPass.length > 1000 || config.torboxKey.length > 1000 || config.tmdbKey.length > 1000) {
    return 'One of the supplied values is unexpectedly long.';
  }
  return null;
}

function renderPage(req, { error = '', manifestUrl = '', editing = false } = {}) {
  const encryptionReady = configEncryptionReady();
  const installUrl = manifestUrl ? stremioUrl(manifestUrl) : '';
  const envConfig = getRuntimeConfig();

  return `<!doctype html>
<html lang="sk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(env.addonName)}</title>
<style>
:root{color-scheme:dark;--ink:#f8fafc;--muted:#94a3b8;--panel:rgba(15,23,42,.78);--line:rgba(148,163,184,.18);--violet:#8b5cf6;--cyan:#22d3ee;--green:#34d399}*{box-sizing:border-box}html{min-height:100%;background:#050816}body{margin:0;min-height:100vh;font-family:ui-rounded,"SF Pro Rounded",Inter,system-ui,sans-serif;color:var(--ink);line-height:1.55;background:radial-gradient(circle at 12% 4%,rgba(76,29,149,.32),transparent 34rem),radial-gradient(circle at 90% 22%,rgba(8,145,178,.2),transparent 30rem)}body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.18;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:32px 32px}.shell{position:relative;width:min(1080px,calc(100% - 36px));margin:auto;padding:28px 0 72px}.nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:56px}.brand{display:flex;align-items:center;gap:12px;font-size:15px;font-weight:800;letter-spacing:.04em}.mark{display:grid;place-items:center;width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,var(--violet),var(--cyan));box-shadow:0 8px 30px rgba(34,211,238,.2)}.mark svg{width:22px}.nav a{color:var(--muted);text-decoration:none;font-size:14px}.hero{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(280px,.75fr);gap:36px;align-items:center;margin-bottom:38px}.eyebrow{display:inline-flex;gap:8px;align-items:center;padding:6px 10px;border:1px solid rgba(52,211,153,.25);border-radius:99px;color:#a7f3d0;background:rgba(16,185,129,.08);font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 12px var(--green)}h1{max-width:730px;margin:18px 0 16px;font-size:clamp(38px,6vw,67px);line-height:1.02;letter-spacing:-.05em}h1 span{background:linear-gradient(90deg,#c4b5fd,#67e8f9);-webkit-background-clip:text;background-clip:text;color:transparent}.lead{max-width:650px;margin:0;color:#b8c2d3;font-size:18px}.route-card{padding:22px;border:1px solid var(--line);border-radius:24px;background:linear-gradient(145deg,rgba(30,41,59,.8),rgba(15,23,42,.6));box-shadow:0 24px 60px rgba(0,0,0,.28)}.route{display:flex;align-items:center;gap:13px;padding:12px 0}.route+.route{border-top:1px solid var(--line)}.route-icon{display:grid;place-items:center;flex:0 0 38px;height:38px;border-radius:11px;background:rgba(139,92,246,.13);font-size:18px}.route strong,.route small{display:block}.route small{color:var(--muted)}.content{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:24px}.card{border:1px solid var(--line);border-radius:24px;padding:clamp(22px,4vw,34px);background:var(--panel);box-shadow:0 24px 70px rgba(0,0,0,.24);backdrop-filter:blur(18px)}h2{margin:0 0 5px;font-size:22px;letter-spacing:-.02em}.muted{color:var(--muted)}.section-intro{margin:0 0 24px;color:var(--muted);font-size:14px}.field{margin-top:18px}label{display:flex;justify-content:space-between;gap:12px;margin-bottom:8px;font-size:13px;font-weight:800}.optional{color:#64748b;font-weight:600}input{width:100%;border:1px solid #334155;border-radius:13px;padding:13px 14px;background:#080d1c;color:#fff;font:inherit;outline:none;transition:.2s}input::placeholder{color:#526075}input:focus{border-color:var(--cyan);box-shadow:0 0 0 4px rgba(34,211,238,.1)}small{display:block;margin-top:7px;color:#718096;font-size:12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:24px}button,.button{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:13px;padding:13px 18px;background:linear-gradient(100deg,var(--violet),#6366f1);box-shadow:0 10px 24px rgba(99,102,241,.25);color:white;font:inherit;font-weight:800;text-decoration:none;cursor:pointer}button:disabled{filter:grayscale(1);opacity:.45;cursor:not-allowed}.secondary{border:1px solid #334155;background:#111827;box-shadow:none}.notice{margin:0 0 18px;padding:13px 15px;border:1px solid;border-radius:14px;font-size:14px}.notice.bad{border-color:rgba(248,113,113,.35);background:rgba(127,29,29,.2);color:#fecaca}.notice.ok{border-color:rgba(52,211,153,.3);background:rgba(6,78,59,.25);color:#a7f3d0}.notice.info{border-color:rgba(34,211,238,.28);background:rgba(14,116,144,.15);color:#bae6fd}.status{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--line);font-size:13px}.status:last-of-type{border:0}.pill{padding:4px 8px;border-radius:99px;background:rgba(52,211,153,.12);color:#6ee7b7;font-size:11px;font-weight:800}.pill.off{background:rgba(148,163,184,.1);color:#94a3b8}.steps{margin:26px 0 0;padding:0;list-style:none;counter-reset:steps}.steps li{position:relative;margin:0 0 18px;padding-left:38px;color:#aab5c5;font-size:13px}.steps li:before{counter-increment:steps;content:counter(steps);position:absolute;left:0;top:-2px;display:grid;place-items:center;width:26px;height:26px;border:1px solid #475569;border-radius:8px;color:#c4b5fd;font-weight:900}.manifest{overflow-wrap:anywhere;margin:18px 0;padding:14px;border:1px dashed #475569;border-radius:12px;background:#070b17;color:#bae6fd;font:12px ui-monospace,monospace}.secret-note{margin:20px 0 0;color:#718096;font-size:12px}code{padding:2px 5px;border-radius:5px;background:#1e293b;color:#c4b5fd}a{color:#67e8f9}.footer{margin-top:26px;text-align:center;color:#526075;font-size:12px}@media(max-width:800px){.hero,.content{grid-template-columns:1fr}.route-card{display:none}.nav{margin-bottom:36px}.content aside{order:-1}}@media(max-width:560px){.shell{width:min(100% - 24px,1080px);padding-top:18px}.grid{grid-template-columns:1fr}h1{font-size:40px}.lead{font-size:16px}.card{border-radius:19px}.nav>a{display:none}.row>*{width:100%}}
</style>
</head>
<body>
<div class="shell">
<nav class="nav"><div class="brand"><span class="mark"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 5.5 17.5 12 7 18.5v-13Z" fill="white"/><path d="M3.5 3.5v17M20.5 3.5v17" stroke="white" stroke-width="1.5" stroke-linecap="round" opacity=".55"/></svg></span>${escapeHtml(env.addonName)}</div><a href="/health">Stav služby →</a></nav>
<header class="hero"><div><span class="eyebrow"><span class="dot"></span> pripravené pre Stremio</span><h1>Lokálne torrenty.<br><span>Pohodlné prehrávanie.</span></h1><p class="lead">Prepojte SKTorrent so Stremiom a voliteľne zrýchlite prehrávanie cez TorBox. Jedna súkromná konfigurácia, filmy aj seriály.</p></div><div class="route-card"><div class="route"><span class="route-icon">🔎</span><div><strong>Inteligentné hľadanie</strong><small>CZ, SK a pôvodné názvy</small></div></div><div class="route"><span class="route-icon">⚡</span><div><strong>TorBox cache</strong><small>Okamžité priame streamy</small></div></div><div class="route"><span class="route-icon">🔐</span><div><strong>Šifrovaný profil</strong><small>Heslá sa nezobrazujú</small></div></div></div></header>

${!encryptionReady ? `<div class="notice bad"><strong>One-time setup required:</strong> add a Vercel environment variable named <code>CONFIG_SECRET</code> with a random value of at least 24 characters, then redeploy. The form will work after that.</div>` : ''}
${editing ? `<div class="notice info"><strong>Reconfigure addon:</strong> enter the desired values below and install the newly generated configuration in Stremio. Existing secrets are intentionally not displayed back in the browser.</div>` : ''}
${error ? `<div class="notice bad">${escapeHtml(error)}</div>` : ''}
${manifestUrl ? `<div class="notice ok"><strong>Configuration created.</strong> You can now install this private manifest in Stremio.</div>` : ''}

<main class="content"><section class="card">
<h2>${editing ? 'Upraviť pripojenie' : 'Nastaviť pripojenie'}</h2><p class="section-intro">Údaje nájdete v cookies prihlásenej relácie SKTorrent.</p>
<form method="post" action="/configure" autocomplete="off">
<div class="grid">
<div class="field">
<label for="sktUid">SKTorrent UID</label>
<input id="sktUid" name="sktUid" type="text" inputmode="numeric" required placeholder="Hodnota cookie uid">
<small>Cookie <code>uid</code> po prihlásení.</small>
</div>
<div class="field">
<label for="sktPass">SKTorrent PASS</label>
<input id="sktPass" name="sktPass" type="password" required placeholder="Hodnota cookie pass">
<small>Cookie <code>pass</code> sa nikdy nevypíše späť.</small>
</div>
</div>
<div class="field"><label for="torboxKey">TorBox API kľúč <span class="optional">voliteľné</span></label><input id="torboxKey" name="torboxKey" type="password" placeholder="tb-…"><small>Kontrola cache a priame prehrávanie bez čakania.</small></div>
<div class="field"><label for="tmdbKey">TMDB API kľúč <span class="optional">voliteľné</span></label><input id="tmdbKey" name="tmdbKey" type="password" placeholder="TMDB API kľúč"><small>Presnejšie české, slovenské a originálne názvy.</small></div>
<div class="row"><button type="submit" ${encryptionReady ? '' : 'disabled'}>${editing ? 'Vytvoriť nový profil →' : 'Vytvoriť profil pre Stremio →'}</button></div>
</form>
<p class="secret-note">Údaje server šifruje pomocou AES-256-GCM a kľúča <code>CONFIG_SECRET</code>. Vygenerovaný odkaz uchovajte v súkromí.</p>

${manifestUrl ? `<div><h2 style="margin-top:30px">Váš manifest</h2><div class="manifest" id="manifest">${escapeHtml(manifestUrl)}</div><div class="row"><a class="button" href="${escapeHtml(installUrl)}">Nainštalovať v Stremio</a><button class="secondary" type="button" onclick="navigator.clipboard.writeText(document.getElementById('manifest').textContent)">Kopírovať odkaz</button></div></div>` : ''}
</section>

<aside class="card"><h2>Ako začať</h2><ol class="steps"><li>Prihláste sa na SKTorrent a skopírujte cookies.</li><li>Vyplňte kľúče a vytvorte súkromný profil.</li><li>Otvorte odkaz v Stremio a vyberte stream.</li></ol><div class="status"><span>Šifrovanie profilu</span><span class="pill ${encryptionReady ? '' : 'off'}">${encryptionReady ? 'AKTÍVNE' : 'CHÝBA KĽÚČ'}</span></div><div class="status"><span>Záložné údaje servera</span><span class="pill ${skTorrentConfigured(envConfig) ? '' : 'off'}">${skTorrentConfigured(envConfig) ? 'NASTAVENÉ' : 'VOLITEĽNÉ'}</span></div></aside></main>
<footer class="footer">Súkromný most medzi SKTorrent, Stremio a TorBox.</footer></div>
</body></html>`;
}

function sendVideoBuffer(req, res, buffer) {
  const total = buffer.length;
  const range = String(req.headers.range || '').trim();

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.setHeader('Content-Length', String(total));
    return res.status(200).end(buffer);
  }

  let start;
  let end;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(total - suffixLength, 0);
    end = total - 1;
  } else {
    start = match[1] ? Number(match[1]) : 0;
    end = match[2] ? Number(match[2]) : total - 1;
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= total || end < start) {
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }

  end = Math.min(end, total - 1);
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', String(end - start + 1));
  return res.end(buffer.subarray(start, end + 1));
}

app.get('/health', (_req, res) => {
  const config = getRuntimeConfig();
  res.json({
    ok: true,
    addon: env.addonName,
    version: manifestCore.version,
    configurationUiReady: configEncryptionReady(),
    environmentFallbackConfigured: skTorrentConfigured(config),
    torboxEnvironmentFallback: Boolean(config.torboxKey),
    tmdbEnvironmentFallback: Boolean(config.tmdbKey)
  });
});

app.get('/manifest.json', (_req, res) => res.json(unconfiguredManifest));
app.get('/c/:token/manifest.json', (req, res) => {
  try {
    const config = decryptConfig(req.params.token);
    if (!skTorrentConfigured(config)) return res.status(400).json({ error: 'Invalid addon configuration' });
    return res.json(configuredManifest);
  } catch {
    return res.status(400).json({ error: 'Invalid addon configuration' });
  }
});

async function handleStream(req, res) {
  const type = req.params.type === 'series' ? 'series' : req.params.type === 'movie' ? 'movie' : null;
  if (!type) return res.status(400).json({ streams: [] });
  if (!skTorrentConfigured()) return res.status(503).json({ streams: [], error: 'SKTorrent credentials are not configured for this addon URL.' });

  const parsed = parseStremioId(req.params.id);
  if (!/^tt\d+$/.test(parsed.imdbId)) return res.json({ streams: [] });
  if (type === 'series' && (!Number.isInteger(parsed.season) || !Number.isInteger(parsed.episode))) return res.json({ streams: [] });

  const started = Date.now();
  try {
    const streams = await buildStreams({
      type,
      ...parsed,
      torboxStartBaseUrl: torboxStartBaseUrl(req)
    });
    console.log(`[stream] ${type} ${req.params.id} -> ${streams.length} streams in ${Date.now() - started}ms`);
    return res.json({ streams });
  } catch (error) {
    console.error(`[stream] ${type} ${req.params.id} failed:`, error);
    return res.status(200).json({ streams: [], error: error.message });
  }
}

async function handleTorboxStart(req, res) {
  const hash = String(req.params.hash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(hash)) return res.status(400).json({ error: 'Invalid torrent hash' });
  if (!getRuntimeConfig().torboxKey) return res.status(503).json({ error: 'TorBox API key is not configured for this addon URL.' });

  try {
    const torrent = await startTorrentDownload(hash);
    const state = String(torrent?.download_state || torrent?.status || '').trim() || 'started';
    console.log(`[torbox] selected ${hash} -> torrent=${torrent?.id ?? 'unknown'} state=${state}`);
    return sendVideoBuffer(req, res, torboxDownloadingVideo);
  } catch (error) {
    console.error(`[torbox] failed to start ${hash}:`, error);
    return res.status(502).json({ error: 'Could not start the TorBox download.' });
  }
}

app.get('/stream/:type/:id.json', handleStream);
app.get('/c/:token/stream/:type/:id.json', async (req, res) => {
  let config;
  try {
    config = decryptConfig(req.params.token);
  } catch {
    return res.status(400).json({ streams: [], error: 'Invalid addon configuration' });
  }
  return withRuntimeConfig(config, () => handleStream(req, res));
});

app.get('/torbox/start/:hash/video.mp4', handleTorboxStart);
app.get('/c/:token/torbox/start/:hash/video.mp4', async (req, res) => {
  let config;
  try {
    config = decryptConfig(req.params.token);
  } catch {
    return res.status(400).json({ error: 'Invalid addon configuration' });
  }
  return withRuntimeConfig(config, () => handleTorboxStart(req, res));
});

app.get(['/', '/configure'], (req, res) => {
  res.type('html').send(renderPage(req));
});

app.get('/c/:token/configure', (req, res) => {
  try {
    const config = decryptConfig(req.params.token);
    if (!skTorrentConfigured(config)) throw new Error('Invalid configuration');
    return res.type('html').send(renderPage(req, { editing: true }));
  } catch {
    return res.status(400).type('html').send(renderPage(req, { error: 'This installed addon configuration is invalid or can no longer be decrypted.' }));
  }
});

app.post('/configure', (req, res) => {
  if (!configEncryptionReady()) {
    return res.status(503).type('html').send(renderPage(req, { error: 'CONFIG_SECRET is not configured on this deployment yet.' }));
  }

  const config = readFormConfig(req.body);
  const validationError = validateFormConfig(config);
  if (validationError) return res.status(400).type('html').send(renderPage(req, { error: validationError }));

  try {
    const token = encryptConfig(config);
    const manifestUrl = `${publicOrigin(req)}/c/${token}/manifest.json`;
    return res.type('html').send(renderPage(req, { manifestUrl }));
  } catch (error) {
    console.error('[configure] failed to create config token:', error.message);
    return res.status(500).type('html').send(renderPage(req, { error: 'Could not create the configuration token.' }));
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

app.use((error, _req, res, _next) => {
  console.error('[http] unhandled error:', error);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
