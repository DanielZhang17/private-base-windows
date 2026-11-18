function assertBufferSource(value: unknown, name: string) {
  if (value instanceof ArrayBuffer || (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer)) return;
  throw new TypeError(`${name}: Not an ArrayBuffer-backed BufferSource`);
}

function checkAlgorithm(algorithm: unknown, method: string) {
  if (!algorithm || typeof algorithm !== "object") return;
  const params = algorithm as Record<string, unknown>;
  for (const name of ["iv", "additionalData", "salt", "info"]) {
    // An optional byte field must be absent or hold bytes, even if Node accepts undefined.
    if (name in params) assertBufferSource(params[name], `${method} ${name}`);
  }
}

/** Exercise the real crypto implementation with stricter checks at its byte boundaries. */
export function strictWebCrypto(source: Crypto): Crypto {
  const subtle = new Proxy(source.subtle, {
    get(target, method) {
      const original = Reflect.get(target, method, target);
      if (typeof original !== "function") return original;
      return async (...args: unknown[]) => {
        switch (method) {
          case "encrypt":
          case "decrypt":
          case "sign":
          case "verify":
            checkAlgorithm(args[0], method);
            assertBufferSource(args[2], `${method} ${method === "verify" ? "signature" : "data"}`);
            if (method === "verify") assertBufferSource(args[3], "verify data");
            break;
          case "importKey":
            if (args[0] !== "jwk") assertBufferSource(args[1], "importKey key data");
            checkAlgorithm(args[2], method);
            break;
          case "deriveKey":
          case "deriveBits":
            checkAlgorithm(args[0], method);
            break;
        }
        return Reflect.apply(original, target, args);
      };
    },
  });
  return new Proxy(source, {
    get(target, property) {
      if (property === "subtle") return subtle;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
