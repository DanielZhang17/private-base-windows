import { type TranslationKey } from "../../i18n/index.js";
import en from "../../i18n/locales/en.json";
import { LocalizedError, renderMessage, type LocalizedMessage } from "../../i18n/messages.js";

const codes: Record<string, TranslationKey> = {
  GROUP_LAST_ADMIN: "groupLastAdmin",
  GROUP_MEMBER_PENDING: "groupMemberPending",
  GROUP_TIMEOUT_TARGET: "groupTimeoutTarget",
  GROUP_TIMED_OUT: "groupTimedOut",
  FILE_EXPIRED: "fileExpired",
  E2EE_CALL_UNSUPPORTED: "endToEndEncryptedCallsAreUnavailableOn",
  SAVE_UNSUPPORTED: "savingFilesIsUnavailableOnThisDeviceImages",
  PASSKEY_UNSUPPORTED: "errorPasskeysAreUnavailableInThisAppUseASupported",
  GROUP_NAME_TAKEN: "groupNameTaken",
  GROUP_JOIN_UNAVAILABLE: "groupJoinUnavailable",
  GROUP_ADMISSION_UPGRADE_REQUIRED: "groupJoinUpgradeRequired",
};

// Only exact English diagnostics emitted by the server/lib belong here.
// Presentation templates and previously translated UI text must never be matched.
const rawErrorKeys: TranslationKey[] = [
  "errorMissingToken",
  "errorInvalidToken",
  "errorRateLimitExceeded",
  "errorMissingAuthorization",
  "errorDeviceNotFound",
  "errorUnsupportedAvatarType",
  "errorAvatarTooLarge",
  "errorNotFound",
  "errorNotFoundInStorage",
  "errorInvalidPassword",
  "errorNoFieldsToUpdate",
  "errorOneOrMoreUsersAreUnavailable",
  "errorNotAMember",
  "errorNotAuthorized",
  "errorInvalidDevicePossessionSignature",
  "errorInternalServerError",
  "errorLinkRequestAlreadyCompleted",
  "errorUnknownDevice",
  "errorConversationNotFound",
  "errorCallsAreOnlySupportedForDirectConversations",
  "errorTurnIsNotConfigured",
  "errorInitiatorCannotAcceptTheirOwnCall",
  "errorCallIsNoLongerRinging",
  "errorCallNotFound",
  "errorCannotRemoveTheCurrentActiveDevice",
  "errorRequestFailed",
  "errorFileNotFound",
  "errorRecipientDeviceNotInConversation",
  "errorMessageIdAlreadyBelongsToADifferentEnvelope",
  "errorBatchTargetedSendsAreOnlySupportedForDirectConversations",
  "errorTargetedBatchMessagesMustIncludeRecipientdeviceidInTheHeader",
  "errorTargetedBatchMessagesCannotTargetTheActiveSendingDevice",
  "errorDuplicateRecipientDeviceInDirectBatchPayload",
  "errorTooManyLoginAttemptsTryAgainLater",
  "errorInvalidCredentials",
  "errorInvalidDeviceKeyBundle",
  "errorRecoveryKeyEnrollmentIsRequiredBeforeLinkingANew",
  "errorNoActiveDeviceCanApproveThisRequestUseYour",
  "errorLinkRequestNotFound",
  "errorLinkRequestExpired",
  "errorLinkRequestIsNotApproved",
  "errorDeviceAlreadyLinked",
  "errorRecoveryKeyIsNotEnrolledForThisAccount",
  "errorInvalidRecoveryKey",
  "errorRecoveryKeyAlreadyEnrolled",
  "errorRecoveryBasedRequestsCannotBePeerApproved",
  "errorLinkRequestIsNotPending",
  "errorApproverDeviceNotFound",
  "errorInvalidApprovalSignature",
  "errorLinkRequestCanNoLongerBeRejected",
  "errorShortcodeAlreadyExists",
  "errorCustomEmojiLimitReached",
  "errorEmojiNotFound",
  "errorInvalidEmojiUploadSize",
  "errorEmojiFileNotFound",
  "errorBundleNotFound",
  "errorOneTimePreKeyIdsWereAlreadyUsedWith",
  "errorInvalidChallenge",
  "errorPasskeyAlreadyRegistered",
  "errorPasskeyNotFound",
  "errorNoPasskeysRegistered",
  "errorTooManyAttemptsTryAgainLater",
  "errorFileTooLarge",
  "errorFileSizeMismatch",
  "errorFileIsNotAttachedToAMessageYet",
  "errorFileNotFoundInStorage",
  "errorInvalidRefreshToken",
  "errorNetworkError",
  "errorFailedToFetch",
  "errorSessionExpired",
  "errorSessionChanged",
  "errorSessionIdentityIsStillLoading",
  "errorNoRecipientDevicesAvailable",
  "errorFailedToDeliverToRecipientDevices",
  "errorCurrentDeviceIsUnavailable",
  "errorNoKeysFoundRegisterFirst",
  "errorIdentityKeyNotFound",
  "errorKeysWereLockedDuringReload",
  "errorKeysWereLockedDuringMaintenance",
  "errorPasskeyCreationCancelled",
  "errorPasskeyAuthenticationCancelled",
  "errorPasskeysAreUnavailableInThisAppUseASupported",
  "usernameTaken",
];
const rawErrors = new Map<string, TranslationKey>(rawErrorKeys.map((key) => [en[key], key]));
rawErrors.set("One or more users are unavailable", "personCannotBeAdded");

export function toErrorMessage(error: unknown, fallback: TranslationKey = "genericError"): LocalizedMessage {
  if (error instanceof LocalizedError) return error.localizedMessage;
  const failure = error as { code?: string; message?: string } | null;
  if (failure?.code && codes[failure.code]) return { key: codes[failure.code] };
  const diagnostic = typeof error === "string" ? error : failure?.message;
  const key = diagnostic ? rawErrors.get(diagnostic) : undefined;
  return key ? { key } : { key: fallback, ...(diagnostic ? { diagnostic } : {}) };
}

/** For raw query/lib errors rendered directly; state stores toErrorMessage instead. */
export function translateError(error: unknown, fallback: TranslationKey = "genericError"): string {
  return renderMessage(toErrorMessage(error, fallback));
}
