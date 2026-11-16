import { useEffect, useRef, useState } from "react";
import { Button, Input, Stack } from "@ionnet/iontronic/react";
import { LIMITS } from "@shared/constants.ts";
import type { SecondFactorMethod } from "@shared/api/auth.ts";
import { ApiError } from "@/Api/BaseApi.ts";
import FormError from "@/components/FormError/FormError.tsx";
import { useCountdown } from "./useCountdown.ts";

/**
 * What the user typed, and where it came from: `method` is `email` for an emailed code, `totp` for an authenticator
 * code and undefined for a recovery code.
 */
export interface SecondFactorAnswer {
  code: string;
  method: SecondFactorMethod | undefined;
}

/**
 * `sent`: a code is on its way (the panel sent it). `failed`: the panel tried and couldn't. `idle`: nothing sent yet,
 * the user asks for one.
 */
export type EmailCodeState = "sent" | "failed" | "idle";

export interface SecondFactorInputProps {
  /**
   * The methods that are on (`totp` first); a recovery code is always offered on top.
   */
  methods: SecondFactorMethod[];
  /**
   * The address codes go to, masked or in full.
   */
  emailHint: string | null;
  /**
   * Where the email code stands when the field first shows.
   */
  emailState: EmailCodeState;
  /**
   * Ask the panel to email a code; throws its message. Answers the address it used.
   */
  sendEmailCode: () => Promise<string | null>;
  onChange: (answer: SecondFactorAnswer) => void;
}

type Mode = SecondFactorMethod | "recovery";

/**
 * The code field of a second factor (sign-in and the proof dialogs): the authenticator code, an emailed code ("Email
 * me a code instead", "Send again" with a `LIMITS.EMAIL_RESEND_SECONDS` countdown) or a recovery code, switching
 * between them as `methods` allows. Reports every keystroke through `onChange`.
 */
export default function SecondFactorInput(props: SecondFactorInputProps) {
  const { methods, emailState, sendEmailCode, onChange } = props;
  const hasTotp = methods.includes("totp");
  const hasEmail = methods.includes("email");
  const firstMode: Mode = hasTotp ? "totp" : "email";
  const [mode, setMode] = useState<Mode>(firstMode);
  const [code, setCode] = useState("");
  const [hint, setHint] = useState(props.emailHint);
  const [state, setState] = useState<EmailCodeState>(emailState);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const countdown = useCountdown();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (emailState === "sent") countdown.start(LIMITS.EMAIL_RESEND_SECONDS);
  }, [emailState, countdown]);

  useEffect(() => {
    onChange({ code: code.trim(), method: mode === "recovery" ? undefined : mode });
  }, [code, mode]);

  const send = async () => {
    setSending(true);
    setSendError(null);
    try {
      const address = await sendEmailCode();
      if (address) setHint(address);
      setState("sent");
      countdown.start(LIMITS.EMAIL_RESEND_SECONDS);
    } catch (error) {
      const tooSoon = error instanceof ApiError && error.status === 429;
      // Too soon means a code is already on its way; any other failure leaves "Send again" to try once more.
      if (tooSoon) {
        setState("sent");
        countdown.start(LIMITS.EMAIL_RESEND_SECONDS);
      }
      else setState("failed");
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const switchTo = (next: Mode) => {
    setMode(next);
    setCode("");
    setSendError(null);
  };

  const emailInstead = () => {
    switchTo("email");
    if (state !== "sent") void send();
  };

  const target = hint ? ` to ${hint}` : "";
  const description = mode === "recovery"
    ? "Enter one of the recovery codes you saved. Each works once."
    : mode === "totp"
    ? "Enter the code from your authenticator app."
    : state === "sent"
    ? `We sent a code${target}. It works for ${LIMITS.EMAIL_CODE_TTL_MINUTES} minutes.`
    : state === "failed"
    ? "Send the code again, or use a recovery code."
    : `We'll send a code${target}.`;

  const sendLabel = state === "idle" ? "Send code" : "Send again";
  const recovery = mode === "recovery";

  return (
    <Stack gap="12">
      <Input
        key={mode}
        label={recovery ? "Recovery code" : mode === "email" ? "Email code" : "Code"}
        description={description}
        placeholder={recovery ? "xxxxx-xxxxx" : "123456"}
        required
        autoFocus
        inputMode={recovery ? "text" : "numeric"}
        autoComplete={recovery ? "off" : "one-time-code"}
        autoCapitalize="none"
        spellCheck={false}
        maxLength={recovery ? 16 : 7}
        mono
        value={code}
        onChange={(event) => setCode(event.target.value)}
      />
      {mode === "email" && (state === "failed" || sendError) && (
        <FormError>{sendError ?? `We couldn't send a code${target}. Check that the panel can send email, then send it again.`}</FormError>
      )}
      <Stack direction="row" gap="8" wrap>
        {mode === "email" && (
          <Button size="sm" onClick={send} loading={sending} disabled={countdown.left > 0}>
            {countdown.left > 0 ? `${sendLabel} in ${countdown.left}s` : sendLabel}
          </Button>
        )}
        {mode === "totp" && hasEmail && <Button variant="ghost" size="sm" onClick={emailInstead}>Email me a code instead</Button>}
        {mode === "email" && hasTotp && <Button variant="ghost" size="sm" onClick={() => switchTo("totp")}>Use the app code</Button>}
        {recovery
          ? <Button variant="ghost" size="sm" onClick={() => switchTo(firstMode)}>{hasTotp ? "Use the app code" : "Use the email code"}</Button>
          : <Button variant="ghost" size="sm" onClick={() => switchTo("recovery")}>Use a recovery code</Button>}
      </Stack>
    </Stack>
  );
}
