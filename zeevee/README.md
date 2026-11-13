# Qlio editor

React + Vite frontend for Qlio. See the [root README](../README.md) for how the whole system fits together.

```bash
npm install
npm run dev      # Vite dev server; set VITE_API_URL in .env.local
npm test         # tsx test scripts
npm run lint
npm run build    # tsc -b + vite build
```

- `src/pages/`: Dashboard, Editor, Export, SignIn
- `src/store/`: Redux Toolkit; `syncMiddleware.ts` autosaves editor state every 10 s
- `src/remotion/`: caption and framing compositions shared by the preview and the server-side render. After changing them, the Remotion site must be republished (`deploy-remotion-site.sh`, run by CI on push to `main`).
- `@` resolves to `./src`.

Hosted on Vercel (`vercel.json` holds the SPA rewrite).
