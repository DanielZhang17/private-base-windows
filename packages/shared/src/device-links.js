export function createDeviceLinkApprovalPayload(linkRequestId, newIdentityKey, shortCode, expiresAt) {
    return JSON.stringify({
        kind: "device_link_approval",
        linkRequestId,
        newIdentityKey,
        shortCode,
        expiresAt,
    });
}
export function createDeviceLinkChallengePayload(linkRequestId, challengeNonce) {
    return JSON.stringify({
        kind: "device_link_complete",
        linkRequestId,
        challengeNonce,
    });
}
//# sourceMappingURL=device-links.js.map