import { t } from "../../i18n/index.js";
import type { BiometricUnlock } from "../../platform/biometric-unlock.js";
import type { IconName } from "../../ui/icons/paths.js";

export function unlockMethodInfo(method: "passkey" | "native" | "password", native?: BiometricUnlock) {
  const kind = method !== "native" ? method : native === "touchid" ? "touchId"
    : native === "faceid" ? "faceId" : native === "windows-hello" ? "windowsHello"
      : native === "android-biometric" && typeof window !== "undefined" &&
        window.__PRIVATEBASE_NATIVE_CAPABILITIES__?.androidBiometricKind === "fingerprint" ? "fingerprint" : "biometrics";
  const icon: IconName = kind === "touchId" || kind === "fingerprint" || kind === "biometrics" ? "fingerprint"
    : kind === "faceId" || kind === "windowsHello" ? "face-scan" : method === "native" ? "fingerprint" : method;
  const name = t(`unlockMethods.${kind}`);
  const label = kind === "passkey" ? t("unlock.withPasskey") : kind === "fingerprint" ? t("unlock.withFingerprint")
    : kind === "biometrics" ? t("unlock.withBiometrics") : t("unlock.withMethod", { method: name });
  return { name, icon, label };
}
