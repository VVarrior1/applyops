import { cookies } from "next/headers";
import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase client for Server Components, Route Handlers, and Server
 * Actions — cookie-based session per `@supabase/ssr`'s Next.js App Router
 * pattern. Create a fresh client per request (never module-level/shared).
 *
 * `next/headers`'s `cookies()` allows writes (`.set()`) from Route Handlers
 * and Server Actions but throws from Server Components (they've already
 * started streaming a response by the time a component body runs). The
 * `setAll` below swallows that specific case: session refreshes issued
 * from a Server Component are simply not persisted there, which is fine
 * because `middleware.ts` runs first on every request and refreshes +
 * re-persists the session on its own response before any Server Component
 * or Route Handler in this file ever executes.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set",
    );
  }

  const cookieMethods: CookieMethodsServer = {
    getAll() {
      return cookieStore.getAll();
    },
    setAll(cookiesToSet) {
      try {
        cookiesToSet.forEach(({ name, value, options }) => {
          cookieStore.set(name, value, options);
        });
      } catch {
        // Called from a Server Component (read-only cookies) — see the
        // doc comment above for why this is safe to ignore.
      }
    },
  };

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: cookieMethods,
  });
}
