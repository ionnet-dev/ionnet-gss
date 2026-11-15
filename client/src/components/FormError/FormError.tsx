import type { ReactNode } from "react";

export interface FormErrorProps {
  children?: ReactNode;
}

/**
 * A form-level error line (the panel's message), announced to screen readers. Renders nothing when empty.
 */
export default function FormError(props: FormErrorProps) {
  const { children } = props;
  if (!children) return null;
  return <span role="alert" style={{ color: "var(--io-color-hue-text-bad)" }}>{children}</span>;
}
