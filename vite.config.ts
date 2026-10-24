import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

/** Serves /api/table in `npm run dev` using the same handler as the Vercel function. */
function devApi(env: Record<string, string>): Plugin {
  return {
    name: 'dev-api',
    configureServer(server) {
      Object.assign(process.env, env)
      server.middlewares.use('/api/table', async (req, res) => {
        try {
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
          const fs = (await server.ssrLoadModule('/server/firestore.ts')) as typeof import('./server/firestore.ts')
          const h = (await server.ssrLoadModule('/server/handler.ts')) as typeof import('./server/handler.ts')
          const uid = await fs.verifyToken(req.headers.authorization)
          res.setHeader('Content-Type', 'application/json')
          if (!uid) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'Not signed in' })); return }
          const out = await h.handle(uid, body, { store: fs.firestoreStore, now: () => Date.now() })
          res.end(JSON.stringify(out))
        } catch (e) {
          console.error(e)
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, error: 'Server error' }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return { plugins: [react(), tailwindcss(), devApi(env)] }
})
