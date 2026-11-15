import { useSyncExternalStore } from "react";
import type { Controller } from "@/controllers/Controller.ts";

/**
 * Re-render the calling component whenever `controller.notify()` runs. Returns the controller for convenience.
 */
export function useController<T extends Controller>(controller: T): T {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  return controller;
}
