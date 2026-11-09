import { BrandMark } from "@/components/ui";
import { LoginForm } from "./LoginForm";

const PROMISES = [
  ["You set the rules", "A budget, a hard limit, what it may buy and what it never may."],
  ["Code enforces them", "Every purchase is checked by the policy engine before PayPal is called."],
  ["You stay in charge", "Anything over budget waits for your approval. One tap stops everything."],
] as const;

export default function LoginPage() {
  return (
    <main className="grid min-h-screen bg-canvas lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="relative hidden overflow-hidden bg-ink px-14 py-14 text-white lg:flex lg:flex-col">
        <div className="flex items-center gap-3">
          <BrandMark size={40} />
          <span className="font-display text-[21px] font-semibold tracking-[-0.02em]">Allowance</span>
        </div>
        <div className="my-auto max-w-[460px]">
          <h1 className="font-display text-[44px] font-semibold leading-[1.05] tracking-[-0.03em]">
            Your agent can be fooled. Your money can&apos;t.
          </h1>
          <ul className="mt-10 space-y-6">
            {PROMISES.map(([title, body]) => (
              <li key={title} className="flex gap-3.5">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#7fd3b0]" aria-hidden />
                <div>
                  <div className="text-[16px] font-semibold">{title}</div>
                  <p className="mt-0.5 text-[15px] leading-relaxed text-white/65">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-[13px] text-white/45">Spending permissions for AI agents, paid with PayPal.</p>
      </section>

      <section className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-[380px]">
          <div className="flex items-center gap-3 lg:hidden">
            <BrandMark />
            <span className="font-display text-[19px] font-semibold tracking-[-0.02em] text-ink">Allowance</span>
          </div>
          <h2 className="mt-8 font-display text-[28px] font-semibold tracking-[-0.02em] text-ink lg:mt-0">Sign in</h2>
          <p className="mt-1.5 text-[15px] leading-relaxed text-muted">This is a PayPal sandbox demo. Enter the passcode you were given.</p>
          <LoginForm />
        </div>
      </section>
    </main>
  );
}
