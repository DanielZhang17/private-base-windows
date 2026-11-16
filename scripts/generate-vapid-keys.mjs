// Run manually: node scripts/generate-vapid-keys.mjs
// Writes only to stdout. Never commit the output or reuse test fixture keys.
const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64url");
const privateKey = await crypto.subtle.exportKey("jwk", keys.privateKey);
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey.d}`);
