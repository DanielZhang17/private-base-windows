#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import { generateDiscovery, packBundle } from './release-ui.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const native = join(root, 'apps/native');
const signer = join(native, 'node_modules/@tauri-apps/cli/tauri.js');
const distNative = join(root, 'apps/web/dist-native');
const distNoReady = join(root, 'apps/web/dist-native-ota-no-ready');
const version = '1.0.1';
const variants = ['good', 'tampered-file', 'bad-signature', 'no-ready', 'wrong-db-schema', 'wrong-native-contract'];
const archive = `ui/${version}/bundle.tar.gz`;
const publicFiles = new Map([
  ['stable/ui.json', 'application/json'],
  ['beta/ui.json', 'application/json'],
  [archive, 'application/gzip'],
  [archive + '.sig', 'text/plain'],
]);

function runSigner(...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TAURI_SIGNING_')));
  // The signer gets only the newly generated throwaway key path. It can
  // print key material, so inherit neither its stdout nor its stderr.
  const result = spawnSync(process.execPath, [signer, 'signer', ...args], { env, stdio: 'ignore', timeout: 30_000 });
  if (result.status !== 0) throw new Error('The Tauri test signer failed. Check that the native CLI is installed.');
}

function tamperIndex(compressed) {
  const tar = gunzipSync(compressed);
  // packBundle writes USTAR regular-file entries with 512-byte alignment.
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.toString('ascii', offset, offset + 100).split('\0')[0];
    const size = parseInt(tar.toString('ascii', offset + 124, offset + 136), 8);
    if (name === 'index.html' && size > 0) {
      tar[offset + 512] ^= 1;
      return gzipSync(tar);
    }
    if (!name || !Number.isFinite(size)) break;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('The packed test archive did not contain index.html.');
}

function badSignature(encoded) {
  const lines = Buffer.from(encoded, 'base64').toString('utf8').split('\n');
  const packet = Buffer.from(lines[1], 'base64');
  packet[10] ^= 1;
  lines[1] = packet.toString('base64');
  return Buffer.from(lines.join('\n')).toString('base64');
}

async function freshOutput(out) {
  const release = resolve(homedir(), '.private-base-release');
  const forbidden = path => path === release || path.startsWith(release + sep);
  if (forbidden(out)) throw new Error('Choose a fresh test directory outside the release signing directory.');
  const actual = join(await realpath(dirname(out)), basename(out));
  if (forbidden(actual)) throw new Error('Choose a fresh test directory outside the release signing directory.');
  await mkdir(actual, { mode: 0o700 });
  return actual;
}

export async function prepareTestFeed({ out, variant, base, dist = variant === 'no-ready' ? distNoReady : distNative }) {
  if (!variants.includes(variant)) throw new Error('Unknown OTA test variant.');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash
      || url.username || url.password) throw new Error('Use a test base URL with a host and no path or credentials.');
  const schema = JSON.parse(await readFile(join(dist, 'schema-version.json'), 'utf8'));
  if (Boolean(schema.otaTestNoReady) !== (variant === 'no-ready')) {
    throw new Error('Use the --ota-test-no-ready build and the no-ready variant together.');
  }
  const contract = JSON.parse(await readFile(join(native, 'ui-bundle.json'), 'utf8'));
  const { version: shellVersion } = JSON.parse(await readFile(join(native, 'src-tauri/tauri.conf.json'), 'utf8'));
  if (schema.version !== contract.embeddedDbSchemaVersion) {
    throw new Error('Build the test assets from the same database schema as the embedded UI.');
  }
  out = await freshOutput(resolve(out));
  const feed = join(out, 'feed');
  const keys = join(out, 'keys');
  await mkdir(keys, { mode: 0o700 });
  const secret = join(keys, 'test.key');
  runSigner('generate', '--ci', '--password', '', '--write-keys', secret);
  const publicKey = Buffer.from(await readFile(secret + '.pub', 'utf8'), 'base64').toString('utf8').split(/\r?\n/)[1];

  const artifactPath = join(feed, archive);
  const artifact = await packBundle(dist, dirname(artifactPath), {
    uiVersion: version,
    minShellVersion: shellVersion,
    maxShellVersion: shellVersion,
    dbSchemaVersion: schema.version + Number(variant === 'wrong-db-schema'),
  }, {
    ...contract,
    nativeContract: contract.nativeContract + Number(variant === 'wrong-native-contract'),
  });
  if (variant === 'tampered-file') {
    const bytes = tamperIndex(await readFile(artifactPath));
    await writeFile(artifactPath, bytes);
    artifact.sha256 = createHash('sha256').update(bytes).digest('hex');
    artifact.size = bytes.length;
  }
  artifact.url = new URL(archive, url).href;
  runSigner('sign', '--password', '', '--private-key-path', secret, '--app-version', version, artifactPath);
  const sigPath = artifactPath + '.sig';
  let signature = (await readFile(sigPath, 'utf8')).trim();
  if (variant === 'bad-signature') {
    signature = badSignature(signature);
    await writeFile(sigPath, signature + '\n');
  }
  const discovery = JSON.stringify(generateDiscovery(artifact, { rolloutPercent: 100, blocked: [] }, signature), null, 2) + '\n';
  for (const channel of ['stable', 'beta']) {
    await mkdir(join(feed, channel));
    await writeFile(join(feed, channel, 'ui.json'), discovery);
  }
  return { feed, publicKey };
}

export function testFeedServer(feed) {
  return createServer(async (request, response) => {
    const path = request.url?.slice(1);
    const type = publicFiles.get(path);
    if (!type || request.method !== 'GET') {
      response.writeHead(404).end();
      return;
    }
    try {
      const contents = await readFile(join(feed, path));
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': contents.length, 'Cache-Control': 'no-store' }).end(contents);
    } catch {
      response.writeHead(404).end();
    }
  });
}

export function resolveFeedAddress(base, port) {
  if (port !== undefined && (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    throw new Error('Specify a valid listen port.');
  }
  const url = new URL(base ?? `http://127.0.0.1:${port ?? '8789'}/`);
  return {
    base: url.href,
    port: Number(port ?? (url.port || (url.protocol === 'https:' ? '443' : '80'))),
    host: url.hostname === '[::1]' ? '::1' : '127.0.0.1',
  };
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    out: { type: 'string' }, dist: { type: 'string' }, port: { type: 'string' },
    variant: { type: 'string', default: 'good' }, base: { type: 'string' },
    'prepare-only': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log(`node scripts/ota-test-feed.mjs --out NEW_DIR [--dist DIR] [--port PORT]
  [--variant ${variants.join('|')}] [--base URL] [--prepare-only]
  Listen on the port from --base (default 8789), or override it with --port.`);
    return;
  }
  if (!values.out) throw new Error('Specify --out.');
  const { base, host, port } = resolveFeedAddress(values.base, values.port);
  const { feed, publicKey } = await prepareTestFeed({ out: values.out, variant: values.variant, base, dist: values.dist });
  console.log(`OTA test base: ${base}\nOTA test public key: ${publicKey}`);
  if (!values['prepare-only']) {
    const server = testFeedServer(feed);
    server.on('request', ({ method, url }) => {
      if (method === 'GET' && publicFiles.has(url?.slice(1))) console.log(`GET ${url}`);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject).listen(port, host, resolve);
    });
    console.log(`Serving ${values.variant} on ${host} port ${port}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
