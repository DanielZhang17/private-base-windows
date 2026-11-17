import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { androidVersionCode, collectArtifacts, generateManifests, main, parseArgs, publishRelease, validateDownloadManifest } from './release.mjs';

const options = { version: '0.1.1', channel: 'stable', rollout: 25, minimum: '0.1.0', blocked: ['0.1.0'], notes: 'Release notes', pubDate: '2026-11-16T20:00:00Z' };
const artifact = (target, kind, file) => ({ target, kind, file, size: 100, sha256: 'a'.repeat(64), signature: kind === 'update' ? 'signature' : undefined });
const artifacts = [
  artifact('darwin-aarch64', 'installer', 'PrivateBase-arm64.dmg'), artifact('darwin-aarch64', 'update', 'PrivateBase-arm64.app.tar.gz'),
  artifact('darwin-x86_64', 'installer', 'PrivateBase-x64.dmg'), artifact('darwin-x86_64', 'update', 'PrivateBase-x64.app.tar.gz'),
  artifact('windows-x86_64', 'update', 'PrivateBase-setup.exe'), artifact('android', 'installer', 'PrivateBase.apk'),
];
test('generates exact target manifests, policy, signatures and immutable URLs', () => {
  const result = generateManifests(options, artifacts);
  for (const target of ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']) {
    const value = result[`stable/updater/${target}.json`];
    assert.deepEqual(Object.keys(value.platforms), [target]);
    assert.equal(value.version, '0.1.1'); assert.equal(value.rolloutPercent, 25); assert.equal(value.minimumVersion, '0.1.0');
    assert.deepEqual(value.blocked, ['0.1.0']); assert.equal(value.notes, 'Release notes'); assert.equal(value.pub_date, '2026-11-16T20:00:00.000Z');
    assert.equal(value.platforms[target].signature, 'signature');
    assert.match(value.platforms[target].url, /^https:\/\/dist\.718788\.xyz\/private-base\/releases\/0\.1\.1\//);
  }
  assert.deepEqual(result['stable/android.json'], {
    versionName: '0.1.1', versionCode: 1001, url: 'https://dist.718788.xyz/private-base/releases/0.1.1/PrivateBase.apk',
    sha256: 'a'.repeat(64), size: 100, minSdk: 24, notes: 'Release notes', pub_date: '2026-11-16T20:00:00.000Z', rolloutPercent: 25, minimumVersion: '0.1.0', blocked: ['0.1.0'],
  });
});
test('preserves the live download-page shape on stable, and never emits latest.json on beta', () => {
  const stable = generateManifests(options, artifacts)['latest.json'];
  assert.deepEqual(Object.keys(stable), ['product', 'version', 'published', 'platforms']);
  assert.deepEqual(Object.keys(stable.platforms), ['macos', 'android', 'windows', 'ios']);
  assert.deepEqual(Object.keys(stable.platforms.macos), ['file', 'url', 'size', 'sha256', 'arch', 'minOs', 'signed']);
  assert.equal(stable.platforms.macos.arch, 'arm64'); assert.equal(stable.platforms.ios, null);
  const beta = generateManifests({ ...options, channel: 'beta' }, artifacts);
  assert.equal(beta['latest.json'], undefined); assert.equal(Object.keys(beta).length, 4);
  assert.ok(beta['beta/android.json']);
});
test('rejects unsafe output names instead of generating a manifest the download page rejects', () => {
  for (const file of ['Private Base_0.1.1_x64-setup.exe', 'x'.repeat(201), '.hidden.apk']) {
    assert.throws(() => generateManifests(options, [{ ...artifacts[4], file }]), /file/);
  }
});
test('supports partial releases, zero rollout and a blocked current candidate', () => {
  const result = generateManifests({ ...options, rollout: 0, blocked: ['0.1.1'] }, [artifacts[5]]);
  assert.equal(Object.keys(result).length, 2); assert.equal(result['latest.json'].platforms.macos, null);
  assert.deepEqual(result['stable/android.json'].blocked, ['0.1.1']);
});
test('uses monotonic Tauri semver-derived Android codes within allowed components', () => {
  assert.equal(androidVersionCode('0.1.0'), 1000); assert.equal(androidVersionCode('1.2.3'), 1002003);
  assert.ok(androidVersionCode('1.0.0') > androidVersionCode('0.999.999'));
  for (const version of ['0.1.1000', '0.1000.0', '2101.0.0', '0.0.0']) assert.throws(() => androidVersionCode(version));
});
test('rejects invalid versions, rollout, minimum, channels, artifacts and signatures', () => {
  for (const patch of [{ version: '0.0.1' }, { version: '0.1.1-beta' }, { version: '01.1.1' }, { rollout: -1 }, { rollout: 101 }, { rollout: 1.5 }, { channel: 'nightly' }, { minimum: '0.2.0' }, { blocked: ['invalid'] }, { minSdk: 23 }]) assert.throws(() => generateManifests({ ...options, ...patch }, artifacts));
  assert.throws(() => generateManifests(options, [{ ...artifacts[1], signature: '' }]));
  assert.throws(() => generateManifests(options, [{ ...artifacts[1], file: '../bad' }]));
  assert.throws(() => generateManifests(options, [artifacts[1], artifacts[1]]));
});
test('collects actual hashes/sizes and .sig files, refusing incomplete groups', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'release-test-'));
  try {
    const exe = join(dir, 'Private Base_0.1.1_x64-setup.exe'), sig = `${exe}.sig`;
    await writeFile(exe, 'built installer'); await writeFile(sig, 'c2lnbmF0dXJl\n');
    const files = await collectArtifacts({ version: '0.1.1', windows: exe, 'windows-sig': sig });
    assert.equal(files[0].sha256, createHash('sha256').update('built installer').digest('hex'));
    assert.equal(files[0].file, 'PrivateBase-0.1.1-windows-x64-setup.exe');
    assert.equal(files[1].file, 'PrivateBase-0.1.1-windows-x64-setup.exe.sig');
    assert.equal(files[0].path, exe);
    assert.equal(files[0].size, 15); assert.equal(files[0].signature, 'c2lnbmF0dXJl'); assert.equal(files[1].kind, 'signature');
    await assert.rejects(collectArtifacts({ version: '0.1.1', windows: exe }), /Provide all/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('CLI dry run writes manifests locally without invoking Wrangler', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'release-test-'));
  try {
    const apk = join(dir, 'PrivateBase.apk'); await writeFile(apk, 'built signed APK fixture');
    await main(['--version', '0.1.0', '--channel', 'beta', '--rollout', '5', '--android', apk, '--out', dir]);
    const manifest = JSON.parse(await readFile(join(dir, 'beta/android.json'), 'utf8'));
    assert.equal(manifest.versionCode, 1000); assert.equal(manifest.rolloutPercent, 5);
    await assert.rejects(readFile(join(dir, 'latest.json')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('publish refuses existing immutable objects before any upload and fails closed on read errors', async () => {
  let puts = 0;
  const config = { version: '0.1.1', artifacts: [{ ...artifacts[5], path: '/unused' }], manifests: {}, out: '/unused' };
  await assert.rejects(publishRelease(config, async args => {
    if (args[0] === 'put') puts++;
    return { missing: false };
  }), /Refusing to overwrite/);
  assert.equal(puts, 0);
  await assert.rejects(publishRelease(config, async args => {
    if (args[0] === 'put') puts++;
    return { missing: args[1].endsWith('release.json') };
  }), /Refusing to overwrite.*PrivateBase.apk/);
  assert.equal(puts, 0);
  await assert.rejects(publishRelease(config, async () => { throw new Error('network'); }), /network/);
  assert.equal(puts, 0);
});
test('publish orders artifacts before discovery and never changes beta latest.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'release-test-'));
  try {
    const manifests = generateManifests({ ...options, channel: 'beta' }, [artifacts[5]]);
    const calls = [];
    await publishRelease({ version: '0.1.1', artifacts: [{ ...artifacts[5], path: '/fixture.apk' }], manifests, out: dir }, async args => { calls.push(args); return { missing: true }; });
    const puts = calls.filter(args => args[0] === 'put');
    assert.equal(puts[0][1], 'dist/private-base/releases/0.1.1/PrivateBase.apk');
    assert.equal(puts[1][1], 'dist/private-base/releases/0.1.1/release.json');
    assert.equal(puts[2][1], 'dist/private-base/releases/beta/android.json');
    assert.equal(calls.some(args => args[1].endsWith('latest.json')), false);
    assert.ok(puts[0].includes('public, max-age=31536000, immutable'));
    assert.ok(puts[2].includes('no-cache, max-age=0, must-revalidate'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('publication stops before pointers if any artifact upload fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'release-test-'));
  try {
    const calls = [];
    await assert.rejects(publishRelease({ version: '0.1.1', artifacts: [{ ...artifacts[5], path: '/fixture.apk' }], manifests: { 'stable/android.json': {} }, out: dir }, async args => {
      calls.push(args); if (args[0] === 'put') throw new Error('upload failed'); return { missing: true };
    }), /upload failed/);
    assert.equal(calls.some(args => args[1].endsWith('stable/android.json')), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('parses repeated blocks, keeps dry run default and rejects unknown/duplicate options', () => {
  assert.equal(parseArgs([]).publish, false);
  assert.deepEqual(parseArgs(['--block', '0.1.1', '--block', '0.1.2']).block, ['0.1.1', '0.1.2']);
  assert.throws(() => parseArgs(['--url', 'https://elsewhere.example']));
  assert.throws(() => parseArgs(['--version', '0.1.1', '--version', '0.1.2']));
});

test('enforces the download consumer metadata and size boundaries on both channels', () => {
  for (const channel of ['stable', 'beta']) {
    for (const patch of [
      { androidArch: 'arm64-v8a,armeabi-v7a' }, { androidArch: 'a'.repeat(33) }, { androidArch: ' arm64' },
      { macMinOs: ' macOS 12.3' }, { windowsMinOs: 'Windows 10 ' }, { macMinOs: 'x'.repeat(65) },
      { macMinOs: 'macOS\n12.3' }, { windowsMinOs: '<Windows>' },
    ]) assert.throws(() => generateManifests({ ...options, channel, ...patch }, artifacts));
    assert.throws(() => generateManifests({ ...options, channel }, [{ ...artifacts[5], size: 1099511627777 }]), /size/);
  }
  const manifest = generateManifests({ ...options, androidArch: 'a'.repeat(32), macMinOs: 'x'.repeat(64) }, [{ ...artifacts[5], size: 2 ** 40 }])['latest.json'];
  assert.doesNotThrow(() => validateDownloadManifest(manifest));
});
test('refuses invalid discovery manifests and artifact metadata before contacting R2', async () => {
  const valid = generateManifests(options, artifacts)['latest.json'];
  for (const patch of [{ file: 'Private Base.exe' }, { arch: 'arm64-v8a,armeabi-v7a' }, { minOs: ' Windows 10' }, { size: 1099511627777 }, { url: 'https://elsewhere.example/app.exe' }]) {
    const latest = structuredClone(valid); Object.assign(latest.platforms.windows, patch);
    let calls = 0;
    await assert.rejects(publishRelease({ version: '0.1.1', artifacts, manifests: { 'latest.json': latest }, out: '/unused' }, async () => { calls++; }));
    assert.equal(calls, 0);
  }
  let calls = 0;
  await assert.rejects(publishRelease({ version: '0.1.1', artifacts: [{ ...artifacts[5], size: 2 ** 40 + 1 }], manifests: {}, out: '/unused' }, async () => { calls++; }));
  assert.equal(calls, 0);
});

// Execute the actual consumer validator, stripping its types with the repo's compiler.
// The release CLI itself remains plain Node; no browser build or additional dependency is needed.
async function loadTypeScript(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}
test('the actual /clients validator accepts CLI output and agrees with producer boundary checks', async () => {
  const { parseReleaseManifest } = await loadTypeScript('../apps/web/src/features/clients/manifest.ts');
  const { LATEST } = await loadTypeScript('../apps/web/src/features/clients/manifest.fixture.ts');
  const dir = await mkdtemp(join(tmpdir(), 'release-consumer-'));
  try {
    const inputs = [
      ['--macos-aarch64-dmg', 'Private Base_0.1.1_aarch64.dmg'],
      ['--macos-aarch64-update', 'Private Base_0.1.1_aarch64.app.tar.gz'],
      ['--macos-aarch64-sig', 'Private Base_0.1.1_aarch64.app.tar.gz.sig'],
      ['--macos-x86_64-dmg', 'Private Base_0.1.1_x64.dmg'],
      ['--macos-x86_64-update', 'Private Base_0.1.1_x64.app.tar.gz'],
      ['--macos-x86_64-sig', 'Private Base_0.1.1_x64.app.tar.gz.sig'],
      ['--windows', 'Private Base_0.1.1_x64-setup.exe'],
      ['--windows-sig', 'Private Base_0.1.1_x64-setup.exe.sig'],
      ['--android', 'app universal release.apk'],
    ];
    for (const [, name] of inputs) await writeFile(join(dir, name), name.endsWith('.sig') ? 'c2lnbmF0dXJl' : 'signed artifact fixture');
    await main(['--version', '0.1.1', '--channel', 'stable', '--rollout', '100', '--out', dir,
      '--macos-min-os', 'x'.repeat(64), '--windows-min-os', 'x'.repeat(64),
      ...inputs.flatMap(([arg, name]) => [arg, join(dir, name)])]);
    const raw = JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8'));
    const manifest = parseReleaseManifest(raw);
    for (const platform of ['macos', 'windows', 'android']) {
      assert.equal(manifest.platforms[platform].file, LATEST.platforms[platform].file.replace(LATEST.version, '0.1.1'));
      assert.equal(manifest.platforms[platform].url, LATEST.platforms[platform].url.replaceAll(LATEST.version, '0.1.1'));
    }
    const intel = JSON.parse(await readFile(join(dir, 'stable/updater/darwin-x86_64.json'), 'utf8'));
    assert.match(intel.platforms['darwin-x86_64'].url, /PrivateBase-0.1.1-macos-x64.app.tar.gz$/);
    for (const patch of [
      { file: 'Private Base.exe' }, { file: 'a'.repeat(201) }, { arch: 'arm64-v8a,armeabi-v7a' }, { arch: 'a'.repeat(33) },
      { minOs: ' macOS 12.3' }, { minOs: 'macOS 12.3 ' }, { minOs: 'x'.repeat(65) }, { minOs: '<Windows>' }, { minOs: 'macOS\n12' },
      { size: 1099511627777 }, { size: 0 }, { size: 1.5 }, { sha256: 'z'.repeat(64) }, { url: 'https://elsewhere.example/app.exe' },
    ]) {
      const invalid = structuredClone(raw); Object.assign(invalid.platforms.windows, patch);
      assert.throws(() => parseReleaseManifest(invalid)); assert.throws(() => validateDownloadManifest(invalid));
    }
    const boundary = structuredClone(raw);
    Object.assign(boundary.platforms.windows, { file: 'a'.repeat(200), size: 2 ** 40, minOs: 'x'.repeat(64), arch: 'a'.repeat(32), sha256: 'A'.repeat(64) });
    assert.doesNotThrow(() => parseReleaseManifest(boundary)); assert.doesNotThrow(() => validateDownloadManifest(boundary));
    // Publication uses the canonical object keys but reads the original bytes and signatures.
    const built = await collectArtifacts({ version: '0.1.1', windows: join(dir, inputs[6][1]), 'windows-sig': join(dir, inputs[7][1]) });
    const calls = [];
    await publishRelease({ version: '0.1.1', artifacts: built, manifests: generateManifests(options, built), out: dir }, async args => { calls.push(args); return { missing: true }; });
    const upload = calls.find(args => args[0] === 'put');
    assert.equal(upload[1], 'dist/private-base/releases/0.1.1/PrivateBase-0.1.1-windows-x64-setup.exe');
    assert.equal(upload[3], join(dir, inputs[6][1]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
