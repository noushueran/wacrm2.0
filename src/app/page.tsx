import { redirect } from 'next/navigation'

/**
 * Fallback only. `src/middleware.ts` matches "/" and redirects it to
 * /dashboard or /login depending on the session, so this normally never
 * renders. Deciding there rather than here is the point: the middleware
 * already knows whether the caller is signed in, whereas this page did
 * not — it sent everyone to /dashboard, so a signed-out visitor was
 * bounced / -> /dashboard -> /login, paying a full round trip per hop.
 *
 * Kept so "/" still resolves if the matcher ever stops covering it.
 * /dashboard is the right fallback because the middleware turns
 * signed-out callers away before they reach this.
 */
export default function RootPage() {
  redirect('/dashboard')
}
