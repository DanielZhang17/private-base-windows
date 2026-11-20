#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';
import { PREFIX, RELEASE_BASE, readRemoteJson, uploadDiscovery, wrangler } from './release.mjs';
import { semver, validContractNumber as validDbSchema } from '../apps/native/scripts/ui-version.mjs';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE = join(ROOT, 'apps/native');
const DIST = join(ROOT, 'apps/web/dist-native');
const CONTRACT = JSON.parse(await readFile(join(NATIVE, 'ui-bundle.json'), 'utf8'));
const WEB_DB_SCHEMA = JSON.parse(await readFile(join(ROOT, 'apps/web/src/db/schema-version.json'), 'utf8')).version;
const PINNED_PUBLIC_KEY = JSON.parse(await readFile(join(NATIVE, 'src-tauri/tauri.conf.json'), 'utf8')).plugins.updater.pubkey;
const NAME = 'bundle.tar.gz';
const CHANNELS = ['stable', 'beta'];
const MAX_BUNDLE = 32 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_FILES = 2048;
const MAX_SIGNATURE = 8 * 1024;
const MAX_DISCOVERY = 64 * 1024;
const MAX_MANIFEST = 512 * 1024;

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const artifactDir = version => `ui/${version}`;
const discoveryName = channel => `${channel}/ui.json`;
const artifactUrl = version => `${RELEASE_BASE}${artifactDir(version)}/${NAME}`;

function compare(a, b) {
  const x = semver(a);
  const y = semver(b);
  for (let i = 0; i < x.core.length; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  }
  if (!x.pre.length || !y.pre.length) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const left = x.pre[i], right = y.pre[i];
    if (left === right) continue;
    const leftNumeric = /^[0-9]+$/.test(left), rightNumeric = /^[0-9]+$/.test(right);
    if (leftNumeric && rightNumeric) return BigInt(left) < BigInt(right) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return Math.sign(x.pre.length - y.pre.length);
}

function checkChannel(channel) {
  if (!CHANNELS.includes(channel)) throw new Error('Channel must be stable or beta.');
}

function checkShellRange(min, max) {
  semver(min);
  if (max !== undefined && compare(max, min) < 0) {
    throw new Error('Maximum shell version precedes minimum shell version.');
  }
}

export function matchesShellSchemas({
  nativeContract, minShellVersion, maxShellVersion, dbSchemaVersion,
}, ranges = CONTRACT.shellDbSchemas) {
  if (maxShellVersion === undefined) return false;
  const known = ranges.filter(range => range.nativeContract === nativeContract
    && compare(range.maxShellVersion, minShellVersion) >= 0
    && compare(range.minShellVersion, maxShellVersion) <= 0)
    .sort((a, b) => compare(a.minShellVersion, b.minShellVersion));
  if (known.some(range => range.dbSchemaVersion !== dbSchemaVersion)) return false;
  let covered = minShellVersion;
  for (const range of known) {
    if (compare(range.minShellVersion, covered) > 0) break;
    if (compare(range.maxShellVersion, maxShellVersion) >= 0) return true;
    if (compare(range.maxShellVersion, covered) > 0) covered = range.maxShellVersion;
  }
  return false;
}

function checkPolicy({ rolloutPercent, blocked, notes }) {
  if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
    throw new Error('Rollout must be an integer from 0 to 100.');
  }
  if (!Array.isArray(blocked)) throw new Error('Blocked must be a list of UI versions.');
  blocked.forEach(semver);
  if (notes !== undefined && (typeof notes !== 'string' || Buffer.byteLength(notes) > 16 * 1024)) {
    throw new Error('UI release notes must be text of at most 16 KiB.');
  }
}

function validPath(path) {
  return typeof path === 'string' && path.length <= 192 && path.split('/').every(part =>
    part.length > 0 && part.length <= 100 && !/[^A-Za-z0-9._-]/.test(part) && !part.endsWith('.')
      && !/^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(part));
}

