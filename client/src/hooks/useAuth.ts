import { authController, type AuthController } from "@/controllers/AuthController.ts";
import { useController } from "./useController.ts";

/**
 * The auth controller, re-rendering on sign-in, sign-out and user changes.
 */
export function useAuth(): AuthController {
  return useController(authController);
}
