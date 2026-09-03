# SK Stream Bridge

A clean-room, single-user Stremio stream addon for searching SKTorrent and exposing matching torrent streams to Stremio, with optional TorBox direct-link acceleration. Version 2 introduces a completely independent visual identity and Slovak-first setup experience while retaining the full movie, series, metadata, encrypted profile, and TorBox workflow.

## Design goals

- Server-side credentials: SKTorrent and TorBox secrets never need to be embedded in the manifest URL.
- Small modules instead of a single large script.
- Bounded concurrency and TTL caching to reduce repeated scraping and torrent downloads.
- Native `fetch` / `AbortSignal.timeout()` rather than custom keep-alive agents.
- More defensive title, year, quality and episode matching.
- Optional TMDB Czech/Slovak/English aliases plus Cinemeta metadata.
- TorBox cache checks are batched; direct links are generated only for cached results and only for a bounded number of streams.

## Requirements

- Node.js 20+
- An SKTorrent account
- Optional: TorBox API key
- Optional: TMDB API key

## Local setup

```bash
cp .env.example .env
# Fill values in .env, then export them in your shell or use your preferred env loader.
npm install
npm start
```

This project intentionally does not depend on `dotenv`; production platforms already inject environment variables. For local development you can either export the values manually, use `node --env-file=.env server.js`, or change the start script to use `--env-file`.

Example:

```bash
node --env-file=.env server.js
```

Open `http://localhost:7000/`, then install `http://localhost:7000/manifest.json` in Stremio while testing on the same machine.

## Environment variables

Required:

- `SKT_UID` — value of the authenticated SKTorrent `uid` cookie.
- `SKT_PASS` — value of the authenticated SKTorrent `pass` cookie.

Optional:

- `TORBOX_API_KEY` — enables cache checks and (by default) direct links for cached torrents.
- `TMDB_API_KEY` — adds Czech, Slovak and English title aliases when resolving IMDb IDs.
- `TORBOX_DIRECT_LINKS=false` — disable TorBox direct-link generation while retaining cache labels.
- Search and concurrency settings are documented in `.env.example`.

## Vercel

1. Push this folder to a GitHub repository named `n-sktorrent-streamio-ad`.
2. Import it as a Vercel project.
3. Add `SKT_UID`, `SKT_PASS`, and optional API keys in Vercel Project Settings → Environment Variables.
4. Deploy.
5. Open `https://YOUR-PROJECT.vercel.app/health` and verify the configuration flags.
6. Open the project root and use the Stremio install link, or manually add `https://YOUR-PROJECT.vercel.app/manifest.json`.

The root `server.js` exports the Express app for serverless runtimes and starts a normal listener only outside Vercel.

## Important operational notes

- The addon does not persist your SKTorrent cookies; it reads them from deployment environment variables.
- If SKTorrent changes its HTML or endpoint parameters, `src/services/sktorrent.js` is the only scraper module that should normally require changes.
- TorBox download URLs are temporary, so they are created when Stremio requests streams rather than cached for long periods.
- For a private home deployment, consider protecting the configuration/root page at the platform level even though it no longer reveals the actual credentials.
- Use the addon only for content you are authorized to access and in accordance with the relevant services' terms and local law.

## Tests

```bash
npm test
npm run check
```
