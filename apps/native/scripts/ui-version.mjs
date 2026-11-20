const UINT64_MAX = 2n ** 64n - 1n;

export function semver(value) {
  const match = typeof value === "string" && value.length <= 64
    && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match[0] !== value) throw new Error("Expected a valid semantic version of at most 64 characters.");
  const core = match.slice(1, 4).map(BigInt);
  const pre = match[4]?.split(".") ?? [];
  if (core.some(part => part > UINT64_MAX) || pre.some(part => /^0[0-9]+$/.test(part))) {
    throw new Error("Invalid semantic version components.");
  }
  return { core, pre };
}

export const validContractNumber = value => Number.isInteger(value) && value >= 1 && value <= 0xffff_ffff;
