import { LoginForm } from "./login-form";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : undefined;

  return (
    <div className="flex flex-1 items-center justify-center bg-muted/30 px-4 py-16">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Sign in to ApplyOps</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Invite-only. Enter your email and we&apos;ll send you a one-time
          sign-in link.
        </p>
        <div className="mt-6">
          <LoginForm errorCode={error} />
        </div>
      </div>
    </div>
  );
}
