import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/db/auth";
import { AuthForm } from "../AuthForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/dashboard");

  return (
    <>
      <h1 className="text-lg font-semibold text-ink-900">Sign in</h1>
      <p className="mb-5 mt-1 text-sm text-ink-500">Welcome back.</p>
      <AuthForm mode="login" />
    </>
  );
}
