import { initializeApp } from 'firebase/app'
import { getAuth, signInAnonymously } from 'firebase/auth'
import { doc, getFirestore, onSnapshot } from 'firebase/firestore'
import type { Card } from './engine/cards.ts'
import type { PublicTable } from './engine/table.ts'

const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}
export const configured = !!cfg.apiKey && !!cfg.projectId

// `?guest=2` gives a tab its own anonymous identity, handy for testing with several players on one machine.
const guest = new URLSearchParams(location.search).get('guest')
const app = configured ? initializeApp(cfg, guest ? `guest${guest}` : undefined) : null
const auth = app ? getAuth(app) : null
const db = app ? getFirestore(app) : null

let signIn: Promise<string> | null = null
export function ensureUser(): Promise<string> {
  if (!auth) return Promise.reject(new Error('Firebase is not configured'))
  signIn ??= auth.authStateReady().then(async () => (auth.currentUser ?? (await signInAnonymously(auth)).user).uid).catch((e) => { signIn = null; throw e })
  return signIn
}

export interface ApiResult {
  ok: boolean
  error?: string
  code?: string
}

export async function api(type: string, payload: Record<string, unknown> = {}): Promise<ApiResult> {
  try {
    await ensureUser()
    const token = await auth!.currentUser!.getIdToken()
    const res = await fetch('/api/table', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type, ...payload }),
    })
    return (await res.json()) as ApiResult
  } catch {
    return { ok: false, error: 'Network problem, retrying…' }
  }
}

export interface Live {
  status: 'loading' | 'ready' | 'missing' | 'error'
  pub: PublicTable | null
  hole: { handId: number; cards: Card[] } | null
  /** serverNow - clientNow, in ms. */
  offset: number
  fromCache: boolean
}

/** Subscribe to the public table doc and (once known) this player's private hole-card doc. Re-subscribes after errors. */
export function subscribeTable(code: string, uid: string, cb: (l: Partial<Live>) => void): () => void {
  if (!db) return () => {}
  let stopped = false
  let unsubs: (() => void)[] = []
  let retry: ReturnType<typeof setTimeout> | undefined
  const start = () => {
    unsubs.forEach((u) => u())
    unsubs = [
      onSnapshot(
        doc(db, 'tables', code),
        (snap) => {
          if (!snap.exists()) return cb({ status: 'missing', pub: null })
          const pub = snap.data() as unknown as PublicTable
          const patch: Partial<Live> = { status: 'ready', pub, fromCache: snap.metadata.fromCache }
          if (!snap.metadata.fromCache) patch.offset = pub.now - Date.now()
          cb(patch)
        },
        () => {
          cb({ status: 'error' })
          if (!stopped) retry = setTimeout(start, 3000)
        },
      ),
      onSnapshot(
        doc(db, 'tables', code, 'hands', uid),
        (snap) => cb({ hole: snap.exists() ? (snap.data() as { handId: number; cards: Card[] }) : null }),
        () => {},
      ),
    ]
  }
  start()
  return () => { stopped = true; clearTimeout(retry); unsubs.forEach((u) => u()) }
}
