interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnabled: () => void;
}

/**
 * Two steps: scan (`AuthApi.setupTotp` → `QrCode` of `otpauthUrl` + the secret as text) and confirm a code
 * (`confirmTotp`); then the recovery codes, shown once with copy and download (.txt). M5, parcel C.
 */
export default function TotpSetupDialog(props: Props) {
  // TODO(builder): M5 TOTP
  return null;
}
