#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const RELEASE_BASE = 'https://dist.718788.xyz/private-base/releases/';
const PREFIX = 'private-base/releases/';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// Mirrored from features/clients/manifest.ts. Its CLI integration test checks interoperability.
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;
const SHORT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const MIN_OS = /^[^\p{Cc}<>]{1,64}$/u;
const MAX_SIZE = 2 ** 40;
const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);
function matching(value, pattern, field) {
  if (typeof value !== 'string' || !pattern.test(value.trim()) || value.trim() !== value) throw new Error(`Invalid release field: ${field}`);
  return value;
}
function validateSize(size) {
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_SIZE) throw new Error('Invalid release field: size');
}
export function validateDownloadManifest(input) {
  if (!isRecord(input)) throw new Error('Invalid release manifest root.');
  matching(input.version, VERSION, 'version');
  if (typeof input.published !== 'string' || Number.isNaN(new Date(input.published).getTime())) throw new Error('Invalid publication date.');
  if (!isRecord(input.platforms)) throw new Error('Invalid release platforms.');
  for (const key of ['macos', 'windows', 'android', 'ios']) {
    const build = input.platforms[key];
    if (build === null || build === undefined) continue;
    if (!isRecord(build)) throw new Error(`Invalid release platform: ${key}`);
    const url = typeof build.url === 'string' ? new URL(build.url) : null;
    if (!url || url.origin !== 'https://dist.718788.xyz' || url.protocol !== 'https:' || url.username || url.password || url.port !== '') throw new Error('Invalid release URL.');
    validateSize(build.size);
    matching(build.file, FILE_NAME, 'file'); matching(build.sha256, SHA256, 'sha256');
    matching(build.arch, SHORT_TOKEN, 'arch'); matching(build.minOs, MIN_OS, 'minOs');
  }
}
function validateArtifacts(artifacts) {
  const names = new Set();
  for (const a of artifacts) {
    matching(a.file, FILE_NAME, 'file'); validateSize(a.size); matching(a.sha256, SHA256, 'sha256');
    if (names.has(a.file)) throw new Error('Artifact filenames must be unique.');
    names.add(a.file);
  }
}

