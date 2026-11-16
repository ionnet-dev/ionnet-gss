import type { OkResponse } from "@shared/api/common.ts";
import type { CatalogSettingsDto, MailSettingsDto, TestCatalogBody, TestCatalogResponse, TestMailBody, UpdateCatalogSettingsBody, UpdateMailSettingsBody } from "@shared/api/settings.ts";
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

  export function getCatalogs(): Promise<CatalogSettingsDto> {
    return BaseApi.GET("/settings/catalogs");
  }

  /**
   * Save the CurseForge key (checked against CurseForge first; 400 with its answer when refused), or remove it.
   */
  export function updateCatalogs(body: UpdateCatalogSettingsBody): Promise<CatalogSettingsDto> {
    return BaseApi.PUT("/settings/catalogs", body);
  }

  /**
   * Try a key (the stored one when omitted) against CurseForge.
   */
  export function testCatalogs(body: TestCatalogBody): Promise<TestCatalogResponse> {
    return BaseApi.POST("/settings/catalogs/test", body);
  }

  /**
   * The mod catalog settings, refetched when any admin saves them (`settings.updated` with key "catalogs").
   */
  export function useCatalogs() {
    return useResource(getCatalogs, [], {
      liveEvents: ["settings.updated"],
      liveFilter: (_event, data) => (data as { key: string }).key === "catalogs",
    });
  }

  /**
   * The mail settings, refetched on `settings.updated`.
   */
  export function useMail() {
    return useResource(getMail, [], { liveEvents: ["settings.updated"] });
  }
}

export default SettingsApi;
