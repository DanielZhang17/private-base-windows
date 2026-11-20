import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  generateDiscovery, packBundle as packReleaseBundle, publishUiRelease as publishReleaseBundle,
  main, matchesShellSchemas, signingEnvironment, verifySignature,
} from './release-ui.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const schema = 9;
const contract = {
  nativeContract: 1, embeddedUiVersion: '1.0.0',
  shellDbSchemas: [{ nativeContract: 1, minShellVersion: '0.1.3', maxShellVersion: '0.1.3', dbSchemaVersion: schema }],
};
const options = {
  uiVersion: '1.0.1-beta.1', minShellVersion: '0.1.3', dbSchemaVersion: schema,
  maxShellVersion: '0.1.3', createdAt: '2026-10-01T00:00:00Z',
};
const packBundle = (dist, out, target) => packReleaseBundle(dist, out, target, contract);
const publishUiRelease = (target, remote, verify) => publishReleaseBundle(target, remote, verify, contract);
const policy = { rolloutPercent: 25, blocked: ['1.0.0'], notes: 'A UI change' };
const signature = Buffer.from('mock signature for publishing tests').toString('base64');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'release-ui-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, 'dist-native');
  const out = join(root, 'output');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<main>Private Base</main>');
  await writeFile(join(dist, 'assets', 'entry.js'), 'export {};');
  return { dist, out };
}

test('packs dist-native with a first-entry manifest, exact bytes and one platform-neutral URL', async t => {
  const { dist, out } = await fixture(t);
  const artifact = await packBundle(dist, out, options);
  const path = join(out, 'bundle.tar.gz');
  const inspect = (...args) => execFileSync('tar', args, { encoding: 'utf8' });
  assert.deepEqual(inspect('-tzf', path).trim().split('\n'), ['manifest.json', 'assets/entry.js', 'index.html']);
  const manifest = JSON.parse(inspect('-xOzf', path, 'manifest.json'));
  assert.deepEqual(manifest, {
    ...options, createdAt: '2026-10-01T00:00:00.000Z', nativeContract: 1, dbSchemaVersion: schema,
    files: await Promise.all(['assets/entry.js', 'index.html'].map(async path => {
      const bytes = await readFile(join(dist, path));
      return { path, sha256: hash(bytes), size: bytes.length };
    })),
  });
  for (const file of manifest.files) {
    assert.equal(hash(inspect('-xOzf', path, file.path)), file.sha256);
  }
  const bytes = await readFile(path);
  assert.deepEqual(generateDiscovery(artifact, policy, signature + '\n'), {
    uiVersion: '1.0.1-beta.1', nativeContract: 1, minShellVersion: '0.1.3', maxShellVersion: '0.1.3', dbSchemaVersion: schema,
    url: 'https://dist.718788.xyz/private-base/releases/ui/1.0.1-beta.1/bundle.tar.gz',
    sha256: hash(bytes), size: bytes.length, signature, ...policy,
  });
  assert.equal(generateDiscovery(artifact, policy).signature, null);
  assert.throws(() => generateDiscovery(artifact, { ...policy, rolloutPercent: 101 }, signature), /rollout/i);
  assert.throws(() => generateDiscovery(artifact, policy, 'not a signature!'), /\.sig/);
});

test('rejects symlinks, nonportable names, oversized assets and invalid versions', async t => {
  const { dist, out } = await fixture(t);
  const asset = join(dist, 'assets', 'entry.js');
  await assert.rejects(packBundle(dist, out, { ...options, uiVersion: '1.0.0+same' }), /exceed/);
  await assert.rejects(packBundle(dist, out, { ...options, uiVersion: '1.0.1-beta.01' }), /semantic version/);
  await assert.rejects(packBundle(dist, out, { ...options, maxShellVersion: '0.1.2' }), /precedes/);
  const link = join(dist, 'link.js');
  await symlink(asset, link, 'file');
  await assert.rejects(packBundle(dist, out, options), /regular/);
  await rm(link);
  const unsafe = join(dist, 'NUL.js');
  await writeFile(unsafe, '');
  await assert.rejects(packBundle(dist, out, options), /path/);
  await rm(unsafe);
  await truncate(asset, 16 * 1024 * 1024 + 1);
  await assert.rejects(packBundle(dist, out, options), /asset limits/);
});

test('rejects a directory that aliases the reserved manifest while packing', async t => {
  const { dist, out } = await fixture(t);
  await mkdir(join(dist, 'MANIFEST.JSON'));
  await writeFile(join(dist, 'MANIFEST.JSON', 'feature.js'), 'export {};');
  await assert.rejects(packBundle(dist, out, options), /Bundle paths collide/);
});

