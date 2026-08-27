import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Exact-or-prefix public pages — everything else under `app/(app)/**`
 * (a route group, so it has no URL segment of its own: this list is what
 * actually decides "public" vs "protected" for page routes) requires a
 * session. Kept in sync with spec §9's route list and Task 3's brief.
 */
const PUBLIC_PAGE_PATHS = ["/", "/login", "/auth/callback", "/results", "/benchmark"];

function isPublicPagePath(pathname: string): boolean {
  return PUBLIC_PAGE_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p === "/" ? "\0never-matches" : `${p}/`),
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Let the response object accumulate any Set-Cookie writes from a token
  // refresh (see setAll below) — it, not a fresh NextResponse, must be what
  // every branch below ultimately returns.
  let response = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set",
    );
  }

  const cookieMethods: CookieMethodsServer = {
    getAll() {
      return request.cookies.getAll();
    },
    setAll(cookiesToSet) {
      // Mirror onto the incoming request too, so the getAll() above (and
      // anything downstream reading request.cookies this same request)
      // sees the refreshed values, not just the outgoing response.
      cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
      response = NextResponse.next({ request });
      cookiesToSet.forEach(({ name, value, options }) => {
        response.cookies.set(name, value, options);
      });
    },
  };

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: cookieMethods,
  });

  // getUser() (not getSession()) validates the token against Supabase Auth
  // rather than trusting the local cookie — the right call to make in
  // middleware, per @supabase/ssr's Next.js guidance, since this is the one
  // place that decides access for every request.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isApiRoute = pathname.startsWith("/api/");
  const isPublicApiRoute = pathname.startsWith("/api/public/");
  const isProtected = isApiRoute ? !isPublicApiRoute : !isPublicPagePath(pathname);

  if (isProtected && !user) {
    if (isApiRoute) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl, 302);
  }

  return response;
}

export const config = {
  matcher: [
    // Skip Next.js internals and common static-file extensions; run on
    // everything else, including all page and API routes.
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
