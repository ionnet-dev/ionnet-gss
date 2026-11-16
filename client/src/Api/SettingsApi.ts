import type { OkResponse } from "@shared/api/common.ts";
import type { MailSettingsDto, TestMailBody, UpdateMailSettingsBody } from "@shared/api/settings.ts";
import { useResource } from "@/hooks/useResource.ts";
import { BaseApi } from "./BaseApi.ts";

/**
 * `/api/settings` (M7, administrators only).
 */
export namespace SettingsApi {
  export function getMail(): Promise<MailSettingsDto> {
    return BaseApi.GET("/settings/mail");
  }

  export function updateMail(body: UpdateMailSettingsBody): Promise<MailSettingsDto> {
    return BaseApi.PUT("/settings/mail", body);
  }

  /**
   * Send a test email, with `settings` (unsaved form values) over the stored ones. Throws the SMTP server's answer.
   */
  export function testMail(body: TestMailBody): Promise<OkResponse> {
    return BaseApi.POST("/settings/mail/test", body);
  }

  /**
   * The mail settings, refetched on `settings.updated`.
   */
  export function useMail() {
    return useResource(getMail, [], { liveEvents: ["settings.updated"] });
  }
}

export default SettingsApi;