test('rejects file and directory prefix collisions before publishing a prepared bundle', async t => {
  const { dist, out } = await fixture(t);
  const artifact = await packBundle(dist, out, options);
  const original = JSON.parse(execFileSync('tar', [
    '-xOzf', join(out, 'bundle.tar.gz'), 'manifest.json',
  ], { encoding: 'utf8' }));
  await mkdir(join(out, 'beta'));
  await writeFile(join(out, 'bundle.tar.gz.sig'), signature);

  // A manifest fixture can exercise collisions even on a case-insensitive host.
  for (const paths of [['ASSET', 'asset/feature.js'], ['asset/feature.js', 'ASSET'],
    ['pkg/feature.js', 'PKG/other.js'], ['manifest.json/feature.js']]) {
    const manifestPath = join(out, 'manifest.json');
    const bundlePath = join(out, 'bundle.tar.gz');
    await writeFile(manifestPath, JSON.stringify({
      ...original,
      files: [...original.files, ...paths.map(path => ({ ...original.files[0], path }))],
    }));
    execFileSync('tar', ['-czf', bundlePath, 'manifest.json'], { cwd: out });
    const bytes = await readFile(bundlePath);
    await writeFile(join(out, 'beta', 'ui.json'), JSON.stringify(generateDiscovery({
      ...artifact, sha256: hash(bytes), size: bytes.length,
    }, policy, signature)));
    await assert.rejects(
      publishUiRelease({ out, channel: 'beta' }, () => assert.fail('unexpected remote call'), () => {}),
      /Bundle paths collide/,
    );
  }
});

test('publication follows both channel and immutable-object checks and publishes discovery last', async t => {
  const { dist, out } = await fixture(t);
  const artifact = await packBundle(dist, out, options);
  const path = join(out, 'beta', 'ui.json');
  await mkdir(join(out, 'beta'));
  const prepared = generateDiscovery(artifact, policy, signature);
  await writeFile(path, JSON.stringify(prepared));
  await writeFile(join(out, 'bundle.tar.gz.sig'), signature);

  const advanced = { ...contract, embeddedUiVersion: '1.0.1' };
  const noRemote = () => assert.fail('unexpected remote call');
  await assert.rejects(packReleaseBundle(dist, out, options, advanced), /exceed the embedded version/);
  await assert.rejects(
    publishReleaseBundle({ out, channel: 'beta' }, noRemote, () => {}, advanced),
    /Invalid UI discovery manifest/,
  );

  const calls = [];
  const remote = async ([method, key, , file, ...headers]) => {
    calls.push([method, key]);
    if (method === 'get' && key.endsWith('/stable/ui.json')) {
      await writeFile(file, JSON.stringify({ uiVersion: '1.0.1-beta.0' }));
      return {};
    }
    if (method === 'get') return { missing: true };
    const contents = await readFile(file);
    if (key.endsWith('bundle.tar.gz')) assert.equal(hash(contents), artifact.sha256);
    if (key.endsWith('.sig')) assert.equal(contents.toString(), signature);
    if (key.endsWith('ui.json')) assert.deepEqual(JSON.parse(contents), prepared);
    assert.match(headers.at(-1), key.endsWith('ui.json') ? /must-revalidate/ : /immutable/);
  };
  await publishUiRelease({ out, channel: 'beta' }, remote, () => {});
  const prefix = 'dist/private-base/releases/';
  assert.deepEqual(calls, [
    ['get', prefix + 'stable/ui.json'], ['get', prefix + 'beta/ui.json'],
    ['get', prefix + 'ui/1.0.1-beta.1/bundle.tar.gz'],
    ['get', prefix + 'ui/1.0.1-beta.1/bundle.tar.gz.sig'],
    ['put', prefix + 'ui/1.0.1-beta.1/bundle.tar.gz'],
    ['put', prefix + 'ui/1.0.1-beta.1/bundle.tar.gz.sig'],
    ['put', prefix + 'beta/ui.json'],
  ]);

  await assert.rejects(publishUiRelease({ out, channel: 'beta' }, async ([method, key, , file]) => {
    assert.equal(method, 'get');
    if (!key.endsWith('stable/ui.json')) return { missing: true };
    await writeFile(file, JSON.stringify({ uiVersion: '1.0.1-beta.1+different-build' }));
    return {};
  }, () => {}), /increase across both channels/);

  await assert.rejects(publishUiRelease({ out, channel: 'beta' }, async ([method, key, , file]) => {
    assert.equal(method, 'get');
    if (!key.endsWith('.sig')) return { missing: true };
    await writeFile(file, 'x'.repeat(signature.length));
    return {};
  }, () => {}), /overwrite immutable/);

  const uploaded = new Map();
  const writes = [];
  let interrupt = true;
  const resumeRemote = async ([method, key, , file]) => {
    if (method === 'get') {
      if (!uploaded.has(key)) return { missing: true };
      await writeFile(file, uploaded.get(key));
      return {};
    }
    writes.push(key);
    if (key.endsWith('.sig') && interrupt) throw new Error('mock write error');
    uploaded.set(key, await readFile(file));
  };
  const publish = () => publishUiRelease({ out, channel: 'beta' }, resumeRemote, () => {});
  const bundleObject = prefix + 'ui/1.0.1-beta.1/bundle.tar.gz';
  const discoveryObject = prefix + 'beta/ui.json';
  await assert.rejects(publish(), /mock write error/);
  assert.deepEqual([...uploaded.keys()], [bundleObject]);
  interrupt = false;
  writes.length = 0;
  await publish();
  assert.deepEqual(writes, [bundleObject + '.sig', discoveryObject]);
  writes.length = 0;
  await publish();
  assert.deepEqual(writes, []);

  await writeFile(path, JSON.stringify(generateDiscovery(artifact, policy)));
  await assert.rejects(publishUiRelease({ out, channel: 'beta' }, () => assert.fail('unexpected remote call')), /\.sig/);

  await writeFile(path, JSON.stringify(prepared));
  await writeFile(join(out, 'bundle.tar.gz'), Buffer.alloc(artifact.size));
  await assert.rejects(publishUiRelease({ out, channel: 'beta' }, () => assert.fail('unexpected remote call')), /differs/);
});

