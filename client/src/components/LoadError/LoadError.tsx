import { Button, EmptyState } from "@ionnet/iontronic/react";
import { TriangleAlert } from "@ionnet/iontronic/icons";

export interface LoadErrorProps {
  title: string;
  error: Error;
  onRetry: () => void;
}

/**
 * Shown in place of a list or page that failed to load, with the panel's message and a retry button.
 */
export default function LoadError(props: LoadErrorProps) {
  const { title, error, onRetry } = props;
  return (
    <EmptyState
      icon={TriangleAlert}
      tone="bad"
      title={title}
      description={error.message}
      actions={<Button onClick={onRetry}>Try again</Button>}
    />
  );
}
