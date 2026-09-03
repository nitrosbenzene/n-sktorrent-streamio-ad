import { app } from './src/app.js';
import { env } from './src/env.js';

if (!process.env.VERCEL) {
  app.listen(env.port, () => {
    console.log(`[startup] ${env.addonName} listening on http://localhost:${env.port}`);
  });
}

export default app;