const vectorPublicKey = Buffer.from(
  'untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3',
).toString('base64');
const vectorSignature = [
  'untrusted comment: signature from minisign secret key',
  'RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=',
  'trusted comment: timestamp:1633700835\tfile:test\tprehashed',
  'wLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==',
].join('\n');
const encodedVector = Buffer.from(vectorSignature).toString('base64');

test('passes the supervised filename to the standalone signer as a path only', () => {
  assert.deepEqual(signingEnvironment({
    PATH: '/bin', TAURI_SIGNING_PRIVATE_KEY: '/fake/example.key',
    TAURI_SIGNING_PRIVATE_KEY_PATH: '/fake/stale.key', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'fixture',
  }), {
    PATH: '/bin', TAURI_SIGNING_PRIVATE_KEY_PATH: '/fake/example.key',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'fixture',
  });
});

test('verifies a public Minisign vector including its trusted comment and rejects the test key against the release pin', () => {
  const data = Buffer.from('test');
  assert.doesNotThrow(() => verifySignature(data, encodedVector, vectorPublicKey));
  assert.throws(() => verifySignature(Buffer.from('tampered'), encodedVector, vectorPublicKey), /pinned updater/);
  const tampered = Buffer.from(vectorSignature.replace('file:test', 'file:fake')).toString('base64');
  assert.throws(() => verifySignature(data, tampered, vectorPublicKey), /pinned updater/);
  const lines = vectorSignature.split('\n');
  const packet = Buffer.from(lines[1], 'base64');
  packet[0] |= 0x80;
  lines[1] = packet.toString('base64');
  assert.throws(() => verifySignature(data, Buffer.from(lines.join('\n')).toString('base64'), vectorPublicKey), /pinned updater/);
  assert.throws(() => verifySignature(data, encodedVector), /pinned updater/);
});

test('rejects a bundle prepared with a foreign signature before contacting distribution', async t => {
  const { dist, out } = await fixture(t);
  const artifact = await packBundle(dist, out, options);
  await mkdir(join(out, 'beta'));
  await writeFile(join(out, 'beta', 'ui.json'), JSON.stringify(generateDiscovery(artifact, policy, encodedVector)));
  await writeFile(join(out, 'bundle.tar.gz.sig'), encodedVector);
  await assert.rejects(
    publishUiRelease({ out, channel: 'beta' }, () => assert.fail('unexpected remote call')),
    /pinned updater public key/,
  );
});

test('rejects a prepared no-ready bundle before contacting distribution', async t => {
  const { dist, out } = await fixture(t);
  await writeFile(join(dist, 'schema-version.json'), JSON.stringify({ version: schema, otaTestNoReady: true }));
  const artifact = await packBundle(dist, out, options);
  await mkdir(join(out, 'beta'));
  await writeFile(join(out, 'beta', 'ui.json'), JSON.stringify(generateDiscovery(artifact, policy, signature)));
  await writeFile(join(out, 'bundle.tar.gz.sig'), signature);
  await assert.rejects(
    publishUiRelease({ out, channel: 'beta' }, () => assert.fail('unexpected remote call'), () => {}),
    /an OTA release cannot contain the no-ready fixture/,
  );
});

