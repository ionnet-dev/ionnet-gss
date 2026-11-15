import { Hono } from "hono";
import type { AppEnv } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { AuthController } from "./AuthController.ts";
import { DefinitionController } from "./DefinitionController.ts";
import { ServerController } from "./ServerController.ts";
import { EnrolTokenController } from "./EnrolTokenController.ts";
import { HostController } from "./HostController.ts";
import { InviteController } from "./InviteController.ts";
import { MetaController } from "./MetaController.ts";
import { RoleController } from "./RoleController.ts";
import { UserController } from "./UserController.ts";

/**
 * Mounts every resource under `/api`. The route table: main-session only. A new resource adds one line here.
 */
export namespace ApiController {
  export const router = new Hono<AppEnv>();

  router.route("/", MetaController.router); // /health, /meta
  router.route("/auth", AuthController.router);
  router.route("/users", UserController.router);
  router.route("/roles", RoleController.router);
  router.route("/invites", InviteController.router);
  router.route("/hosts", HostController.router);
  router.route("/enrol-tokens", EnrolTokenController.router);
  router.route("/servers", ServerController.router);
  router.route("/definitions", DefinitionController.router);
  // M3: router.route("/sources", SourceController.router);
  // M4: router.route("/servers/:id/files", FileController.router); /backups → BackupController

  router.all("*", (c) => {
    throw HttpError.notFound(`No API route for ${c.req.method} ${c.req.path}.`);
  });
}

export default ApiController;
