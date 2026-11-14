const fs = require("node:fs");
const path = require("node:path");

function findPackageRoot(entryPath, expectedName) {
  let current = path.dirname(entryPath);
  while (true) {
    const pkgPath = path.join(current, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkgJson = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkgJson.name === expectedName) {
        return current;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not locate package root for ${expectedName}`);
    }
    current = parent;
  }
}

function main() {
  const workspaceRoot = path.resolve(__dirname, "..");
  const resolutionRoots = [
    workspaceRoot,
    path.join(workspaceRoot, "packages", "crypto"),
    path.join(workspaceRoot, "apps", "web"),
    path.join(workspaceRoot, "apps", "api"),
  ];

  function resolveFromWorkspaces(specifier) {
    for (const root of resolutionRoots) {
      try {
        return require.resolve(specifier, { paths: [root] });
      } catch {
        // Try next workspace root.
      }
    }
    throw new Error(`Cannot resolve dependency: ${specifier}`);
  }

  const wrappersEntry = resolveFromWorkspaces("libsodium-wrappers-sumo");
  const wrappersRoot = findPackageRoot(wrappersEntry, "libsodium-wrappers-sumo");
  const sodiumRoot = path.join(path.dirname(wrappersRoot), "libsodium-sumo");
  const sodiumPkgPath = path.join(sodiumRoot, "package.json");
  if (!fs.existsSync(sodiumPkgPath)) {
    throw new Error(`Cannot locate libsodium-sumo near ${wrappersRoot}`);
  }

  const sourceFile = path.join(sodiumRoot, "dist", "modules-sumo-esm", "libsodium-sumo.mjs");
  const targetDir = path.join(wrappersRoot, "dist", "modules-sumo-esm");
  const targetFile = path.join(targetDir, "libsodium-sumo.mjs");

  if (!fs.existsSync(sourceFile)) {
    throw new Error(`Missing source file: ${sourceFile}`);
  }

  if (fs.existsSync(targetFile)) {
    console.log("[postinstall] libsodium-wrappers-sumo ESM module present");
    return;
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(sourceFile, targetFile);
  console.log("[postinstall] Restored missing libsodium-wrappers-sumo ESM module");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[postinstall] Failed to patch libsodium wrappers: ${message}`);
  process.exitCode = 1;
}