export function versionParts(version) {
  if (!SEMVER.test(version ?? '')) throw new Error('Expected a version in X.Y.Z form.');
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Version is too large.');
  return parts;
}
function compare(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
/** Tauri default: no versionCode override or autoIncrementVersionCode. */
export function androidVersionCode(version) {
  const [major, minor, patch] = versionParts(version);
  const code = major * 1_000_000 + minor * 1_000 + patch;
  if (minor > 999 || patch > 999 || code < 1 || code > 2_100_000_000) throw new Error('Version is outside the monotonic Android versionCode range.');
  return code;
}
export function validateOptions(options) {
  const { version, channel, rollout, minimum = '0.1.0', blocked = [] } = options;
  androidVersionCode(version);
  if (compare(version, '0.1.0') < 0) throw new Error('The first updatable release is 0.1.0.');
  if (!['stable', 'beta'].includes(channel)) throw new Error('Channel must be stable or beta.');
  if (!Number.isInteger(rollout) || rollout < 0 || rollout > 100) throw new Error('Rollout must be an integer from 0 to 100.');
  versionParts(minimum);
  if (compare(minimum, version) > 0) throw new Error('Minimum version must not exceed the release version.');
  blocked.forEach(versionParts);
  if (!Number.isInteger(options.minSdk ?? 24) || (options.minSdk ?? 24) < 24) throw new Error('Android minSdk must be an integer at least 24.');
  matching(options.androidArch ?? 'arm64', SHORT_TOKEN, 'androidArch');
  matching(options.macMinOs ?? 'macOS 12.3', MIN_OS, 'macMinOs');
  matching(options.windowsMinOs ?? 'Windows 10', MIN_OS, 'windowsMinOs');
  const date = new Date(options.pubDate ?? new Date());
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid publication date.');
  return { ...options, minimum, blocked: [...new Set(blocked)], pubDate: date.toISOString(), minSdk: options.minSdk ?? 24 };
}
const urlFor = (version, file) => `${RELEASE_BASE}${version}/${encodeURIComponent(file)}`;

/** Pure manifest generation, also used by the CLI and unit tests. */
export function generateManifests(input, artifacts) {
  const o = validateOptions(input);
  if (!artifacts.length) throw new Error('Provide at least one platform artifact set.');
  validateArtifacts(artifacts);
  const manifests = {};
  const policy = { rolloutPercent: o.rollout, minimumVersion: o.minimum, blocked: o.blocked };
  const find = (target, kind) => artifacts.find(a => a.target === target && a.kind === kind);
  for (const target of ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']) {
    const update = find(target, 'update');
    if (!update) continue;
    if (!update.signature?.trim()) throw new Error(`Missing updater signature for ${target}.`);
    manifests[`${o.channel}/updater/${target}.json`] = {
      version: o.version, notes: o.notes ?? '', pub_date: o.pubDate,
      platforms: { [target]: { signature: update.signature.trim(), url: urlFor(o.version, update.file) } }, ...policy,
    };
  }
  const apk = find('android', 'installer');
  if (apk) manifests[`${o.channel}/android.json`] = {
    versionName: o.version, versionCode: androidVersionCode(o.version), url: urlFor(o.version, apk.file),
    sha256: apk.sha256, size: apk.size, minSdk: o.minSdk, notes: o.notes ?? '', pub_date: o.pubDate, ...policy,
  };
  if (o.channel === 'stable') {
    const entry = (a, arch, minOs, signed) => a ? { file: a.file, url: urlFor(o.version, a.file), size: a.size, sha256: a.sha256, arch, minOs, signed } : null;
    const arm = find('darwin-aarch64', 'installer');
    // The existing download page has one macos entry. Prefer Apple Silicon when both are built.
    manifests['latest.json'] = {
      product: 'Private Base', version: o.version, published: o.pubDate,
      platforms: {
        macos: entry(arm ?? find('darwin-x86_64', 'installer'), arm ? 'arm64' : 'x64', o.macMinOs ?? 'macOS 12.3', o.macSigning ?? 'See release notes'),
        android: entry(apk, o.androidArch ?? 'arm64', `Android API ${o.minSdk}+`, o.androidSigning ?? 'release key'),
        windows: entry(find('windows-x86_64', 'update'), 'x64', o.windowsMinOs ?? 'Windows 10', o.windowsSigning ?? 'unsigned'),
        ios: null,
      },
    };
  }
  if (manifests['latest.json']) validateDownloadManifest(manifests['latest.json']);
  return manifests;
}

const GROUPS = [
  { target: 'darwin-aarch64', args: ['macos-aarch64-dmg', 'macos-aarch64-update', 'macos-aarch64-sig'], extensions: ['.dmg', '.app.tar.gz', '.sig'] },
  { target: 'darwin-x86_64', args: ['macos-x86_64-dmg', 'macos-x86_64-update', 'macos-x86_64-sig'], extensions: ['.dmg', '.app.tar.gz', '.sig'] },
  { target: 'windows-x86_64', args: ['windows', 'windows-sig'], extensions: ['.exe', '.sig'] },
  { target: 'android', args: ['android'], extensions: ['.apk'] },
];
function artifactName(version, target, kind, androidArch) {
  if (target === 'android') return `PrivateBase-${version}-android-${androidArch}.apk`;
  if (target === 'windows-x86_64') return `PrivateBase-${version}-windows-x64-setup.exe${kind === 'signature' ? '.sig' : ''}`;
  const arch = target === 'darwin-aarch64' ? 'arm64' : 'x64';
  const extension = kind === 'installer' ? '.dmg' : `.app.tar.gz${kind === 'signature' ? '.sig' : ''}`;
  return `PrivateBase-${version}-macos-${arch}${extension}`;
}
async function describeArtifact(path, target, kind, version, androidArch) {
  const absolute = resolve(path);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error('Artifact must be a regular file.');
  validateSize(info.size);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(absolute)) { size += chunk.length; hash.update(chunk); }
  return { path: absolute, target, kind, file: artifactName(version, target, kind, androidArch), size, sha256: hash.digest('hex') };
}
export async function collectArtifacts(args) {
  versionParts(args.version);
  const androidArch = matching(args['android-arch'] ?? 'arm64', SHORT_TOKEN, 'androidArch');
  const artifacts = [];
  for (const group of GROUPS) {
    if (!group.args.some(key => args[key])) continue;
    if (!group.args.every(key => args[key])) throw new Error(`Provide all of: ${group.args.map(key => `--${key}`).join(', ')}.`);
    let update;
    for (let i = 0; i < group.args.length; i++) {
      const path = args[group.args[i]];
      if (!path.endsWith(group.extensions[i])) throw new Error(`Invalid extension for --${group.args[i]}.`);
      const kind = group.extensions[i] === '.sig' ? 'signature' : group.extensions[i] === '.dmg' || group.target === 'android' ? 'installer' : 'update';
      const artifact = await describeArtifact(path, group.target, kind, args.version, androidArch);
      if (kind === 'update') update = artifact;
      if (kind === 'signature') {
        const signature = (await readFile(artifact.path, 'utf8')).trim();
        if (!/^[A-Za-z0-9+/=\r\n]+$/.test(signature)) throw new Error('Expected a Tauri updater .sig file.');
        update.signature = signature;
      }
      artifacts.push(artifact);
    }
  }
  return artifacts;
}
const VALUE_ARGS = new Set(['version', 'channel', 'rollout', 'minimum', 'block', 'notes-file', 'pub-date', 'out', 'android-min-sdk', 'android-arch', 'macos-min-os', 'macos-signing', 'android-signing', 'windows-min-os', 'windows-signing', ...GROUPS.flatMap(g => g.args)]);
export function parseArgs(argv) {
  const result = { block: [], publish: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2);
    if (argv[i] === '--publish') { result.publish = true; continue; }
    if (argv[i] === '--help') { result.help = true; continue; }
    if (!argv[i].startsWith('--') || !VALUE_ARGS.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Unknown option or missing option value. Use --help.');
    const value = argv[++i];
    if (key === 'block') result.block.push(value);
    else { if (key in result) throw new Error('Duplicate option.'); result[key] = value; }
  }
  return result;
}

