import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { androidVersionCode, collectArtifacts, generateManifests, main, parseArgs, publishRelease, RELEASE_BASE, validateDownloadManifest } from './release.mjs';

const options = { version: '0.1.1', channel: 'stable', rollout: 25, minimum: '0.1.0', blocked: ['0.1.0'], notes: 'Release notes', pubDate: '2026-11-16T20:00:00Z' };
const notesMarkdown = '## Highlights\n- **Faster** downloads.\n- Read [the guide](https://example.com/guide).\n';
const stableOptions = { ...options, notesMarkdown };
const notesKey = 'dist/private-base/releases/notes.json';
const releaseKey = name => `dist/private-base/releases/${name}`;
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
test('stable generates Markdown for actual platforms and both channels use bounded plain text for native notes', () => {
  const stable = generateManifests(stableOptions, artifacts);
  assert.deepEqual(stable['notes.json'], {
    product: 'Private Base',
    entries: [{ version: '0.1.1', published: '2026-11-16T20:00:00.000Z', notes: notesMarkdown, platforms: ['macos', 'windows', 'android'] }],
  });
  const plain = 'Highlights\n\n- Faster downloads.\n- Read the guide.';
  assert.equal(stable['stable/updater/windows-x86_64.json'].notes, plain);
  assert.equal(stable['stable/android.json'].notes, plain);
  const beta = generateManifests({ ...stableOptions, channel: 'beta' }, artifacts);
  assert.equal(beta['beta/android.json'].notes, plain);
  assert.equal(beta['notes.json'], undefined);
  const oversized = 'x' + 'é'.repeat(8_192);
  const truncated = generateManifests({ ...stableOptions, channel: 'beta', notesMarkdown: oversized }, [artifacts[5]])['beta/android.json'].notes;
  assert.equal(truncated, oversized.slice(0, -1));
  assert.equal(Buffer.byteLength(truncated), 16_383);
  assert.throws(() => generateManifests({ ...stableOptions, notesMarkdown: oversized }, artifacts), /Invalid release notes: notes/);
});
test('strips only supported Markdown delimiters from native notes on both channels', () => {
  const markdown = '## What changed\n- Run **new_release_command** or read [release_setup_guide](https://example.com/guide).\n- Keep **a _nested_ span** and _literal_ as written.';
  const plain = 'What changed\n\n- Run new_release_command or read release_setup_guide.\n- Keep **a _nested_ span** and _literal_ as written.';
  for (const channel of ['stable', 'beta']) {
    const manifests = generateManifests({ ...options, channel, notesMarkdown: markdown }, artifacts);
    assert.equal(manifests[`${channel}/updater/windows-x86_64.json`].notes, plain);
    assert.equal(manifests[`${channel}/android.json`].notes, plain);
    if (channel === 'stable') assert.equal(manifests['notes.json'].entries[0].notes, markdown);
  }
});
test('native notes format issue references and preserve multiline HTML comments', () => {
  const comment = '<!-- hidden\n## Keep this literal\n\n- [Keep this literal](https://example.com)\n-->';
  const markdown = `## Changes\n- #123: Fixed **downloads**\n- ${comment} **Visible**\n\n#456: See [the guide](https://example.com/guide).`;
  const plain = `Changes\n\n- #123: Fixed downloads\n- ${comment} Visible\n\n#456: See the guide.`;
  const manifests = generateManifests({ ...stableOptions, notesMarkdown: markdown }, artifacts);
  assert.equal(manifests['stable/android.json'].notes, plain);
  assert.equal(manifests['stable/updater/windows-x86_64.json'].notes, plain);
  assert.equal(manifests['notes.json'].entries[0].notes, markdown);
});
test('Android OS label defaults from minSdk and can be overridden without changing the updater minSdk', () => {
  const builds = [artifacts[5]];
  const defaults = generateManifests(options, builds);
  assert.equal(defaults['latest.json'].platforms.android.minOs, 'Android 7.0');
  assert.equal(defaults['stable/android.json'].minSdk, 24);
  const higher = generateManifests({ ...options, minSdk: 26 }, builds);
  assert.equal(higher['latest.json'].platforms.android.minOs, 'Android API 26');
  const override = generateManifests({ ...options, minSdk: 26, androidMinOs: 'Android 8.0' }, builds);
  assert.equal(override['latest.json'].platforms.android.minOs, 'Android 8.0');
  assert.equal(override['stable/android.json'].minSdk, 26);
  assert.throws(() => generateManifests({ ...options, androidMinOs: '<Android>' }, builds), /androidMinOs/);
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
test('full-app CLI uses the app version and preserves the embedded UI declaration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'release-test-'));
  try {
    const declaration = new URL('../apps/native/ui-bundle.json', import.meta.url);
    const uiMetadata = await readFile(declaration, 'utf8');
    const apk = join(dir, 'PrivateBase.apk'); await writeFile(apk, 'built signed APK fixture');
    await main(['--version', '0.1.0', '--channel', 'beta', '--rollout', '5', '--android', apk, '--out', dir],
      () => assert.fail('dry run contacted distribution'));
    const manifest = JSON.parse(await readFile(join(dir, 'beta/android.json'), 'utf8'));
    assert.equal(manifest.versionName, '0.1.0');
    assert.notEqual(manifest.versionName, JSON.parse(uiMetadata).embeddedUiVersion);
    assert.equal(await readFile(declaration, 'utf8'), uiMetadata);
    assert.equal(manifest.versionCode, 1000); assert.equal(manifest.rolloutPercent, 5);
    await assert.rejects(readFile(join(dir, 'latest.json')));
    await assert.rejects(readFile(join(dir, 'notes.json')));
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
    const manifests = generateManifests({ ...stableOptions, channel: 'beta' }, [artifacts[5]]);
    const calls = [];
    await publishRelease({ version: '0.1.1', artifacts: [{ ...artifacts[5], path: '/fixture.apk' }], manifests, out: dir }, async args => { calls.push(args); return { missing: true }; });
    const puts = calls.filter(args => args[0] === 'put');
    assert.equal(puts[0][1], 'dist/private-base/releases/0.1.1/PrivateBase.apk');
    assert.equal(puts[1][1], 'dist/private-base/releases/0.1.1/release.json');
    assert.equal(puts[2][1], 'dist/private-base/releases/beta/android.json');
    assert.equal(calls.some(args => args[1].endsWith('latest.json')), false);
    assert.equal(calls.some(args => args[1] === notesKey), false);
    assert.ok(puts[0].includes('public, max-age=31536000, immutable'));
    assert.ok(puts[2].includes('no-cache, max-age=0, must-revalidate'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('publication stops before pointers if any artifact upload fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'release-test-'));
  try {
    const calls = [];
    const manifests = generateManifests(stableOptions, [artifacts[5]]);
    await assert.rejects(publishRelease({ version: '0.1.1', artifacts: [{ ...artifacts[5], path: '/fixture.apk' }], manifests, out: dir }, async args => {
      calls.push(args); if (args[0] === 'put') throw new Error('upload failed'); return { missing: true };
    }), /upload failed/);
    assert.equal(calls.some(args => args[1].endsWith('stable/android.json')), false);
    assert.equal(calls.some(args => args[0] === 'put' && args[1] === notesKey), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stable requires notes before contacting R2', async () => {
  await assert.rejects(main(['--version', '0.1.1', '--channel', 'stable', '--rollout', '100', '--publish']), /requires --notes-file/);
  const manifests = generateManifests(options, [artifacts[5]]);
  await assert.rejects(publishRelease({ version: '0.1.1', artifacts: [artifacts[5]], manifests, out: '/unused' }, async () => {
    assert.fail('R2 should not be contacted');
  }), /requires --notes-file/);
});

test('stable appends or replaces only its own notes, after artifacts and latest.json', async () => {
  const { parseReleaseNotes } = await loadTypeScript('../apps/web/src/features/clients/releaseNotes.ts');
  const dir = await mkdtemp(join(tmpdir(), 'release-notes-'));
  try {
    const config = { version: '0.1.1', artifacts: [{ ...artifacts[5], path: '/fixture.apk' }], manifests: generateManifests(stableOptions, [artifacts[5]]), out: dir };
    const current = config.manifests['notes.json'].entries[0];
    const newer = { ...current, version: '0.1.2', published: '2026-11-18T22:15:00-05:00', notes: '## Unchanged\r\n', platforms: ['ios', 'macos'] };
    const older = { ...current, version: '0.1.0', published: '2026-11-15T22:15:00Z', notes: '-- literal text\n\n', platforms: ['windows'] };
    for (const previous of [null, [newer, older], [newer, { ...current, notes: 'Old text' }, older]]) {
      const calls = [];
      let uploaded;
      await publishRelease(config, async args => {
        calls.push(args);
        if (args[1] !== notesKey) return { missing: args[0] === 'get' };
        if (args[0] === 'put') {
          uploaded = parseReleaseNotes(JSON.parse(await readFile(args[3], 'utf8')));
          return {};
        }
        if (previous === null) return { missing: true };
        await writeFile(args[3], JSON.stringify({ product: 'Private Base', entries: previous }));
        return { missing: false };
      });
      const firstPut = calls.findIndex(args => args[0] === 'put');
      assert.ok(calls.findIndex(args => args[0] === 'get' && args[1] === notesKey) < firstPut);
      assert.deepEqual(calls.slice(firstPut).map(args => args[1]), [
        'dist/private-base/releases/0.1.1/PrivateBase.apk', 'dist/private-base/releases/0.1.1/release.json',
        'dist/private-base/releases/stable/android.json', 'dist/private-base/releases/latest.json', notesKey,
      ]);
      assert.deepEqual(uploaded.entries, previous === null ? [current] : [newer, current, older]);
      assert.ok(calls.at(-1).includes('no-cache, max-age=0, must-revalidate'));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stable fails closed on notes read errors, malformed archives and history overflow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'release-notes-'));
  try {
    const config = { version: '0.1.1', artifacts: [artifacts[5]], manifests: generateManifests(stableOptions, [artifacts[5]]), out: dir };
    const full = Array.from({ length: 100 }, (_, index) => ({ ...config.manifests['notes.json'].entries[0], version: `0.2.${index}` }));
    for (const body of [undefined, 'not JSON', '{"product":"Private Base","entries":[null]}', JSON.stringify({ product: 'Private Base', entries: full })]) {
      let puts = 0;
      await assert.rejects(publishRelease(config, async args => {
        if (args[0] === 'put') { puts++; return {}; }
        if (args[1] !== notesKey) return { missing: true };
        if (body === undefined) throw new Error('notes read failed');
        await writeFile(args[3], body);
        return { missing: false };
      }), /notes read failed|JSON|Invalid release notes/);
      assert.equal(puts, 0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function fakeBucket(objects, beforeWrite = () => {}) {
  const writes = [];
  const remote = async ([op, key, , path]) => {
    if (op === 'get') {
      if (!objects.has(key)) return { missing: true };
      await writeFile(path, objects.get(key));
    } else {
      beforeWrite(key);
      writes.push(key);
      objects.set(key, await readFile(path, 'utf8'));
    }
    return {};
  };
  return { remote, writes };
}

const notesOnly = ['--publish-notes-only', '--version', '0.1.0'];

test('notes-only recovers the original snapshot Markdown after a failed upload and is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'release-recovery-'));
  try {
    const notesPath = join(dir, 'original.md');
    const markdown = '## Original publish wording\r\n- The exact **published** source.\r\n';
    await writeFile(notesPath, markdown);
    const apk = join(dir, 'fixture.apk');
    await writeFile(apk, 'signed Android fixture');
    const previous = { version: '0.0.9', published: '2026-11-14T12:00:00Z', notes: 'Keep this verbatim.\r\n', platforms: ['windows', 'macos'] };
    const objects = new Map([[notesKey, JSON.stringify({ product: 'Private Base', entries: [previous] })]]);
    const initial = fakeBucket(objects, key => { if (key === notesKey) throw new Error('notes upload failed'); });
    await assert.rejects(main([
      '--version', '0.1.0', '--channel', 'stable', '--rollout', '100', '--publish', '--out', dir,
      '--notes-file', notesPath, '--android', apk, '--pub-date', '2026-11-17T20:00:00Z',
    ], initial.remote), /notes upload failed/);
    assert.ok(initial.writes.includes(releaseKey('latest.json')));
    assert.ok(initial.writes.includes(releaseKey('0.1.0/release.json')));
    const before = new Map(objects);
    await rm(notesPath);

    const recovery = fakeBucket(objects);
    await main(notesOnly, recovery.remote);
    assert.deepEqual(recovery.writes, [notesKey]);
    const current = { version: '0.1.0', published: '2026-11-17T20:00:00.000Z', notes: markdown, platforms: ['android'] };
    assert.deepEqual(JSON.parse(objects.get(notesKey)).entries, [current, previous]);
    for (const [key, original] of before) if (key !== notesKey) assert.equal(objects.get(key), original);
    await main(notesOnly, recovery.remote);
    assert.deepEqual(recovery.writes, [notesKey]);
    const alreadyPublished = JSON.stringify({ product: 'Private Base', entries: [{ ...current, notes: 'Previously published wording.' }, previous] });
    objects.set(notesKey, alreadyPublished);
    await main(notesOnly, recovery.remote);
    assert.deepEqual(recovery.writes, [notesKey]);
    assert.equal(objects.get(notesKey), alreadyPublished);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('notes-only uses the versioned local Markdown for older snapshots with a live stable updater reference', async () => {
  const version = '0.1.0';
  const manifests = generateManifests({ ...options, version }, artifacts);
  const markdown = await readFile(new URL('../release-notes/0.1.0.md', import.meta.url), 'utf8');
  const nextLatest = generateManifests(stableOptions, [artifacts[0]])['latest.json'];
  for (const pointer of ['stable/android.json', 'stable/updater/windows-x86_64.json']) {
    const objects = new Map([
      [releaseKey(`${version}/release.json`), JSON.stringify({ version, manifests })],
      [releaseKey('latest.json'), JSON.stringify(nextLatest)],
      [releaseKey(pointer), JSON.stringify(manifests[pointer])],
    ]);
    const recovery = fakeBucket(objects);
    await main(notesOnly, recovery.remote);
    assert.deepEqual(recovery.writes, [notesKey]);
    assert.deepEqual(JSON.parse(objects.get(notesKey)).entries, [{
      version, published: manifests['latest.json'].published, notes: markdown, platforms: ['macos', 'windows', 'android'],
    }]);
  }
});

test('notes-only refuses an interrupted publish even if its stable updater is already live', async () => {
  const version = '0.1.10';
  const manifests = generateManifests({ ...stableOptions, version }, [artifacts[5]]);
  const previous = generateManifests({ ...stableOptions, version: '0.1.9' }, [artifacts[5]])['latest.json'];
  for (const activeLatest of [previous, { ...previous, version: '0.0.1-20261115' }, undefined]) {
    const objects = new Map([
      [releaseKey(`${version}/release.json`), JSON.stringify({ version, manifests })],
      [releaseKey('stable/android.json'), JSON.stringify(manifests['stable/android.json'])],
    ]);
    if (activeLatest) objects.set(releaseKey('latest.json'), JSON.stringify(activeLatest));
    const recovery = fakeBucket(objects);
    const reads = [];
    await assert.rejects(main(['--publish-notes-only', '--version', version], args => {
      if (args[0] === 'get') reads.push(args[1]);
      return recovery.remote(args);
    }), /latest\.json.*Finish or repair the stable publish/);
    assert.deepEqual(reads, [releaseKey(`${version}/release.json`), releaseKey('latest.json')]);
    assert.deepEqual(recovery.writes, []);
  }
});

test('notes-only fails closed for unpublished, beta, mismatched and unreadable releases', async () => {
  const version = '0.1.0';
  const snapshotKey = releaseKey(`${version}/release.json`);
  const stable = generateManifests({ ...stableOptions, version }, [artifacts[5]]);
  const beta = generateManifests({ ...stableOptions, version, channel: 'beta' }, [artifacts[5]]);
  const snapshot = JSON.stringify({ version, manifests: stable });
  const latest = JSON.stringify(stable['latest.json']);
  const snapshotWithNotes = notes => JSON.stringify({ version, manifests: { ...stable, 'notes.json': notes } });
  const next = generateManifests(stableOptions, [artifacts[5]]);
  const nextLatest = JSON.stringify(next['latest.json']);
  const wrongVersion = next['notes.json'];
  const cases = [
    [new Map([[releaseKey('latest.json'), latest]]), /snapshot/],
    [new Map([[snapshotKey, JSON.stringify({ version, manifests: beta })]]), /snapshot/],
    [new Map([[snapshotKey, snapshot], [releaseKey('latest.json'), nextLatest]]), /No published stable manifest/],
    [new Map([[snapshotKey, snapshot], [releaseKey('latest.json'), nextLatest], [releaseKey('stable/android.json'), JSON.stringify({ ...stable['stable/android.json'], url: `${RELEASE_BASE}0.1.1/new.apk` })]]), /No published stable manifest/],
    [new Map([[snapshotKey, snapshot], [releaseKey('latest.json'), latest], [notesKey, '{"product":"Private Base","entries":[null]}']]), /Invalid release notes/],
    [new Map([[snapshotKey, snapshotWithNotes(null)], [releaseKey('latest.json'), latest]]), /Invalid release notes/],
    [new Map([[snapshotKey, snapshotWithNotes(wrongVersion)], [releaseKey('latest.json'), latest]]), /Expected notes for this release version/],
  ];
  for (const [objects, error] of cases) {
    const recovery = fakeBucket(objects);
    await assert.rejects(main(notesOnly, recovery.remote), error);
    assert.deepEqual(recovery.writes, []);
  }
  const recovery = fakeBucket(new Map([[snapshotKey, snapshot], [releaseKey('latest.json'), latest]]));
  await assert.rejects(main(notesOnly, args => {
    if (args[1] === notesKey) throw new Error('R2 read failed');
    return recovery.remote(args);
  }), /R2 read failed/);
  assert.deepEqual(recovery.writes, []);
  await assert.rejects(main([...notesOnly, '--publish'], recovery.remote), /accepts only --version/);
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
  const { parseReleaseNotes } = await loadTypeScript('../apps/web/src/features/clients/releaseNotes.ts');
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
    const notesPath = join(dir, '0.1.1.md');
    await writeFile(notesPath, notesMarkdown);
    await main(['--version', '0.1.1', '--channel', 'stable', '--rollout', '100', '--out', dir, '--notes-file', notesPath,
      '--macos-min-os', 'x'.repeat(64), '--windows-min-os', 'x'.repeat(64), '--android-min-sdk', '26', '--android-min-os', 'Android 8.0',
      ...inputs.flatMap(([arg, name]) => [arg, join(dir, name)])]);
    const raw = JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8'));
    const manifest = parseReleaseManifest(raw);
    const noteArchive = parseReleaseNotes(JSON.parse(await readFile(join(dir, 'notes.json'), 'utf8')));
    assert.deepEqual(noteArchive.entries, [{ version: raw.version, published: raw.published, notes: notesMarkdown, platforms: ['macos', 'windows', 'android'] }]);
    for (const platform of ['macos', 'windows', 'android']) {
      assert.equal(manifest.platforms[platform].file, LATEST.platforms[platform].file.replace(LATEST.version, '0.1.1'));
      assert.equal(manifest.platforms[platform].url, LATEST.platforms[platform].url.replaceAll(LATEST.version, '0.1.1'));
    }
    const intel = JSON.parse(await readFile(join(dir, 'stable/updater/darwin-x86_64.json'), 'utf8'));
    const android = JSON.parse(await readFile(join(dir, 'stable/android.json'), 'utf8'));
    assert.match(intel.platforms['darwin-x86_64'].url, /PrivateBase-0.1.1-macos-x64.app.tar.gz$/);
    assert.equal(manifest.platforms.android.minOs, 'Android 8.0');
    assert.equal(android.minSdk, 26);
    assert.equal(intel.notes, 'Highlights\n\n- Faster downloads.\n- Read the guide.');
    assert.equal(android.notes, intel.notes);
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
    await publishRelease({ version: '0.1.1', artifacts: built, manifests: generateManifests(stableOptions, built), out: dir }, async args => { calls.push(args); return { missing: true }; });
    const upload = calls.find(args => args[0] === 'put');
    assert.equal(upload[1], 'dist/private-base/releases/0.1.1/PrivateBase-0.1.1-windows-x64-setup.exe');
    assert.equal(upload[3], join(dir, inputs[6][1]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
