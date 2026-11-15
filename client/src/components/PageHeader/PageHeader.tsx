import type { ReactNode } from "react";
import { Stack } from "@ionnet/iontronic/react";

export interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  /**
   * Buttons on the right (below the title on phones).
   */
  actions?: ReactNode;
  /**
   * Shown above the title, e.g. a back link.
   */
  leading?: ReactNode;
}

/**
 * The title row of every signed-in page.
 */
export default function PageHeader(props: PageHeaderProps) {
  const { title, description, actions, leading } = props;
  return (
    <Stack gap="8">
      {leading && <div>{leading}</div>}
      <Stack direction="row" align="end" justify="between" gap="12" wrap>
        <div>
          <h1 className="io-display" data-size="lg" style={{ margin: 0 }}>{title}</h1>
          {description && <div className="io-text-muted" style={{ margin: "var(--io-space-4) 0 0" }}>{description}</div>}
        </div>
        {actions && <Stack direction="row" gap="8" wrap>{actions}</Stack>}
      </Stack>
    </Stack>
  );
}
