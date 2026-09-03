import http from 'node:http';
import handler from './src/handler.js';
import { env } from './src/env.js';

if (!process.env.VERCEL) {
  http.createServer(handler).listen(env.port, () => {
    console.log(`[startup] ${env.addonName} listening on http://localhost:${env.port}`);
  });
}

export default handler;
