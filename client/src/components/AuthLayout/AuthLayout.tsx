import type { ReactNode } from "react";
import { Icon, Stack } from "@ionnet/iontronic/react";
import { Gamepad2 } from "@ionnet/iontronic/icons";
import { APP_NAME } from "@shared/constants.ts";
import "./AuthLayout.scss";

export interface AuthLayoutProps {
  children: ReactNode;
}

/**
 * Signed-out pages (setup, login, register, not found): the product mark above one centered card.
 */
export default function AuthLayout(props: AuthLayoutProps) {
  const { children } = props;
  return (
    <main className="auth-layout">
      <Stack gap="24" align="center" className="auth-layout__column">
        <Stack direction="row" gap="12" align="center">
          <Icon icon={Gamepad2} size="lg" />
          <span className="io-display" data-size="sm">{APP_NAME}</span>
        </Stack>
        {children}
      </Stack>
    </main>
  );
}
