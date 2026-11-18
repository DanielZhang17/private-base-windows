import { t } from "../../i18n/index.js";
import { nativeUnlockLabel, nativeUnlockUsesFingerprint, type BiometricUnlock } from "../../platform/biometric-unlock.js";
import { platformName } from "../../platform/environment.js";
import type { IconName } from "../../ui/icons/paths.js";

export function unlockMethodInfo(method: "passkey" | "native" | "password", native?: BiometricUnlock) {
  if (method === "native") native = platformName() === "windows" ? "windows-hello" : native ?? nativeUnlockLabel();
  const kind = method !== "native" ? method : native === "touchid" ? "touchId"
    : native === "faceid" ? "faceId" : native === "windows-hello" ? "windowsHello"
      : native === "android-biometric" && nativeUnlockUsesFingerprint() ? "fingerprint" : "biometrics";
  const icon: IconName = kind === "touchId" || kind === "fingerprint" || kind === "biometrics" ? "fingerprint"
    : kind === "faceId" || kind === "windowsHello" ? "face-scan" : method === "native" ? "fingerprint" : method;
  const name = t(`unlockMethods.${kind}`);
  const label = kind === "passkey" ? t("unlock.withPasskey") : kind === "fingerprint" ? t("unlock.withFingerprint")
    : kind === "biometrics" ? t("unlock.withBiometrics") : t("unlock.withMethod", { method: name });
  return { name, icon, label };
}
