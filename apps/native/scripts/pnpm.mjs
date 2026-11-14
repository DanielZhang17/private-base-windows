import { spawnSync } from "node:child_process";

// Builds the web app's workspace dependencies (topologically), whose package
// entries are generated dist files. "^..." excludes the web package itself.
export const BUILD_WEB_DEPENDENCIES = ["--filter", "@e2ee-chat/web^...", "build"];

// How to re-invoke the pnpm that is running this hook, without a POSIX shell:
// - npm_execpath is a JS entry point (npm/corepack installs): run it with Node.
// - npm_execpath is a native executable (@pnpm/exe, pnpm.exe): run it directly.
// - npm_execpath is unset (hook not started by pnpm): use pnpm from PATH.
export function pnpmCommand(args, env = process.env, platform = process.platform) {
  const execPath = env.npm_execpath;
  if (!execPath) {
    // On Windows, pnpm on PATH is a .cmd shim, which needs a shell. Quote the
    // (constant) arguments so cmd.exe keeps "^" literal.
    return platform === "win32"
      ? { command: "pnpm", args: args.map((arg) => `"${arg}"`), shell: true }
      : { command: "pnpm", args, shell: false };
  }
  if (/\.[cm]?js$/i.test(execPath)) {
    return { command: process.execPath, args: [execPath, ...args], shell: false };
  }
  return { command: execPath, args, shell: false };
}

// Runs the steps in order and exits with the first failing status.
export function runPnpmSteps(steps, env = process.env) {
  for (const step of steps) {
    const { command, args, shell } = pnpmCommand(step, env);
    const result = spawnSync(command, args, { stdio: "inherit", env, shell });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
