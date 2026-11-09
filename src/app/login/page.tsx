import { LoginForm } from "./LoginForm";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-7 shadow-sm">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-900 font-bold text-white">A</div>
        <h1 className="mt-4 text-xl font-semibold text-zinc-900">Allowance</h1>
        <p className="mt-1 text-sm text-zinc-500">Spending permissions for AI agents. Sandbox demo; enter the passcode.</p>
        <LoginForm />
      </div>
    </main>
  );
}
