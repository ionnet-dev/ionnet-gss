import { useToast } from "@ionnet/iontronic/react";

export interface Notify {
  /**
   * A success toast.
   */
  ok(title: string, description?: string): void;
  /**
   * An error toast carrying the panel's message.
   */
  error(error: unknown, title?: string): void;
}

/**
 * Toast helpers for mutations: `notify.ok("Host renamed")`, `notify.error(err, "Couldn't rename the host")`.
 */
export function useNotify(): Notify {
  const toast = useToast();
  return {
    ok: (title, description) => {
      toast.add({ title, description, tone: "ok" });
    },
    error: (error, title = "Something went wrong") => {
      toast.add({ title, description: error instanceof Error ? error.message : String(error), tone: "bad", timeout: 8000 });
    },
  };
}