async function wrangler(args) {
  try {
    return await exec('npx', ['--no-install', 'wrangler', 'r2', 'object', ...args, '--remote'], {
      cwd: join(ROOT, 'apps/api'), timeout: 300_000, maxBuffer: 2_000_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
  } catch (error) {
    // Wrangler diagnostics are deliberately not printed (credentials may be in the environment).
    if (String(error.stderr).includes('The specified key does not exist.')) return { missing: true };
    throw new Error('Wrangler failed. Check local authentication and bucket access; no further uploads attempted.');
  }
}
export async function publishRelease({ version, artifacts, manifests, out }, remote = wrangler) {
  versionParts(version);
  validateArtifacts(artifacts);
  if ('latest.json' in manifests) validateDownloadManifest(manifests['latest.json']);
  const temp = await mkdtemp(join(tmpdir(), 'private-base-release-'));
  try {
    // Authenticated reads avoid CDN negative caching. Fail closed on every error except a missing key.
    const immutable = artifacts.map(a => ({ key: `${PREFIX}${version}/${a.file}`, path: a.path, contentType: a.file.endsWith('.sig') ? 'text/plain' : 'application/octet-stream' }));
    // Save a versioned manifest snapshot too, so a published version cannot be reused with new names.
    const snapshotKey = `${PREFIX}${version}/release.json`;
    for (const key of [snapshotKey, ...immutable.map(a => a.key)]) {
      const result = await remote(['get', `dist/${key}`, '--file', join(temp, 'existing')]);
      if (!result.missing) throw new Error(`Refusing to overwrite immutable release object: ${key}`);
    }
    const snapshotPath = join(out, 'release.json');
    await writeFile(snapshotPath, JSON.stringify({ version, artifacts: artifacts.map(({ path, signature, ...a }) => a), manifests }, null, 2) + '\n');
    immutable.push({ key: snapshotKey, path: snapshotPath, contentType: 'application/json' });
    for (const a of immutable) await remote(['put', `dist/${a.key}`, '--file', a.path, '--content-type', a.contentType, '--cache-control', 'public, max-age=31536000, immutable']);
    // Only make a release discoverable once all immutable objects have uploaded successfully.
    for (const name of Object.keys(manifests)) await remote(['put', `dist/${PREFIX}${name}`, '--file', join(out, name), '--content-type', 'application/json', '--cache-control', 'no-cache, max-age=0, must-revalidate']);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(`Usage: node scripts/release.mjs --version X.Y.Z --channel stable|beta --rollout 0..100 [artifacts] [--publish]
Artifacts (all files in each supplied group are required):
  --macos-aarch64-dmg FILE --macos-aarch64-update FILE.app.tar.gz --macos-aarch64-sig FILE.sig
  --macos-x86_64-dmg FILE --macos-x86_64-update FILE.app.tar.gz --macos-x86_64-sig FILE.sig
  --windows FILE-setup.exe --windows-sig FILE.sig
  --android FILE.apk [--android-min-sdk 24] [--android-arch arm64]
Policy: --minimum X.Y.Z --block X.Y.Z (repeatable) --notes-file FILE --pub-date ISO_DATE
Download-page metadata: --macos-signing TEXT --android-signing TEXT --windows-signing TEXT
  --macos-min-os TEXT --windows-min-os TEXT
Output: --out DIRECTORY (default dist/release/VERSION/CHANNEL)
Default: local generation only; no network requests. --publish uploads via the repo's Wrangler.
Never publish the same version twice. Publish from one release operator at a time.`);
    return;
  }
  const options = validateOptions({
    version: args.version, channel: args.channel, rollout: Number(args.rollout), minimum: args.minimum,
    blocked: args.block, pubDate: args['pub-date'], minSdk: args['android-min-sdk'] === undefined ? 24 : Number(args['android-min-sdk']),
    androidArch: args['android-arch'], macMinOs: args['macos-min-os'], macSigning: args['macos-signing'],
    androidSigning: args['android-signing'], windowsMinOs: args['windows-min-os'], windowsSigning: args['windows-signing'],
  });
  options.notes = args['notes-file'] ? await readFile(resolve(args['notes-file']), 'utf8') : '';
  const artifacts = await collectArtifacts(args);
  const manifests = generateManifests(options, artifacts);
  const out = resolve(args.out ?? join(ROOT, 'dist/release', options.version, options.channel));
  for (const [name, content] of Object.entries(manifests)) {
    const path = join(out, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(content, null, 2) + '\n');
  }
  console.log(`Generated ${Object.keys(manifests).length} manifests in ${out}.`);
  for (const artifact of artifacts) console.log(`${artifact.file}: ${artifact.size} bytes, sha256 ${artifact.sha256}`);
  if (args.publish) {
    await publishRelease({ version: options.version, artifacts, manifests, out });
    console.log(`Published ${options.version} to ${options.channel}.`);
  } else console.log('Dry run: nothing uploaded. Review the manifests before using --publish.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`Release failed: ${error.code ? 'Could not read or write release files.' : error.message} No further uploads attempted.`); process.exitCode = 1; });
}
