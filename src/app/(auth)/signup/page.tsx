import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/db/auth";
import { AuthForm } from "../AuthForm";

export const dynamic = "force-dynamic";

export default async function SignupPage() {
  if (await getCurrentUser()) redirect("/dashboard");

  return (
    <>
      <h1 className="text-lg font-semibold text-ink-900">Create your account</h1>
      <p className="mb-5 mt-1 text-sm text-ink-500">
        Free to set up. Upload a report and get your first analysis in under a minute.
      </p>
      <AuthForm mode="signup" />
    </>
  );
}
