import express from 'express';
import { env, skTorrentConfigured } from './env.js';
import { parseStremioId } from './domain/media.js';
import { buildStreams } from './services/streams.js';

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const manifest = Object.freeze({
  id: env.addonId,
  version: '1.0.0',
  name: env.addonName,
  description: 'Personal SKTorrent stream addon with Czech/Slovak metadata matching and optional TorBox acceleration.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt']
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    addon: env.addonName,
    sktorrentConfigured: skTorrentConfigured(),
    torboxConfigured: Boolean(env.torboxKey),
    tmdbConfigured: Boolean(env.tmdbKey)
  });
});

app.get('/manifest.json', (_req, res) => res.json(manifest));

app.get('/stream/:type/:id.json', async (req, res) => {
  const type = req.params.type === 'series' ? 'series' : req.params.type === 'movie' ? 'movie' : null;
  if (!type) return res.status(400).json({ streams: [] });
  if (!skTorrentConfigured()) return res.status(503).json({ streams: [], error: 'SKTorrent credentials are not configured on the server.' });

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
});

app.get(['/', '/configure'], (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const manifestUrl = `${base}/manifest.json`;
  const stremioUrl = manifestUrl.replace(/^https?:\/\//, 'stremio://');
  const status = skTorrentConfigured() ? 'Configured' : 'Missing SKT_UID / SKT_PASS';
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(env.addonName)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;line-height:1.55;background:#111;color:#eee}
.card{border:1px solid #333;border-radius:14px;padding:22px;margin:18px 0;background:#181818}code{word-break:break-all;background:#252525;padding:2px 5px;border-radius:5px}a{color:#9ecbff}.ok{color:#7be39b}.bad{color:#ff9b9b}button{font:inherit;padding:10px 14px;border-radius:9px;border:0;cursor:pointer}</style></head>
<body><h1>${escapeHtml(env.addonName)}</h1><p>Single-user Stremio addon. Credentials are stored as deployment environment variables, not embedded in your Stremio manifest URL.</p>
<div class="card"><strong>SKTorrent:</strong> <span class="${skTorrentConfigured() ? 'ok' : 'bad'}">${status}</span><br>
<strong>TorBox:</strong> ${env.torboxKey ? 'Configured' : 'Optional / not configured'}<br>
<strong>TMDB:</strong> ${env.tmdbKey ? 'Configured' : 'Optional / not configured'}</div>
<div class="card"><p><strong>Manifest</strong><br><code>${escapeHtml(manifestUrl)}</code></p>
<p><a href="${escapeHtml(stremioUrl)}">Install in Stremio</a></p></div>
<p>Check <code>/health</code> after deployment. Do not expose your environment variables in screenshots or logs.</p></body></html>`);
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

// Keep serverless invocations predictable if a middleware/handler throws unexpectedly.
app.use((error, _req, res, _next) => {
  console.error('[http] unhandled error:', error);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
