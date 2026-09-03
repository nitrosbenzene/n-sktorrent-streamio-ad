import app from '../src/app.js';

export default function handler(req, res) {
  const path = String(req.url || '').split('?', 1)[0];
  if (req.method === 'HEAD' && /\/torbox\/start\/[a-f0-9]{40,64}\/video\.mp4$/i.test(path)) {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.setHeader('Cache-Control', 'no-store');
    return res.end();
  }
  return app(req, res);
}
