import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareTestFeed, resolveFeedAddress, testFeedServer } from './ota-test-feed.mjs';
import { verifySignature } from './release-ui.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('uses the advertised test base port unless the listen port is explicit', () => {
  assert.deepEqual(resolveFeedAddress(), { base: 'http://127.0.0.1:8789/', port: 8789, host: '127.0.0.1' });
  const base = 'http://127.0.0.1:9000/';
  assert.deepEqual(resolveFeedAddress(base), { base, port: 9000, host: '127.0.0.1' });
  assert.deepEqual(resolveFeedAddress(base, '9001'), { base, port: 9001, host: '127.0.0.1' });
  assert.equal(resolveFeedAddress(undefined, '9001').base, 'http://127.0.0.1:9001/');
  assert.equal(resolveFeedAddress('http://[::1]/').port, 80);
  assert.equal(resolveFeedAddress('https://127.0.0.1/').port, 443);
  assert.throws(() => resolveFeedAddress(base, '65536'), /valid listen port/);
});

test('test feed prepares all variants and serves only discovery and artifacts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'private-base-test-feed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, 'dist-native');
  await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<p>OTA test</p>');
  const contract = JSON.parse(await readFile(new URL('../apps/native/ui-bundle.json', import.meta.url)));
  const base = 'http://127.0.0.1:8789/';
  let goodFeed;
  const keys = new Set();
  for (const variant of ['good', 'tampered-file', 'bad-signature', 'wrong-db-schema', 'wrong-native-contract', 'no-ready']) {
    await writeFile(join(dist, 'schema-version.json'), JSON.stringify({
      version: contract.embeddedDbSchemaVersion,
      otaTestNoReady: variant === 'no-ready',
    }));
    const { feed, publicKey } = await prepareTestFeed({ out: join(root, variant), variant, base, dist });
    if (variant === 'good') goodFeed = feed;
    assert.match(publicKey, /^[A-Za-z0-9+/]{56}$/);
    keys.add(publicKey);
    const stable = await readFile(join(feed, 'stable/ui.json'));
    assert.deepEqual(stable, await readFile(join(feed, 'beta/ui.json')));
    const { url, uiVersion, size, sha256, signature, nativeContract, dbSchemaVersion } = JSON.parse(stable);
    assert.equal(uiVersion, '1.0.1');
    assert.equal(url, base + 'ui/1.0.1/bundle.tar.gz');
    const archive = join(feed, new URL(url).pathname.slice(1));
    const compressed = await readFile(archive);
    assert.equal(compressed.length, size);
    assert.equal(hash(compressed), sha256);
    assert.equal((await readFile(archive + '.sig', 'utf8')).trim(), signature);
    const key = Buffer.from('untrusted comment: minisign public key\n' + publicKey).toString('base64');
    if (variant === 'bad-signature') {
      assert.throws(() => verifySignature(compressed, signature, key), /does not verify/);
    } else {
      verifySignature(compressed, signature, key);
    }
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'manifest.json']));
    assert.equal(nativeContract, contract.nativeContract + Number(variant === 'wrong-native-contract'));
    assert.equal(dbSchemaVersion, contract.embeddedDbSchemaVersion + Number(variant === 'wrong-db-schema'));
    assert.equal(nativeContract, manifest.nativeContract);
    assert.equal(dbSchemaVersion, manifest.dbSchemaVersion);
    const index = execFileSync('tar', ['-xOzf', archive, 'index.html']);
    assert.equal(index.length, manifest.files.find(file => file.path === 'index.html').size);
    assert.equal(hash(index) === manifest.files.find(file => file.path === 'index.html').sha256, variant !== 'tampered-file');
  }
  assert.equal(keys.size, 6);
  await assert.rejects(prepareTestFeed({ out: join(root, 'wrong'), variant: 'good', base, dist }), /no-ready variant together/);
  await assert.rejects(prepareTestFeed({
    out: join(homedir(), '.private-base-release', 'test-do-not-create'),
    variant: 'no-ready', base, dist,
  }), /outside the release signing directory/);
  // Exercise the HTTP handler without opening a TCP port in sandboxed tests.
  const handle = testFeedServer(goodFeed).listeners('request')[0];
  for (const [url, status] of [
    ['/stable/ui.json', 200], ['/beta/ui.json', 200], ['/ui/1.0.1/bundle.tar.gz', 200],
    ['/ui/1.0.1/bundle.tar.gz.sig', 200], ['/keys/test.key', 404], ['/../keys/test.key', 404],
  ]) {
    await handle({ url, method: 'GET' }, {
      writeHead(code) { assert.equal(code, status); return this; },
      end(contents) { assert.equal(Boolean(contents), status === 200); },
    });
  }
});
