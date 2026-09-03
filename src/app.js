import express from 'express';
import { env, getRuntimeConfig, skTorrentConfigured, withRuntimeConfig } from './env.js';
import { configEncryptionReady, decryptConfig, encryptConfig } from './config-token.js';
import { parseStremioId } from './domain/media.js';
import { buildStreams } from './services/streams.js';

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
  version: '1.2.1',
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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(env.addonName)}</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:820px;margin:0 auto;padding:42px 20px 70px;line-height:1.5;background:#101010;color:#f3f3f3}h1{font-size:32px;margin:0 0 10px}.muted{color:#b9b9b9}.card{border:1px solid #343434;border-radius:16px;padding:24px;margin:22px 0;background:#181818}label{display:block;font-weight:700;margin:16px 0 7px}input{width:100%;font:inherit;color:#fff;background:#101010;border:1px solid #444;border-radius:9px;padding:12px 13px;outline:none}input:focus{border-color:#8fbfff;box-shadow:0 0 0 3px rgba(143,191,255,.12)}button,.button{display:inline-block;font:inherit;font-weight:700;padding:11px 16px;border:0;border-radius:9px;cursor:pointer;background:#f2f2f2;color:#111;text-decoration:none}.secondary{background:#292929;color:#eee;border:1px solid #464646}.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}.ok{color:#7be39b}.bad{color:#ff9b9b}.notice{border-radius:10px;padding:12px 14px;margin:14px 0}.notice.bad{background:#321a1a;border:1px solid #653030}.notice.ok{background:#17301f;border:1px solid #2d6540}.notice.info{background:#17283a;border:1px solid #31577a;color:#cfe6ff}code{word-break:break-all;background:#252525;padding:3px 6px;border-radius:5px}small{display:block;color:#aaa;margin-top:6px}a{color:#9ecbff}.secret-note{font-size:14px;color:#aaa;margin-top:18px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:650px){.grid{grid-template-columns:1fr}body{padding-top:28px}}
</style>
</head>
<body>
<h1>${escapeHtml(env.addonName)}</h1>
<p class="muted">Configure your private SKTorrent Stremio addon here. The generated Stremio URL contains an encrypted configuration token, not your plaintext credentials.</p>

${!encryptionReady ? `<div class="notice bad"><strong>One-time setup required:</strong> add a Vercel environment variable named <code>CONFIG_SECRET</code> with a random value of at least 24 characters, then redeploy. The form will work after that.</div>` : ''}
${editing ? `<div class="notice info"><strong>Reconfigure addon:</strong> enter the desired values below and install the newly generated configuration in Stremio. Existing secrets are intentionally not displayed back in the browser.</div>` : ''}
${error ? `<div class="notice bad">${escapeHtml(error)}</div>` : ''}
${manifestUrl ? `<div class="notice ok"><strong>Configuration created.</strong> You can now install this private manifest in Stremio.</div>` : ''}

<div class="card">
<h2 style="margin-top:0">Addon configuration</h2>
<form method="post" action="/configure" autocomplete="off">
<div class="grid">
<div>
<label for="sktUid">SKTorrent UID</label>
<input id="sktUid" name="sktUid" type="text" inputmode="numeric" required placeholder="uid cookie value">
<small>From the <code>uid</code> cookie after signing in to SKTorrent.</small>
</div>
<div>
<label for="sktPass">SKTorrent PASS</label>
<input id="sktPass" name="sktPass" type="password" required placeholder="pass cookie value">
<small>From the <code>pass</code> cookie. It is never echoed back into this page.</small>
</div>
</div>
<label for="torboxKey">TorBox API key <span class="muted">(optional)</span></label>
<input id="torboxKey" name="torboxKey" type="password" placeholder="TorBox API key">
<label for="tmdbKey">TMDB API key <span class="muted">(optional)</span></label>
<input id="tmdbKey" name="tmdbKey" type="password" placeholder="TMDB API key">
<div class="row"><button type="submit" ${encryptionReady ? '' : 'disabled'}>${editing ? 'Create updated configuration' : 'Create Stremio configuration'}</button></div>
</form>
<p class="secret-note">The server encrypts these values with AES-256-GCM using your deployment's <code>CONFIG_SECRET</code>. Keep both the generated manifest URL and your CONFIG_SECRET private.</p>
</div>

${manifestUrl ? `<div class="card"><h2 style="margin-top:0">Your Stremio manifest</h2><p><code id="manifest">${escapeHtml(manifestUrl)}</code></p><div class="row"><a class="button" href="${escapeHtml(installUrl)}">Install in Stremio</a><button class="secondary" type="button" onclick="navigator.clipboard.writeText(document.getElementById('manifest').textContent)">Copy manifest URL</button></div></div>` : ''}

<div class="card"><strong>Server status</strong><br>Configuration form: <span class="${encryptionReady ? 'ok' : 'bad'}">${encryptionReady ? 'Ready' : 'Missing CONFIG_SECRET'}</span><br>Environment fallback credentials: ${skTorrentConfigured(envConfig) ? '<span class="ok">Configured</span>' : '<span class="muted">Not configured (not required when using the form)</span>'}<br><a href="/health">Open health check</a></div>
</body></html>`;
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
    const streams = await buildStreams({ type, ...parsed });
    console.log(`[stream] ${type} ${req.params.id} -> ${streams.length} streams in ${Date.now() - started}ms`);
    return res.json({ streams });
  } catch (error) {
    console.error(`[stream] ${type} ${req.params.id} failed:`, error);
    return res.status(200).json({ streams: [], error: error.message });
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
