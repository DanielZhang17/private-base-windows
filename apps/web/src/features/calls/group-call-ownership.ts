let localGroupCall: symbol | null = null;

export function hasLocalGroupCall() { return localGroupCall !== null; }

export function reserveGroupCall() {
  if (localGroupCall) return null;
  const token = Symbol("group call");
  localGroupCall = token;
  return () => { if (localGroupCall === token) localGroupCall = null; };
}