function rememberPath(seen, path, directory) {
  const canonical = path.toLowerCase();
  // A directory prefix can repeat verbatim across files. A regular file,
  // a differently cased directory, and the reserved manifest cannot alias it.
  if (seen.has(canonical) && (!directory || seen.get(canonical) !== path)) {
    throw new Error('Bundle paths collide on a case-insensitive filesystem.');
  }
  seen.set(canonical, directory ? path : null);
}

function checkManifestPaths(files) {
  if (!Array.isArray(files) || files.length > MAX_FILES) throw new Error('Invalid bundle files.');
  const seen = new Map([['manifest.json', null]]);
  for (const { path } of files) {
    if (!validPath(path)) throw new Error('Invalid bundle asset path.');
    rememberPath(seen, path, false);
    for (let end = path.indexOf('/'); end !== -1; end = path.indexOf('/', end + 1)) {
      rememberPath(seen, path.slice(0, end), true);
    }
  }
}

async function readBounded(path, limit) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.size > limit) throw new Error('Expected a regular release file within the size limit.');
  const bytes = await readFile(path);
  if (bytes.length !== entry.size) throw new Error('Release file changed while reading.');
  return bytes;
}

/** Build the signed-format contents in a private snapshot of dist-native. */
export async function packBundle(input, out, {
  uiVersion, minShellVersion, maxShellVersion, dbSchemaVersion = WEB_DB_SCHEMA, createdAt = new Date(),
}, contract = CONTRACT) {
  if (compare(uiVersion, contract.embeddedUiVersion) <= 0) throw new Error('UI version must exceed the embedded version.');
  if (!validDbSchema(dbSchemaVersion)) throw new Error('Invalid IndexedDB schema version.');
  checkShellRange(minShellVersion, maxShellVersion);
  if (!(await lstat(input)).isDirectory()) throw new Error('Expected a real dist-native directory.');
  const temp = await mkdtemp(join(tmpdir(), 'private-base-ui-'));
  try {
    const root = join(temp, 'files');
    await mkdir(root);
    const files = [];
    const seen = new Map([['manifest.json', null]]);
    let total = 0;
    async function copy(directory, prefix = '') {
      for (const name of (await readdir(directory)).sort()) {
        const path = prefix + name;
        if (!validPath(path)) throw new Error('Invalid bundle asset path.');
        const source = join(directory, name);
        const entry = await lstat(source);
        const dest = join(root, path);
        const isDirectory = entry.isDirectory();
        rememberPath(seen, path, isDirectory);
        if (isDirectory) {
          await mkdir(dest);
          await copy(source, path + '/');
          continue;
        }
        if (!entry.isFile()) throw new Error('Expected regular bundle files.');
        if (entry.size > MAX_FILE || total + entry.size > MAX_TOTAL || files.length >= MAX_FILES) {
          throw new Error('Bundle exceeds asset limits.');
        }
        const bytes = await readBounded(source, MAX_FILE);
        if (bytes.length !== entry.size) throw new Error('Bundle input changed during packing.');
        await writeFile(dest, bytes, { flag: 'wx' });
        total += bytes.length;
        files.push({ path, sha256: hash(bytes), size: bytes.length });
      }
    }
    await copy(input);
    if (!files.some(file => file.path === 'index.html' && file.size > 0)) throw new Error('Bundle requires index.html.');
    const { nativeContract } = contract;
    const target = { uiVersion, nativeContract, minShellVersion, maxShellVersion, dbSchemaVersion };
    const manifest = { ...target, files, createdAt: new Date(createdAt).toISOString() };
    const json = JSON.stringify(manifest);
    if (Buffer.byteLength(json) > MAX_MANIFEST) throw new Error('Bundle manifest exceeds size limit.');
    await writeFile(join(root, 'manifest.json'), json, { flag: 'wx' });
    const packed = join(temp, NAME);
    // Explicit paths emit regular entries only. USTAR avoids extended headers.
    const list = join(temp, 'paths');
    await writeFile(list, ['manifest.json', ...files.map(file => file.path), ''].join('\0'));
    await exec('tar', ['-czf', packed, '--format=ustar', '--null', '-T', list], {
      cwd: root,
      env: { ...unsignedEnvironment(), COPYFILE_DISABLE: '1' },
    });
    const bytes = await readBounded(packed, MAX_BUNDLE);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, NAME), bytes, { flag: 'wx' });
    return { ...target, url: artifactUrl(uiVersion), sha256: hash(bytes), size: bytes.length };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function unsignedEnvironment(env = process.env) {
  return Object.fromEntries(Object.keys(env)
    .filter(name => !name.startsWith('TAURI_SIGNING_')).map(name => [name, env[name]]));
}