test('rejects signed archives with missing, unexpected or tampered entries before contacting distribution', async t => {
  const { dist, out } = await fixture(t);
  const artifact = await packBundle(dist, out, options);
  const bundle = join(out, 'bundle.tar.gz');
  const manifest = execFileSync('tar', ['-xOzf', bundle, 'manifest.json']);
  await writeFile(join(dist, 'manifest.json'), manifest);
  await writeFile(join(dist, 'extra.js'), 'unexpected');
  await mkdir(join(out, 'beta'));
  await writeFile(join(out, 'bundle.tar.gz.sig'), signature);
  const entries = ['manifest.json', 'assets/entry.js', 'index.html'];

  for (const [paths, error] of [
    [entries.slice(0, 2), /missing tar entries/],
    [[...entries, 'extra.js'], /unexpected tar entry/],
    [entries, /bundle asset hash or size mismatch/],
  ]) {
    if (paths === entries) await writeFile(join(dist, 'index.html'), '<main>Private base</main>');
    execFileSync('tar', ['-czf', bundle, '--format=ustar', ...paths], { cwd: dist });
    const bytes = await readFile(bundle);
    await writeFile(join(out, 'beta', 'ui.json'), JSON.stringify(generateDiscovery({
      ...artifact, sha256: hash(bytes), size: bytes.length,
    }, policy, signature)));
    await assert.rejects(
      publishUiRelease({ out, channel: 'beta' }, () => assert.fail('unexpected remote call'), () => {}),
      error,
    );
  }
});

test('rejects older and newer declared schemas before contacting distribution', async t => {
  const remote = () => assert.fail('unexpected remote call');
  for (const dbSchemaVersion of [schema - 1, schema + 1]) {
    const { dist, out } = await fixture(t);
    const artifact = await packBundle(dist, out, { ...options, dbSchemaVersion });
    await mkdir(join(out, 'beta'));
    const discovery = join(out, 'beta', 'ui.json');
    const feed = generateDiscovery(artifact, policy, signature);
    await writeFile(join(out, 'bundle.tar.gz.sig'), signature);
    await writeFile(discovery, JSON.stringify(feed));
    await assert.rejects(
      publishUiRelease({ out, channel: 'beta' }, remote, () => {}),
      /database schema must match every shell/,
    );

    await writeFile(discovery, JSON.stringify({ ...feed, dbSchemaVersion: schema }));
    await assert.rejects(
      publishUiRelease({ out, channel: 'beta' }, remote, () => {}),
      /manifest differs from discovery/,
    );
  }
});

test('requires a documented exact schema match across the full targeted range', () => {
  const known = [
    { nativeContract: 1, minShellVersion: '0.1.3', maxShellVersion: '0.1.4', dbSchemaVersion: 9 },
    { nativeContract: 1, minShellVersion: '0.1.5', maxShellVersion: '0.1.6', dbSchemaVersion: 10 },
    { nativeContract: 1, minShellVersion: '0.1.6', maxShellVersion: '0.1.8', dbSchemaVersion: 10 },
    { nativeContract: 2, minShellVersion: '0.1.8', maxShellVersion: '0.1.9', dbSchemaVersion: 10 },
  ];
  const target = { nativeContract: 1, minShellVersion: '0.1.5', maxShellVersion: '0.1.8', dbSchemaVersion: 10 };
  assert.ok(matchesShellSchemas(target, known));
  assert.ok(matchesShellSchemas({ ...target, ...options }, known));
  for (const patch of [
    { dbSchemaVersion: 9 },
    { minShellVersion: '0.1.4' },
    { minShellVersion: '0.1.4', dbSchemaVersion: 9 },
    { maxShellVersion: '0.1.9' },
    { maxShellVersion: undefined },
  ]) {
    assert.ok(!matchesShellSchemas({ ...target, ...patch }, known));
  }
  const overlap = { nativeContract: 1, minShellVersion: '0.1.7', maxShellVersion: '0.1.7', dbSchemaVersion: 9 };
  assert.ok(!matchesShellSchemas(target, [...known, overlap]));
});

test('rejects an unbounded offer before contacting distribution', async t => {
  const { dist, out } = await fixture(t);
  const artifact = await packBundle(dist, out, { ...options, maxShellVersion: undefined });
  await mkdir(join(out, 'beta'));
  const discovery = join(out, 'beta', 'ui.json');
  const feed = generateDiscovery(artifact, policy, signature);
  await writeFile(join(out, 'bundle.tar.gz.sig'), signature);
  await writeFile(discovery, JSON.stringify(feed));
  const remote = () => assert.fail('unexpected remote call');
  await assert.rejects(publishUiRelease({ out, channel: 'beta' }, remote, () => {}), /documented, bounded range/);

  await writeFile(discovery, JSON.stringify({ ...feed, maxShellVersion: options.minShellVersion }));
  await assert.rejects(publishUiRelease({ out, channel: 'beta' }, remote, () => {}), /manifest differs from discovery/);
});

test('rejects the former migration override', async () => {
  await assert.rejects(main(['--publish', '--channel', 'beta', '--out', 'unused', '--allow-db-migration']), {
    code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION',
  });
});
