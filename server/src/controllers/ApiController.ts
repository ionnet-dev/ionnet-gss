import { Hono } from "hono";
import type { AppEnv } from "../lib/http.ts";
import { HttpError } from "../lib/HttpError.ts";
import { AgentController } from "./AgentController.ts";
import { AuthController } from "./AuthController.ts";
import { BackupController } from "./BackupController.ts";
import { DownloadController } from "./DownloadController.ts";
import { FileController } from "./FileController.ts";
import { MetricsController } from "./MetricsController.ts";
import { QuotaController } from "./QuotaController.ts";
import { ShareController } from "./ShareController.ts";
import { TotpController } from "./TotpController.ts";
import { DefinitionController } from "./DefinitionController.ts";
import { SourceController } from "./SourceController.ts";
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
  router.route("/auth/totp", TotpController.router); // M5
  router.route("/users", UserController.router);
  router.route("/users/:id/totp", TotpController.adminRouter); // M5
  router.route("/quota", QuotaController.router); // M5: own quota
  router.route("/roles", RoleController.router);
  router.route("/invites", InviteController.router);
  router.route("/hosts", HostController.router);
  router.route("/enrol-tokens", EnrolTokenController.router);
  router.route("/servers", ServerController.router);
  router.route("/servers/:id/files", FileController.router); // M4
  router.route("/servers/:id/backups", BackupController.router); // M4
  router.route("/servers/:id/metrics", MetricsController.router); // M4
  router.route("/servers/:id/shares", ShareController.router); // M5
  router.route("/downloads", DownloadController.router); // M4: public, the ticket is the auth
  router.route("/definitions", DefinitionController.router);
  router.route("/sources", SourceController.router);
  router.route("/agent", AgentController.router); // M5: public install script and agent downloads

  router.all("*", (c) => {
    throw HttpError.notFound(`No API route for ${c.req.method} ${c.req.path}.`);
  });
}

export default ApiController;
