import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button, Card, CardBody, CardHeader, Stack } from "@ionnet/iontronic/react";
import { LIMITS } from "@shared/constants.ts";
import type { EmailConfirmationRequired, TwoFactorChallenge } from "@shared/api/auth.ts";
import { AuthApi } from "@/Api/AuthApi.ts";
import FormError from "@/components/FormError/FormError.tsx";
import SecondFactorInput, { type SecondFactorAnswer } from "@/components/SecondFactorInput/SecondFactorInput.tsx";
import { useCountdown } from "@/components/SecondFactorInput/useCountdown.ts";
import { useAuth } from "@/hooks/useAuth.ts";

/**
 * The panel's challenge lives 5 minutes; a little less here, so the form goes back to the password before the panel
 * would refuse it.
 */
const CHALLENGE_TTL_MS = 4.5 * 60 * 1000;

export interface AuthStepProps {
  /**
   * What the panel answered after the password: the second-factor step or the "confirm your address" step.
   */
  response: TwoFactorChallenge | EmailConfirmationRequired;
  /**
   * The session is stored (second factor accepted); navigate on.
   */
  onDone: () => void;
  /**
   * Back to the page's first step (password, registration).
   */
  onBack: (message?: string) => void;
  /**
   * A line above the form, e.g. what just happened.
   */
  intro?: string;
}

/**
 * The step after a password was accepted, shared by sign-in, registration and password links.
 */
export default function AuthStep(props: AuthStepProps) {
  const { response, onDone, onBack, intro } = props;
  return response.step === "two_factor"
    ? <SecondFactorStep challenge={response} onDone={onDone} onBack={onBack} intro={intro} />
    : <ConfirmEmailStep challenge={response} onBack={onBack} intro={intro} />;
}

function SecondFactorStep(props: { challenge: TwoFactorChallenge; onDone: () => void; onBack: (message?: string) => void; intro?: string }) {
  const { challenge, onDone, onBack, intro } = props;
  const auth = useAuth();
  const [answer, setAnswer] = useState<SecondFactorAnswer>({ code: "", method: undefined });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const startedAt = useRef(Date.now());

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (Date.now() - startedAt.current > CHALLENGE_TTL_MS) {
      onBack("That took too long. Enter your password again.");
      return;
    }
    setBusy(true);
    try {
      await auth.completeTotp(challenge.challengeToken, answer.code, answer.method);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const emailOnly = !challenge.methods.includes("totp");
  const emailState = !challenge.methods.includes("email") ? "idle" : emailOnly ? (challenge.emailSent ? "sent" : "failed") : "idle";

  return (
    <Card>
      <CardHeader title="Sign in" description={intro ?? "One more step. Enter a code to finish signing in."} />
      <form onSubmit={submit}>
        <CardBody>
          <Stack gap="16">
            <SecondFactorInput
              methods={challenge.methods}
              emailHint={challenge.emailHint}
              emailState={emailState}
              sendEmailCode={async () => (await AuthApi.sendLoginEmailCode({ challengeToken: challenge.challengeToken })).emailHint}
              onChange={setAnswer}
            />
            <FormError>{error}</FormError>
            <Button type="submit" variant="primary" fullWidth loading={busy}>Verify</Button>
            <Button variant="ghost" size="sm" onClick={() => onBack()}>Back</Button>
          </Stack>
        </CardBody>
      </form>
    </Card>
  );
}

function ConfirmEmailStep(props: { challenge: EmailConfirmationRequired; onBack: (message?: string) => void; intro?: string }) {
  const { challenge, onBack, intro } = props;
  const [error, setError] = useState<string | null>(null);
  const [sentAgain, setSentAgain] = useState(false);
  const [busy, setBusy] = useState(false);
  const countdown = useCountdown();

  useEffect(() => countdown.start(LIMITS.EMAIL_RESEND_SECONDS), [countdown.start]);

  const resend = async () => {
    setError(null);
    setBusy(true);
    try {
      await AuthApi.resendLoginConfirmation({ challengeToken: challenge.challengeToken });
      setSentAgain(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      countdown.start(LIMITS.EMAIL_RESEND_SECONDS);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Confirm your email address"
        description={`${intro ? `${intro} ` : ""}This panel needs a confirmed address to sign in. We sent a link to ${challenge.emailHint}. Open it, then sign in again.`}
      />
      <CardBody>
        <Stack gap="16">
          {sentAgain && !error && <span className="io-text-muted">We sent the link again. It works for {LIMITS.EMAIL_CONFIRM_TTL_HOURS} hours.</span>}
          <FormError>{error}</FormError>
          <Button fullWidth loading={busy} disabled={countdown.left > 0} onClick={resend}>
            {countdown.left > 0 ? `Send the link again in ${countdown.left}s` : "Send the link again"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onBack()}>Back to sign in</Button>
        </Stack>
      </CardBody>
    </Card>
  );
}
