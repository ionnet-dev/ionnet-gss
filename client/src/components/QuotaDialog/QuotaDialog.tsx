import type { UserDto } from "@shared/api/users.ts";

interface Props {
  user: UserDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Users page: edit one user's quota overrides (`UserApi.useQuota` / `setQuota`). Each field: a number, or empty =
 * panel default (shown as the placeholder); `QuotaUsage compact` above the form. M5, parcel A.
 */
export default function QuotaDialog(props: Props) {
  // TODO(builder): M5 quota
  return null;
}
