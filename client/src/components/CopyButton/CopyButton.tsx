import { useEffect, useRef, useState } from "react";
import { Button } from "@ionnet/iontronic/react";
import { Check, Copy } from "@ionnet/iontronic/icons";
import { useNotify } from "@/components/Notify/useNotify.ts";

export interface CopyButtonProps {
  text: string;
  /**
   * Accessible name, e.g. "Copy address".
   */
  label: string;
}

const COPIED_RESET_MS = 1600;

/**
 * Icon button that copies `text` to the clipboard and shows a check for a moment.
 */
export default function CopyButton(props: CopyButtonProps) {
  const { text, label } = props;
  const notify = useNotify();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      notify.error(error, "Couldn't copy to the clipboard");
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  return <Button size="sm" variant="ghost" iconOnly icon={copied ? Check : Copy} aria-label={copied ? "Copied" : label} onClick={copy} />;
}