function signatureText(text) {
  const value = text?.trim();
  if (!value || value.length > MAX_SIGNATURE || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
      || Buffer.from(value, 'base64').toString('base64') !== value) {
    throw new Error('Expected a Tauri updater .sig file.');
  }
  return value;
}

export function generateDiscovery(artifact, policy, signature) {
  checkPolicy(policy);
  return { ...artifact, signature: signature === undefined ? null : signatureText(signature), ...policy };
}

export function signingEnvironment(env) {
  return {
    ...unsignedEnvironment(env),
    // with-signing-env.sh exports a filename for tauri build. The standalone
    // signer interprets that variable as key contents unless we use its path option.
    TAURI_SIGNING_PRIVATE_KEY_PATH: env.TAURI_SIGNING_PRIVATE_KEY ?? env.TAURI_SIGNING_PRIVATE_KEY_PATH,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
  };
}

export function verifySignature(bytes, encoded, pinnedKey = PINNED_PUBLIC_KEY) {
  const decode = text => Buffer.from(signatureText(text), 'base64');
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const [, keyLine] = utf8.decode(decode(pinnedKey)).split(/\r?\n/);
  const [, signatureLine, comment, globalLine] = utf8.decode(decode(encoded)).split(/\r?\n/);
  const key = decode(keyLine);
  const signed = decode(signatureLine);
  const global = decode(globalLine);
  const algorithm = signed.toString('latin1', 0, 2);
  const commentPrefix = 'trusted comment: ';
  const invalid = () => new Error('UI bundle signature does not verify against the pinned updater public key.');
  if (key.length !== 42 || signed.length !== 74 || global.length !== 64
      || !key.subarray(2, 10).equals(signed.subarray(2, 10))
      || !['Ed', 'ED'].includes(key.toString('latin1', 0, 2)) || !['Ed', 'ED'].includes(algorithm)
      || !comment?.startsWith(commentPrefix)) throw invalid();
  // Tauri uses Minisign: ED signs the BLAKE2b-512 digest and Ed signs the raw
  // payload. Both also sign the raw signature followed by the trusted comment.
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]),
    format: 'der', type: 'spki',
  });
  const payload = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
  const signature = signed.subarray(10);
  const trusted = Buffer.concat([signature, Buffer.from(comment.slice(commentPrefix.length))]);
  if (!verify(null, payload, publicKey, signature) || !verify(null, trusted, publicKey, global)) throw invalid();
}

async function sign(out, uiVersion) {
  try {
    await exec(process.execPath, [
      join(NATIVE, 'node_modules/@tauri-apps/cli/tauri.js'),
      // The signer names its authenticated version option after apps.
      'signer', 'sign', '--app-version', uiVersion, join(out, NAME),
    ], { cwd: NATIVE, env: signingEnvironment(process.env) });
  } catch {
    throw new Error('Tauri signing failed. Use the supervised with-signing-env.sh flow.');
  }
  return signatureText((await readBounded(join(out, NAME + '.sig'), MAX_SIGNATURE)).toString('utf8'));
}

