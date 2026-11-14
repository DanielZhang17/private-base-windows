export interface PreKeyBundle {
    deviceId: string;
    identityKey: string;
    signedPreKey: string;
    signedPreKeyId: number;
    signedPreKeySig: string;
    oneTimePreKey?: {
        id: number;
        key: string;
    };
}
export interface EncryptedPayload {
    ciphertext: string;
    iv: string;
    header: string;
}
export interface RatchetHeader {
    dhPublicKey: string;
    n: number;
    pn: number;
}
export interface SenderKeyHeader {
    senderKeyId: number;
    chainIndex: number;
    signature: string;
}
export interface InitialMessageHeader {
    identityKey: string;
    ephemeralKey: string;
    oneTimePreKeyId?: number;
    signedPreKeyId: number;
}
//# sourceMappingURL=crypto.d.ts.map