export async function publishUiRelease(
  { channel, out }, remote = wrangler, checkSignature = verifySignature, contract = CONTRACT,
) {
  checkChannel(channel);
  const name = discoveryName(channel);
  const discovery = await readBounded(join(out, name), MAX_DISCOVERY);
  const feed = JSON.parse(discovery);
  const { uiVersion, nativeContract, minShellVersion, maxShellVersion, dbSchemaVersion, url, sha256, size } = feed;
  checkShellRange(minShellVersion, maxShellVersion);
  if (compare(uiVersion, contract.embeddedUiVersion) <= 0 || nativeContract !== contract.nativeContract
      || !validDbSchema(dbSchemaVersion)
      || url !== artifactUrl(uiVersion) || !/^[a-f0-9]{64}$/.test(sha256)
      || !Number.isInteger(size) || size < 1 || size > MAX_BUNDLE) {
    throw new Error('Invalid UI discovery manifest.');
  }
  checkPolicy(feed);
  const announced = signatureText(feed.signature);
  const bytes = await readBounded(join(out, NAME), size);
  const signature = await readBounded(join(out, NAME + '.sig'), MAX_SIGNATURE);
  if (signatureText(signature.toString('utf8')) !== announced || bytes.length !== size || hash(bytes) !== sha256) {
    throw new Error('Prepared UI bundle or signature differs from discovery manifest.');
  }
  checkSignature(bytes, announced);

  const temp = await mkdtemp(join(tmpdir(), 'private-base-ui-publish-'));
  try {
    const manifestPath = join(temp, 'discovery');
    await writeFile(manifestPath, discovery);
    const bundlePath = join(temp, NAME);
    await writeFile(bundlePath, bytes);
    const { stdout } = await exec('tar', ['-xOzf', bundlePath, 'manifest.json'], {
      maxBuffer: MAX_MANIFEST, timeout: 15_000, env: unsignedEnvironment(),
    });
    const signed = JSON.parse(stdout);
    if (signed.uiVersion !== uiVersion || signed.nativeContract !== nativeContract
        || signed.minShellVersion !== minShellVersion || signed.maxShellVersion !== maxShellVersion
        || signed.dbSchemaVersion !== dbSchemaVersion) {
      throw new Error('Signed UI bundle manifest differs from discovery manifest.');
    }
    checkManifestPaths(signed.files);
    if (!matchesShellSchemas(signed, contract.shellDbSchemas)) {
      throw new Error('The bundle database schema must match every shell in a documented, bounded range. Ship database schema changes in a full release.');
    }
    try {
      await exec('cargo', [
        'run', '--quiet', '--locked', '--offline',
        '--manifest-path', join(NATIVE, 'src-tauri/Cargo.toml'),
        '--example', 'validate_ui_bundle', '--', bundlePath,
      ], { env: unsignedEnvironment() });
    } catch (error) {
      throw new Error(`Native OTA archive validation failed. ${error.stderr?.trim() || error.message}`);
    }
    let alreadyPublished = false;
    for (const currentChannel of CHANNELS) {
      const previous = await readRemoteJson(discoveryName(currentChannel), temp, remote);
      if (currentChannel === channel && isDeepStrictEqual(previous, feed)) {
        alreadyPublished = true;
      } else if (previous !== undefined && compare(uiVersion, previous?.uiVersion) <= 0) {
        throw new Error('UI version must increase across both channels.');
      }
    }
    const objects = [
      { file: NAME, type: 'application/gzip', size, digest: sha256 },
      { file: NAME + '.sig', type: 'text/plain', size: signature.length, digest: hash(signature) },
    ];
    await writeFile(bundlePath + '.sig', signature);
    const missing = [];
    for (const object of objects) {
      const key = `dist/${PREFIX}${artifactDir(uiVersion)}/${object.file}`;
      const existing = join(temp, 'existing-' + object.file);
      const result = await remote(['get', key, '--file', existing]);
      if (result.missing === true) {
        missing.push({ ...object, key });
        continue;
      }
      const current = await readBounded(existing, object.size).catch(() => undefined);
      if (!current || hash(current) !== object.digest) {
        throw new Error(`Refusing to overwrite immutable release object ${key}.`);
      }
    }
    for (const object of missing) {
      const artifactPath = join(temp, object.file);
      await remote(['put', object.key, '--file', artifactPath, '--content-type', object.type, '--cache-control', 'public, max-age=31536000, immutable']);
    }
    if (!alreadyPublished) await uploadDiscovery(name, manifestPath, remote);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    'ui-version': { type: 'string' }, channel: { type: 'string' }, rollout: { type: 'string' },
    'min-shell-version': { type: 'string' }, 'max-shell-version': { type: 'string' },
    'notes-file': { type: 'string' }, block: { type: 'string', multiple: true },
    out: { type: 'string' }, sign: { type: 'boolean' }, publish: { type: 'boolean' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log(`Build and pack (dry run): node scripts/release-ui.mjs --ui-version UI_VERSION --channel stable|beta --min-shell-version APP_VERSION --rollout 0..100
  Optional: --max-shell-version VERSION --notes-file FILE --block VERSION (repeatable) --out DIR --sign
  Default output: dist/release-ui/VERSION/CHANNEL. --sign requires the supervised signing environment.
Publish prebuilt signed files: node scripts/release-ui.mjs --publish --channel stable|beta --out DIR`);
    return;
  }
  const { channel } = values;
  checkChannel(channel);
  if (values.publish) {
    if (!values.out || Object.keys(values).some(key => !['channel', 'out', 'publish'].includes(key))) {
      throw new Error('--publish accepts --channel and --out for a prepared signed bundle.');
    }
    await publishUiRelease({ channel, out: resolve(values.out) });
    console.log(`Published UI bundle to ${channel}.`);
    return;
  }
  const uiVersion = values['ui-version'];
  const minShellVersion = values['min-shell-version'];
  const maxShellVersion = values['max-shell-version'];
  semver(uiVersion);
  checkShellRange(minShellVersion, maxShellVersion);
  const policy = {
    notes: values['notes-file'] === undefined ? undefined : (await readBounded(resolve(values['notes-file']), 16 * 1024)).toString('utf8'),
    rolloutPercent: values.rollout?.trim() ? Number(values.rollout) : NaN,
    blocked: [...new Set(values.block ?? [])],
  };
  checkPolicy(policy);
  const out = resolve(values.out ?? join(ROOT, 'dist/release-ui', uiVersion, channel));
  await exec(process.execPath, [join(NATIVE, 'scripts/build-web.mjs'), '--release'], { cwd: ROOT, env: unsignedEnvironment() });
  const built = JSON.parse(await readFile(join(DIST, 'schema-version.json'), 'utf8'));
  if (!validDbSchema(built.version) || built.otaTestNoReady) throw new Error('Invalid release web database schema.');
  const artifact = await packBundle(DIST, out, { uiVersion, minShellVersion, maxShellVersion, dbSchemaVersion: built.version });
  const signature = values.sign ? await sign(out, uiVersion) : undefined;
  const path = join(out, discoveryName(channel));
  await mkdir(dirname(path), { recursive: true });
  const discovery = JSON.stringify(generateDiscovery(artifact, policy, signature), null, 2) + '\n';
  if (Buffer.byteLength(discovery) > MAX_DISCOVERY) throw new Error('UI discovery manifest exceeds size limit.');
  await writeFile(path, discovery, { flag: 'wx' });
  console.log(`Prepared ${signature ? 'signed' : 'unsigned'} UI bundle and discovery manifest in ${out}. Dry run only.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`UI release failed. ${error.code ? 'Check the local build and release files.' : error.message}`);
    process.exitCode = 1;
  });
}
