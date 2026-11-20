// Tests for `immediately.run git-serve` on loopback (GIT_SERVE_SPEC §4, §5.1,
// §10.1; roadmap R3-1357). Runs against the compiled dist/ (`npm test` builds
// first), so it exercises exactly what ships.
//
// Every repository here is made by real `git init --bare` and real commits in a
// temp directory. No server answer and no git object is typed by hand.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createHash } from 'node:crypto';

import { startGitServe } from '../dist/gitServe/server.js';
import { GIT_TIMEOUT_MS, runGit } from '../dist/gitServe/runGit.js';
import { gitServeNamespace, canonicalTailnetOrigin } from '../dist/gitServe/namespace.js';
import { resolveRef } from '../dist/gitServe/refs.js';
import { resolveRepo, listRepos } from '../dist/gitServe/repoName.js';
import { guardRequest, classify, isPinnedHost, TAILNET_ROUTES } from '../dist/gitServe/guards.js';
import { addConnection } from '../dist/gitServe/connections.js';
import { parseTailnetIdentity, parseWhois } from '../dist/gitServe/tailscaleWhois.js';
import { GIT_SERVE_PROTOCOL, GIT_SERVE_SERVER } from '../dist/gitServe/protocol.js';
import { runGitServeInit } from '../dist/commands/gitServe.js';
import { parseLsTreeLong, treeEntries } from '../dist/git.js';
import { buildProviderDeepLink, locatorFragment } from '../dist/deepLink.js';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const VECTORS = fileURLToPath(new URL('./fixtures/git-serve-namespace-vectors.json', import.meta.url));

const ORIGIN = 'https://local.immediately.run';
const MEDIATOR = 'https://staging-immediately-run-devbridge.web.app';
const TOKEN = 'test-token-0123456789';

let tmp; // everything this file creates
let root; // the served root
let work; // a working clone that pushes into <root>/notes.git
let handle;

const git = (cwd, args, opts = {}) =>
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8', ...opts }).trim();

/** The git blob SHA of `bytes`, computed here and not by the server under test. */
const blobSha = (bytes) =>
  createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest('hex');

/** A raw HTTP request, so the test controls every header (fetch forbids Host). */
const request = (path, { method = 'GET', headers = {}, port = handle.port } = {}) =>
  new Promise((resolvePromise, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on('error', reject);
    req.end();
  });

/** A request as the mediator sends it: its Origin, the token in Authorization. */
const authed = (path, extra = {}) =>
  request(path, {
    ...extra,
    headers: { Origin: MEDIATOR, Authorization: `Bearer ${TOKEN}`, ...(extra.headers ?? {}) },
  });

const json = async (path) => {
  const res = await authed(path);
  return { status: res.status, body: JSON.parse(res.body.toString('utf8')), raw: res.body };
};

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ir-git-serve-'));
  root = join(tmp, 'root');
  assert.equal(runGitServeInit(root, 'notes'), 0);

  work = join(tmp, 'work');
  mkdirSync(work);
  git(work, ['init', '-q']);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'Test']);
  writeFileSync(join(work, 'a.txt'), 'hello\n');
  mkdirSync(join(work, 'dir'));
  writeFileSync(join(work, 'dir', 'run.sh'), '#!/bin/sh\n');
  chmodSync(join(work, 'dir', 'run.sh'), 0o755);
  symlinkSync('a.txt', join(work, 'link'));
  writeFileSync(join(work, 'empty'), '');
  git(work, ['add', '.']);
  git(work, ['commit', '-q', '-m', 'first']);
  git(work, ['branch', '-M', 'main']);
  git(work, ['tag', 'v1']);
  git(work, ['tag', '-a', 'v1-annotated', '-m', 'annotated']);
  // A tag that names a blob: it peels to no commit, so it must not be listed.
  git(work, ['tag', 'blob-tag', git(work, ['rev-parse', 'HEAD:a.txt'])]);
  git(work, ['checkout', '-q', '-b', 'feature-x']);
  writeFileSync(join(work, 'a.txt'), 'feature-x\n');
  git(work, ['commit', '-q', '-am', 'feature-x']);
  git(work, ['checkout', '-q', '-b', 'feature/x']);
  writeFileSync(join(work, 'a.txt'), 'feature/x\n');
  git(work, ['commit', '-q', '-am', 'feature/x']);
  git(work, ['checkout', '-q', 'main']);
  git(work, ['remote', 'add', 'origin', join(root, 'notes.git')]);
  git(work, ['push', '-q', 'origin', '--all']);
  git(work, ['push', '-q', 'origin', '--tags']);
  git(join(root, 'notes.git'), ['symbolic-ref', 'HEAD', 'refs/heads/main']);

  handle = await startGitServe({ root, origin: ORIGIN, token: TOKEN, port: 0 });
});

after(async () => {
  await handle.close();
  rmSync(tmp, { recursive: true, force: true });
});

// --- the read answers -------------------------------------------------------

test('R-GS-1: every JSON answer names the server and the protocol, errors included', async () => {
  for (const path of ['/meta', '/meta?repo=notes', '/meta?repo=notes&ref=main', '/tree?repo=notes&ref=main', '/meta?repo=absent', '/tree?repo=notes&ref=a..b']) {
    const { body } = await json(path);
    assert.equal(body.server, GIT_SERVE_SERVER, path);
    assert.equal(body.protocol, GIT_SERVE_PROTOCOL, path);
  }
});

test('/meta lists the repositories and the instance id', async () => {
  const { status, body } = await json('/meta');
  assert.equal(status, 200);
  assert.deepEqual(body.repos, ['notes']);
  assert.equal(body.instanceId, handle.instanceId);
  assert.match(body.instanceId, /^[0-9a-f]{32}$/);
  assert.equal(body.allowCommit, false);
});

test('/meta?repo= lists branches and tags; a tag is its peeled commit; a tag of a blob is not listed', async () => {
  const { status, body } = await json('/meta?repo=notes');
  assert.equal(status, 200);
  assert.equal(body.defaultBranch, 'main');
  const mainSha = git(work, ['rev-parse', 'main']);
  assert.deepEqual(
    body.branches.map((b) => b.name).sort(),
    ['feature-x', 'feature/x', 'main'],
  );
  assert.equal(body.branches.find((b) => b.name === 'main').sha, mainSha);
  assert.deepEqual(body.tags.map((t) => t.name).sort(), ['v1', 'v1-annotated']);
  // The annotated tag's own object id is not its commit; the answer carries the commit.
  assert.notEqual(git(work, ['rev-parse', 'v1-annotated']), mainSha);
  for (const tag of body.tags) assert.equal(tag.sha, mainSha, tag.name);
});

test('/tree is the whole tree with modes, blob SHAs and sizes; /blob returns the bytes each SHA names', async () => {
  const { status, body } = await json('/tree?repo=notes&ref=main');
  assert.equal(status, 200);
  assert.equal(body.refKind, 'branch');
  assert.equal(body.commitSha, git(work, ['rev-parse', 'main']));
  assert.equal(body.treeSha, git(work, ['rev-parse', 'main^{tree}']));
  const byPath = Object.fromEntries(body.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), ['a.txt', 'dir/run.sh', 'empty', 'link']);
  assert.equal(byPath['a.txt'].mode, '100644');
  assert.equal(byPath['dir/run.sh'].mode, '100755');
  assert.equal(byPath['link'].mode, '120000');
  assert.equal(byPath['a.txt'].size, 6);
  assert.equal(byPath['empty'].size, 0);
  for (const file of body.files) {
    const blob = await authed(`/blob?repo=notes&sha=${file.sha}`);
    assert.equal(blob.status, 200, file.path);
    assert.equal(blob.headers['content-type'], 'application/octet-stream');
    assert.equal(blob.body.length, file.size, file.path);
    assert.equal(blobSha(blob.body), file.sha, `${file.path}: bytes must hash to the SHA asked for`);
  }
  assert.equal((await authed(`/blob?repo=notes&sha=${byPath['a.txt'].sha}`)).body.toString(), 'hello\n');
  // A symlink is served as its target text (the blob git stores for it).
  assert.equal((await authed(`/blob?repo=notes&sha=${byPath['link'].sha}`)).body.toString(), 'a.txt');
});

test('R-GS-3: a 40-hex commit, a tag and a branch each resolve with their own refKind', async () => {
  const sha = git(work, ['rev-parse', 'main']);
  assert.equal((await json(`/meta?repo=notes&ref=${sha}`)).body.refKind, 'commit');
  assert.equal((await json('/meta?repo=notes&ref=v1')).body.refKind, 'tag');
  assert.equal((await json('/meta?repo=notes&ref=v1-annotated')).body.commitSha, sha);
  assert.equal((await json('/meta?repo=notes&ref=main')).body.refKind, 'branch');
  // A tag that does not peel to a commit does not resolve.
  assert.equal((await json('/meta?repo=notes&ref=blob-tag')).status, 404);
  // A 40-hex value is a commit and nothing else: a tree's SHA is not a ref.
  assert.equal((await json(`/meta?repo=notes&ref=${git(work, ['rev-parse', 'main^{tree}'])}`)).status, 404);
});

test('R-GS-4: a submodule entry is left out of the tree', async () => {
  const sub = join(tmp, 'sub');
  mkdirSync(sub);
  git(sub, ['init', '-q']);
  git(sub, ['config', 'user.email', 'test@example.com']);
  git(sub, ['config', 'user.name', 'Test']);
  writeFileSync(join(sub, 's.txt'), 's\n');
  git(sub, ['add', '.']);
  git(sub, ['commit', '-q', '-m', 'sub']);
  git(work, ['checkout', '-q', '-b', 'with-submodule', 'main']);
  // A gitlink entry written straight into the index: mode 160000, no .gitmodules needed.
  git(work, ['update-index', '--add', '--cacheinfo', `160000,${git(sub, ['rev-parse', 'HEAD'])},vendor/sub`]);
  git(work, ['commit', '-q', '-m', 'add gitlink']);
  git(work, ['push', '-q', 'origin', 'with-submodule']);
  git(work, ['checkout', '-q', 'main']);
  assert.match(git(work, ['ls-tree', '-r', 'with-submodule']), /^160000 commit .*\tvendor\/sub$/m);
  const { status, body } = await json('/tree?repo=notes&ref=with-submodule');
  assert.equal(status, 200);
  assert.ok(!body.files.some((f) => f.path.startsWith('vendor/')), 'the gitlink must be omitted');
  assert.ok(body.files.some((f) => f.path === 'a.txt'));
});

test('R-GS-4: a tree with a `.`, `..` or `.git` path segment is not listed — /tree answers 500', async () => {
  const bare = join(root, 'notes.git');
  // Planted on the server's disk with `git mktree`, which checks no entry name.
  // No checkout and no `git add` could make these trees.
  const who = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const blob = git(bare, ['rev-parse', 'refs/heads/main:a.txt']);
  const mktree = (entries) => git(bare, ['mktree'], { input: entries });
  const inner = mktree(`100644 blob ${blob}\tx\n`);
  const planted = {
    'planted-dotdot-file': `100644 blob ${blob}\t..\n`,
    'planted-dotdot-dir': `040000 tree ${inner}\t..\n`,
    'planted-dot-dir': `040000 tree ${inner}\t.\n`,
    'planted-dotgit': `040000 tree ${inner}\t.git\n`,
    'planted-dotgit-case': `040000 tree ${inner}\t.GiT\n`,
    'planted-nested': `040000 tree ${mktree(`040000 tree ${inner}\t.git\n`)}\tdir\n`,
    // Beside an ordinary file: the whole tree is refused, not the one entry.
    'planted-mixed': `100644 blob ${blob}\t..\n100644 blob ${blob}\tok.txt\n`,
  };
  // Names that only look alike are ordinary files.
  const harmless = mktree(`100644 blob ${blob}\t...\n100644 blob ${blob}\t.gitignore\n100644 blob ${blob}\ta..b\n040000 tree ${inner}\t.github\n`);
  const branches = [...Object.keys(planted), 'planted-harmless'];
  try {
    for (const [name, entries] of Object.entries(planted)) {
      const commit = git(bare, ['commit-tree', mktree(entries), '-m', name], { env: { ...process.env, ...who } });
      git(bare, ['update-ref', `refs/heads/${name}`, commit]);
      const res = await json(`/tree?repo=notes&ref=${name}`);
      assert.equal(res.status, 500, `${name}: ${res.raw}`);
      assert.equal(res.body.reason, 'tree-incomplete', name);
      assert.equal(res.body.files, undefined, name);
      // The ref itself resolves; it is the listing that is refused.
      assert.equal((await json(`/meta?repo=notes&ref=${name}`)).body.commitSha, commit);
    }
    const commit = git(bare, ['commit-tree', harmless, '-m', 'harmless'], { env: { ...process.env, ...who } });
    git(bare, ['update-ref', 'refs/heads/planted-harmless', commit]);
    const fine = await json('/tree?repo=notes&ref=planted-harmless');
    assert.equal(fine.status, 200);
    assert.deepEqual(fine.body.files.map((f) => f.path), ['...', '.github/x', '.gitignore', 'a..b']);
  } finally {
    for (const name of branches) {
      try {
        git(bare, ['update-ref', '-d', `refs/heads/${name}`]);
      } catch {
        /* never created */
      }
    }
  }
});

test('R-GS-3 (amended): a name that is both a branch and a tag is refused as ambiguous; /meta?repo= lists both', async () => {
  const bare = join(root, 'notes.git');
  const tagged = git(bare, ['rev-parse', 'refs/tags/v1^{commit}']);
  const other = git(bare, ['rev-parse', 'refs/heads/feature-x']);
  assert.notEqual(tagged, other);
  assert.equal((await json('/meta?repo=notes&ref=v1')).body.commitSha, tagged);
  // What a push can do: a branch under the tag's name, at another commit.
  git(bare, ['update-ref', 'refs/heads/v1', other]);
  try {
    for (const route of ['/meta', '/tree']) {
      const res = await json(`${route}?repo=notes&ref=v1`);
      assert.equal(res.status, 400, route);
      assert.equal(res.body.reason, 'ambiguous', route);
      assert.equal(res.body.commitSha, undefined, route);
    }
    assert.deepEqual(await resolveRef(bare, 'v1', runGit), { ok: false, reason: 'ambiguous' });
    // The listing still shows both, each with its own commit, and each commit
    // is reachable by its SHA.
    const listed = (await json('/meta?repo=notes')).body;
    assert.deepEqual(listed.branches.filter((b) => b.name === 'v1'), [{ name: 'v1', sha: other }]);
    assert.deepEqual(listed.tags.filter((t) => t.name === 'v1'), [{ name: 'v1', sha: tagged }]);
    assert.equal((await json(`/meta?repo=notes&ref=${other}`)).body.refKind, 'commit');
    assert.equal((await json(`/meta?repo=notes&ref=${tagged}`)).body.refKind, 'commit');
    // Names that are one or the other resolve as before.
    assert.equal((await json('/meta?repo=notes&ref=main')).body.refKind, 'branch');
    assert.equal((await json('/meta?repo=notes&ref=v1-annotated')).body.refKind, 'tag');
  } finally {
    git(bare, ['update-ref', '-d', 'refs/heads/v1']);
  }
  const again = (await json('/meta?repo=notes&ref=v1')).body;
  assert.equal(again.refKind, 'tag');
  assert.equal(again.commitSha, tagged);
});

// --- G-GS-1 -----------------------------------------------------------------

test('G-GS-1: a branch moved between the ref resolution and the tree read never yields a mixed answer', async () => {
  // A repository of its own, so moving its branch disturbs no other test.
  const raceRoot = join(tmp, 'race-root');
  runGitServeInit(raceRoot, 'race');
  const bare = join(raceRoot, 'race.git');
  git(work, ['push', '-q', bare, 'main:main']);
  const before = git(bare, ['rev-parse', 'refs/heads/main']);
  const next = git(work, ['rev-parse', 'feature-x']);
  git(work, ['push', '-q', bare, 'feature-x:refs/heads/staging']);
  assert.notEqual(before, next);

  // The injected runGit advances `main` right after the server's first lookup
  // of the ref, i.e. between its resolution and every later read.
  let advanced = false;
  const racingRunGit = async (repoDir, args) => {
    const result = await runGit(repoDir, args);
    if (!advanced && args[0] === 'show-ref') {
      advanced = true;
      git(bare, ['update-ref', 'refs/heads/main', next, before]);
    }
    return result;
  };
  const racing = await startGitServe({
    root: raceRoot,
    origin: ORIGIN,
    token: TOKEN,
    port: 0,
    runGit: racingRunGit,
  });
  try {
    const res = await authed('/tree?repo=race&ref=main', { port: racing.port });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body.toString('utf8'));
    assert.ok(advanced, 'the ref must have moved during the request');
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), next, 'the branch now names the new commit');
    // Whichever commit the answer names, the tree and the entries are that commit's.
    assert.equal(body.commitSha, before);
    assert.equal(body.treeSha, git(bare, ['rev-parse', `${body.commitSha}^{tree}`]));
    const expected = git(bare, ['ls-tree', '-r', body.commitSha])
      .split('\n')
      .map((line) => line.split(/\s+/)[2])
      .sort();
    assert.deepEqual(body.files.map((f) => f.sha).sort(), expected);
    assert.notEqual(body.treeSha, git(bare, ['rev-parse', `${next}^{tree}`]));
  } finally {
    await racing.close();
  }
});

// --- G-GS-2 (server half) ---------------------------------------------------

test('G-GS-2: a commit SHA, a tree SHA, a tag object SHA and an unknown SHA get byte-identical 404s on /blob', async () => {
  const commit = git(work, ['rev-parse', 'main']);
  const tree = git(work, ['rev-parse', 'main^{tree}']);
  const tagObject = git(work, ['rev-parse', 'v1-annotated']);
  const unknown = '0123456789abcdef0123456789abcdef01234567';
  const answers = [];
  for (const sha of [commit, tree, tagObject, unknown]) {
    const res = await authed(`/blob?repo=notes&sha=${sha}`);
    assert.equal(res.status, 404, sha);
    answers.push(res.body.toString('utf8'));
  }
  assert.equal(new Set(answers).size, 1, 'the four bodies must be identical');
  // A SHA that is not 40 hex is malformed, not unknown.
  assert.equal((await authed('/blob?repo=notes&sha=abc')).status, 400);
  assert.equal((await authed(`/blob?repo=notes&sha=${commit.toUpperCase()}`)).status, 400);
  assert.equal((await authed('/blob?repo=notes')).status, 400);
});

// --- G-GS-3 -----------------------------------------------------------------

test('G-GS-3: a hostile ref never reaches git as an option, an expression or a path', async () => {
  const calls = [];
  const recordingRunGit = async (repoDir, args) => {
    calls.push({ repoDir, args: [...args] });
    return runGit(repoDir, args);
  };
  const recording = await startGitServe({
    root,
    origin: ORIGIN,
    token: TOKEN,
    port: 0,
    runGit: recordingRunGit,
  });
  const hostileRefs = ['--upload-pack=x', '-h', 'a..b', 'HEAD~1', 'x^{tree}', '../x', 'main^', 'main:a.txt', '@{-1}', 'HEAD', 'main@{0}', 'refs/heads/main..x', ''];
  try {
    for (const route of ['/tree', '/meta']) {
      for (const ref of hostileRefs) {
        calls.length = 0;
        const res = await authed(`${route}?repo=notes&ref=${encodeURIComponent(ref)}`, { port: recording.port });
        assert.equal(res.status, 400, `${route} ref=${JSON.stringify(ref)}`);
        // The value may appear in ONE place only: as the single name argument of
        // `check-ref-format --branch`, which reads no option after `--branch`.
        for (const call of calls) {
          const at = call.args.indexOf(ref);
          if (at === -1) {
            assert.ok(!call.args.some((a) => ref !== '' && a.includes(ref)), `ref leaked into ${call.args.join(' ')}`);
            continue;
          }
          assert.deepEqual(call.args, ['check-ref-format', '--branch', ref]);
        }
        // Nothing that reads objects or refs ran for a refused ref.
        assert.ok(!calls.some((c) => ['show-ref', 'ls-tree', 'cat-file'].includes(c.args[0])));
      }
    }
    // `feature-x` and `feature/x` are ordinary branch names and resolve.
    for (const ref of ['feature-x', 'feature/x']) {
      const res = await authed(`/tree?repo=notes&ref=${encodeURIComponent(ref)}`, { port: recording.port });
      assert.equal(res.status, 200, ref);
      const body = JSON.parse(res.body.toString('utf8'));
      assert.equal(body.commitSha, git(work, ['rev-parse', ref]));
      assert.equal(body.refKind, 'branch');
    }
    // A name that is well-formed but absent is 404, not 400.
    assert.equal((await authed('/tree?repo=notes&ref=no-such-branch', { port: recording.port })).status, 404);
  } finally {
    await recording.close();
  }
});

test('G-GS-3: a ref is looked up exactly — a branch named refs/heads/x does not answer for x', async () => {
  const bare = join(root, 'notes.git');
  const sha = git(bare, ['rev-parse', 'refs/heads/main']);
  git(bare, ['update-ref', 'refs/heads/refs/heads/shadow', sha]);
  try {
    assert.equal(git(bare, ['rev-parse', '--verify', '-q', 'refs/heads/shadow']), sha, 'git itself falls back');
    assert.equal((await json('/meta?repo=notes&ref=shadow')).status, 404);
    assert.equal((await json(`/meta?repo=notes&ref=${encodeURIComponent('refs/heads/shadow')}`)).status, 200);
  } finally {
    git(bare, ['update-ref', '-d', 'refs/heads/refs/heads/shadow']);
  }
});

test('G-GS-3: a repository is a name — a path, a nested name, a symlink and a borrower are refused', async () => {
  const calls = [];
  const recordingRunGit = async (repoDir, args) => {
    calls.push({ repoDir, args: [...args] });
    return runGit(repoDir, args);
  };
  // A second real repository OUTSIDE the root, reachable only by escaping it.
  const outside = join(tmp, 'outside');
  runGitServeInit(outside, 'secret');
  git(work, ['push', '-q', join(outside, 'secret.git'), 'main:main']);
  // A symlink inside the root that points at it.
  symlinkSync(join(outside, 'secret.git'), join(root, 'linked.git'));
  // A nested repository: <root>/a/b.git.
  runGitServeInit(join(root, 'a'), 'b');
  git(work, ['push', '-q', join(root, 'a', 'b.git'), 'main:main']);
  // A repository that borrows its objects from the outside one.
  runGitServeInit(root, 'borrower');
  mkdirSync(join(root, 'borrower.git', 'objects', 'info'), { recursive: true });
  writeFileSync(join(root, 'borrower.git', 'objects', 'info', 'alternates'), join(outside, 'secret.git', 'objects') + '\n');
  git(join(root, 'borrower.git'), ['update-ref', 'refs/heads/main', git(work, ['rev-parse', 'main'])]);
  // Two more ways to borrow objects: a `commondir` pointer, and a symlinked
  // fan-out directory under objects/.
  runGitServeInit(root, 'common');
  writeFileSync(join(root, 'common.git', 'commondir'), join(outside, 'secret.git') + '\n');
  runGitServeInit(root, 'fanout');
  symlinkSync(join(outside, 'secret.git', 'objects', 'pack'), join(root, 'fanout.git', 'objects', 'zz'));
  // Sanity: git itself would happily serve the borrower and the symlink.
  assert.equal(git(join(root, 'borrower.git'), ['cat-file', '-t', 'refs/heads/main']), 'commit');
  assert.equal(git(join(root, 'linked.git'), ['cat-file', '-t', 'refs/heads/main']), 'commit');

  const recording = await startGitServe({ root, origin: ORIGIN, token: TOKEN, port: 0, runGit: recordingRunGit });
  try {
    const blob = git(work, ['rev-parse', 'main:a.txt']);
    const malformed = ['../outside/secret', 'a/b', 'notes.git', '.', '..', 'notes/', '/etc', 'a%2Fb', 'no tes', '-h.x', ''];
    for (const repo of malformed) {
      for (const path of [`/meta?repo=${encodeURIComponent(repo)}`, `/tree?repo=${encodeURIComponent(repo)}&ref=main`, `/blob?repo=${encodeURIComponent(repo)}&sha=${blob}`]) {
        calls.length = 0;
        const res = await authed(path, { port: recording.port });
        assert.equal(res.status, 400, path);
        assert.equal(calls.length, 0, `git must not run for ${path}`);
      }
    }
    const refused = ['linked', 'borrower', 'common', 'fanout', 'absent', '-h', '--upload-pack'];
    const bodies = new Set();
    for (const repo of refused) {
      for (const path of [`/meta?repo=${repo}`, `/tree?repo=${repo}&ref=main`, `/blob?repo=${repo}&sha=${blob}`]) {
        calls.length = 0;
        const res = await authed(path, { port: recording.port });
        assert.equal(res.status, 404, path);
        assert.equal(calls.length, 0, `git must not run for ${path}`);
        bodies.add(res.body.toString('utf8'));
      }
    }
    assert.equal(bodies.size, 1, 'a symlink, a borrower and a missing name are indistinguishable');
    // None of them is listed either.
    const meta = JSON.parse((await authed('/meta', { port: recording.port })).body.toString('utf8'));
    assert.deepEqual(meta.repos, ['notes']);
  } finally {
    await recording.close();
    rmSync(join(root, 'linked.git'));
    rmSync(join(root, 'borrower.git'), { recursive: true, force: true });
    rmSync(join(root, 'common.git'), { recursive: true, force: true });
    rmSync(join(root, 'fanout.git'), { recursive: true, force: true });
    rmSync(join(root, 'a'), { recursive: true, force: true });
  }
});

test('R-GS-6: the unit rules of resolveRepo and listRepos', () => {
  assert.deepEqual(resolveRepo(handle.root, 'notes'), { ok: true, name: 'notes', dir: join(handle.root, 'notes.git') });
  assert.deepEqual(resolveRepo(handle.root, 'absent'), { ok: false, reason: 'unknown' });
  for (const bad of ['a.b', 'a/b', '', '..', undefined, null, 7, 'x'.repeat(256)]) {
    assert.deepEqual(resolveRepo(handle.root, bad), { ok: false, reason: 'malformed' }, String(bad));
  }
  // The state directory is never a repository.
  assert.ok(!listRepos(handle.root).some((r) => r.name.includes('git-serve')));
  assert.deepEqual(listRepos(handle.root).map((r) => r.name), ['notes']);
});

test('a SHA-256 repository is left out of the list and refused by name', async (t) => {
  const dir = join(root, 'sha256repo.git');
  try {
    execFileSync('git', ['init', '--bare', '-q', '--object-format=sha256', dir], { stdio: 'pipe' });
  } catch {
    t.skip('this git cannot create a SHA-256 repository');
    return;
  }
  try {
    assert.equal(git(dir, ['rev-parse', '--show-object-format']), 'sha256');
    assert.deepEqual((await json('/meta')).body.repos, ['notes']);
    const meta = await json('/meta?repo=sha256repo');
    assert.equal(meta.status, 400);
    assert.equal(meta.body.reason, 'unsupported-object-format');
    assert.equal((await json('/tree?repo=sha256repo&ref=main')).body.reason, 'unsupported-object-format');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- G-GS-12 ----------------------------------------------------------------

test('G-GS-12: a browser-class request with no Origin is refused', async () => {
  const res = await request('/meta', { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).reason, 'origin');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  // A foreign Origin is refused the same way, valid token or not.
  const foreign = await authed('/meta', { headers: { Origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers['access-control-allow-origin'], undefined);
});

test('G-GS-12: the token is taken from Authorization only — ?token= is 401', async () => {
  const res = await request(`/meta?token=${TOKEN}`, { headers: { Origin: MEDIATOR } });
  assert.equal(res.status, 401);
  // Even beside a valid header, a token parameter is not a parameter this route reads.
  assert.equal((await authed(`/meta?token=${TOKEN}`)).status, 400);
  assert.equal((await request('/meta', { headers: { Origin: MEDIATOR, Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await request('/meta', { headers: { Origin: MEDIATOR, Authorization: TOKEN } })).status, 401);
  assert.equal((await request('/meta', { headers: { Origin: MEDIATOR } })).status, 401);
  // A 401 is readable by the page that sent it (the host renders the connect card).
  assert.equal((await request('/meta', { headers: { Origin: MEDIATOR } })).headers['access-control-allow-origin'], MEDIATOR);
});

test('G-GS-12: OPTIONS is answered after Host and Origin, without a token', async () => {
  for (const origin of [ORIGIN, MEDIATOR]) {
    const res = await request('/tree', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], origin);
    assert.equal(res.headers['access-control-allow-methods'], 'GET');
    assert.equal(res.headers['access-control-allow-headers'], 'Authorization, Content-Type');
  }
  // Still behind Origin and Host:
  assert.equal((await request('/tree', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/tree', { method: 'OPTIONS' })).status, 403);
  assert.equal((await request('/tree', { method: 'OPTIONS', headers: { Origin: MEDIATOR, Host: 'evil.example:80' } })).status, 403);
});

test('§10.1: the Host header is pinned, with its port required', async () => {
  const withHost = (host) => authed('/meta', { headers: { Host: host } });
  assert.equal((await withHost(`127.0.0.1:${handle.port}`)).status, 200);
  assert.equal((await withHost(`localhost:${handle.port}`)).status, 200);
  assert.equal((await withHost('127.0.0.1')).status, 403, 'no port');
  assert.equal((await withHost(`127.0.0.1:${handle.port + 1}`)).status, 403, 'wrong port');
  assert.equal((await withHost(`attacker.example:${handle.port}`)).status, 403, 'rebinding');
  assert.equal(JSON.parse((await withHost('attacker.example')).body).reason, 'host');
});

test('§10.1: a path in no class is 404, a wrong method is 405, and nothing is writable', async () => {
  for (const path of ['/', '/watch', '/pair', '/notes.git/info/refs', '/notes.git/HEAD', '/meta/', '/META']) {
    assert.equal((await authed(path)).status, 404, path);
  }
  // A request target the URL parser refuses is a 400, and the server lives on.
  assert.equal((await authed('//')).status, 400);
  assert.equal((await authed('/meta')).status, 200);
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    assert.equal((await authed('/meta', { method })).status, 405, method);
  }
});

test('guards: the verdicts, in order, without a socket', () => {
  const base = {
    method: 'GET',
    pathname: '/meta',
    host: '127.0.0.1:7701',
    origin: MEDIATOR,
    authorization: 'Bearer t',
    localPort: 7701,
    allowedHosts: new Set(['127.0.0.1']),
    origins: new Set([MEDIATOR]),
    isToken: (b) => b === 't',
  };
  assert.equal(guardRequest(base).kind, 'serve');
  // Host is judged first: a bad host with everything else wrong is still `host`.
  assert.equal(guardRequest({ ...base, host: 'x', pathname: '/nope', origin: undefined }).reason, 'host');
  // Then the class: an unknown path is 404 before the Origin is looked at.
  assert.deepEqual(
    [guardRequest({ ...base, pathname: '/nope', origin: undefined }).status],
    [404],
  );
  assert.equal(guardRequest({ ...base, origin: undefined }).reason, 'origin');
  assert.equal(guardRequest({ ...base, method: 'OPTIONS', authorization: undefined }).kind, 'preflight');
  assert.equal(guardRequest({ ...base, authorization: undefined }).reason, 'token');
  assert.equal(classify('/meta'), 'browser');
  assert.equal(classify('/notes.git/info/refs'), 'git');
  assert.equal(classify('/notes.git'), 'git');
  assert.equal(classify('/a/b.git/info/refs'), 'none');
  assert.equal(classify('/pair'), 'none', 'no /pair in the loopback table');
  assert.equal(classify('/pair', TAILNET_ROUTES), 'browser');
  assert.equal(classify('constructor'), 'none');
  assert.equal(isPinnedHost('[::1]:7701', 7701, new Set(['::1'])), true);
  assert.equal(isPinnedHost('[::1]', 7701, new Set(['::1'])), false);
});

// --- G-GS-12 again, under the tailnet configuration --------------------------

test('G-GS-12 on a tailnet: Origin required, no ?token=, preflight without a token, Host with its port', async () => {
  const FIX = fileURLToPath(new URL('./fixtures/tailscale-whois/', import.meta.url));
  const identity = parseTailnetIdentity(readFileSync(join(FIX, 'status.json'), 'utf8'));
  const sameUser = parseWhois(0, readFileSync(join(FIX, 'same-user.json'), 'utf8'), '');
  const HOST = 'serving-node.example-tailnet.ts.net';
  const tailRoot = join(tmp, 'tailnet-root');
  runGitServeInit(tailRoot, 'notes');
  const { token } = addConnection(tailRoot, 'read');
  // Started through the programmatic entry with an injected listen address and
  // whois; this seam is not a CLI flag.
  const tail = await startGitServe({
    root: tailRoot,
    origin: ORIGIN,
    port: 0,
    log: () => {},
    tailnet: {
      host: HOST,
      address: '127.0.0.1',
      peerGate: { self: identity.self, allowUserIds: new Set(), whois: async () => sameUser },
    },
  });
  const hostHeader = `${HOST}:${tail.port}`;
  const ask = (path, headers, method = 'GET') => request(path, { port: tail.port, method, headers });
  try {
    const good = { Host: hostHeader, Origin: MEDIATOR, Authorization: `Bearer ${token}` };
    assert.equal((await ask('/meta', good)).status, 200);
    // Origin is required.
    assert.equal((await ask('/meta', { Host: hostHeader, Authorization: `Bearer ${token}` })).status, 403);
    assert.equal((await ask('/meta', { ...good, Origin: 'https://evil.example' })).status, 403);
    // The token rides in Authorization only.
    assert.equal((await ask(`/meta?token=${token}`, { Host: hostHeader, Origin: MEDIATOR })).status, 401);
    // Preflight is answered without a token.
    const preflight = await ask('/meta', { Host: hostHeader, Origin: MEDIATOR }, 'OPTIONS');
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], MEDIATOR);
    // The Host pin is the MagicDNS name WITH its port; loopback names are not it.
    assert.equal((await ask('/meta', { ...good, Host: HOST })).status, 403, 'Host without the port');
    assert.equal((await ask('/meta', { ...good, Host: `${HOST}:${tail.port + 1}` })).status, 403);
    assert.equal((await ask('/meta', { ...good, Host: `127.0.0.1:${tail.port}` })).status, 403);
    assert.equal((await ask('/meta', { ...good, Host: `other.example-tailnet.ts.net:${tail.port}` })).status, 403);
    assert.equal((await ask('/meta', { ...good, Host: hostHeader.toUpperCase() })).status, 200, 'the name is case-insensitive');
    // The session token of a loopback server means nothing here.
    assert.equal((await ask('/meta', { ...good, Authorization: `Bearer ${TOKEN}` })).status, 401);
  } finally {
    await tail.close();
  }
});

test('the two binds are exclusive: startGitServe takes a token or a tailnet binding, never both or neither', () => {
  assert.throws(() => startGitServe({ root, origin: ORIGIN, port: 0 }), /exactly one/);
  assert.throws(() => startGitServe({ root, origin: ORIGIN, port: 0, token: 't', tailnet: {} }), /exactly one/);
});

// --- namespace --------------------------------------------------------------

test('R-GS-8: gitServeNamespace over the shared vectors file', () => {
  const { vectors } = JSON.parse(readFileSync(VECTORS, 'utf8'));
  assert.ok(vectors.length >= 4);
  assert.equal(vectors.filter((v) => v.input.kind === 'loopback').length, 1);
  assert.ok(vectors.filter((v) => v.input.kind === 'tailnet').length >= 3);
  for (const v of vectors) {
    assert.equal(gitServeNamespace(v.input), v.namespace, v.name);
    // The expected value is the hash of the stated identity input.
    const hash = createHash('sha256').update(v.identityInput).digest('hex').slice(0, 20);
    assert.ok(v.namespace.endsWith(`-${hash}`), v.name);
    if (v.input.kind === 'tailnet') assert.equal(canonicalTailnetOrigin(v.input.origin), v.identityInput);
  }
  for (const bad of ['http://mac.tail0a1b2c.ts.net:7701', 'https://mac.tail0a1b2c.ts.net:7701/x', 'https://u@mac.tail0a1b2c.ts.net:7701', 'mac', '']) {
    assert.throws(() => gitServeNamespace({ kind: 'tailnet', origin: bad }), bad);
  }
});

test('the served namespace is the one a host recomputes from /meta', async () => {
  const { body } = await json('/meta');
  const namespace = gitServeNamespace({ kind: 'loopback', instanceId: body.instanceId });
  assert.match(namespace, /^localhost-[0-9a-f]{20}$/);
});

// --- state ------------------------------------------------------------------

test('§9: the state directory is 0700, the instance id 0600 and minted once', async () => {
  const stateDir = join(handle.root, '.git-serve');
  assert.equal(statSync(stateDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(stateDir, 'instanceId')).mode & 0o777, 0o600);
  const again = await startGitServe({ root, origin: ORIGIN, token: TOKEN, port: 0 });
  try {
    assert.equal(again.instanceId, handle.instanceId, 'a second start reads the same id');
  } finally {
    await again.close();
  }
});

// --- reuse ------------------------------------------------------------------

test('parseLsTreeLong is the parser treeEntries uses', () => {
  const raw = execFileSync('git', ['-C', work, 'ls-tree', '-r', '-z', '--long', 'HEAD'], { encoding: 'utf8' });
  const parsed = parseLsTreeLong(raw);
  assert.deepEqual(
    parsed.map((e) => e.path).sort(),
    treeEntries(work).map((e) => e.path).sort(),
  );
  assert.deepEqual(parsed.find((e) => e.path === 'dir/run.sh').mode, '100755');
  assert.throws(() => parseLsTreeLong('not a record\0'));
});

test('resolveRef unit: the reasons', async () => {
  const bare = join(root, 'notes.git');
  assert.deepEqual(await resolveRef(bare, 'no-such', runGit), { ok: false, reason: 'unknown' });
  assert.deepEqual(await resolveRef(bare, 'a..b', runGit), { ok: false, reason: 'malformed' });
  assert.deepEqual(await resolveRef(bare, undefined, runGit), { ok: false, reason: 'malformed' });
  assert.deepEqual(await resolveRef(bare, 'x'.repeat(300), runGit), { ok: false, reason: 'malformed' });
  assert.deepEqual(await resolveRef(bare, 'a\0b', runGit), { ok: false, reason: 'malformed' });
});

test('runGit: a git that does not finish is killed and reported as a failure', async () => {
  const bare = join(root, 'notes.git');
  const started = Date.now();
  // An alias that runs a shell command stands in for a git that hangs.
  const hung = await runGit(bare, ['-c', 'alias.hang=!exec sleep 30', 'hang'], { timeoutMs: 300 });
  assert.equal(hung.code, -1, 'a killed git is the same -1 as a git that could not start');
  assert.ok(Date.now() - started < 10_000, `returned after ${Date.now() - started} ms`);
  // Sixty seconds when the caller names no time.
  assert.equal(GIT_TIMEOUT_MS, 60_000);
  // A route answers it as it answers any git failure.
  const slowRoot = join(tmp, 'slow-root');
  runGitServeInit(slowRoot, 'slow');
  git(work, ['push', '-q', join(slowRoot, 'slow.git'), 'main:main']);
  const slow = await startGitServe({
    root: slowRoot,
    origin: ORIGIN,
    token: TOKEN,
    port: 0,
    runGit: (repoDir, args, options) =>
      args[0] === 'ls-tree'
        ? runGit(repoDir, ['-c', 'alias.hang=!exec sleep 30', 'hang'], { ...options, timeoutMs: 300 })
        : runGit(repoDir, args, options),
  });
  try {
    const res = await authed('/tree?repo=slow&ref=main', { port: slow.port });
    assert.equal(res.status, 500);
    assert.equal(JSON.parse(res.body.toString('utf8')).reason, 'tree-incomplete');
  } finally {
    await slow.close();
  }
});

// --- the command ------------------------------------------------------------

test('deep link: /edit/git/<namespace>/<repo>/<ref> with the locator in the fragment', () => {
  const url = buildProviderDeepLink('https://immediately.run/', 'git', 'localhost-abc', 'notes', 'feature/x', 'http://127.0.0.1:7701', 'tok');
  assert.equal(
    url,
    'https://immediately.run/edit/git/localhost-abc/notes/feature%2Fx#ir-endpoint=http%3A%2F%2F127.0.0.1%3A7701&ir-token=tok',
  );
  assert.equal(locatorFragment('http://127.0.0.1:1', 'a b'), '#ir-endpoint=http%3A%2F%2F127.0.0.1%3A1&ir-token=a%20b');
});

/** Runs the built CLI and resolves with its first stdout line (the --json line). */
const spawnCli = (args) => {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const firstLine = new Promise((resolvePromise, reject) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => {
      out += c;
      const nl = out.indexOf('\n');
      if (nl !== -1) resolvePromise(out.slice(0, nl));
    });
    child.stderr.on('data', (c) => (err += c));
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${err}`)));
  });
  return { child, firstLine };
};

test('cli: git-serve --json prints one line with a deep link per repository, and serves it', async () => {
  const { child, firstLine } = spawnCli(['git-serve', root, '--port', '0', '--json', '--origin', ORIGIN]);
  try {
    const info = JSON.parse(await firstLine);
    assert.deepEqual(Object.keys(info).sort(), ['allowCommit', 'allowPush', 'endpoint', 'links', 'namespace', 'port', 'protocol', 'token']);
    assert.equal(info.endpoint, `http://127.0.0.1:${info.port}`);
    assert.equal(info.protocol, GIT_SERVE_PROTOCOL);
    assert.equal(info.allowPush, false);
    assert.equal(info.allowCommit, false);
    assert.equal(info.namespace, gitServeNamespace({ kind: 'loopback', instanceId: handle.instanceId }));
    assert.ok(Buffer.from(info.token, 'base64url').length >= 32, 'a 256-bit token');
    assert.deepEqual(info.links, [
      {
        repo: 'notes',
        url:
          `${ORIGIN}/edit/git/${info.namespace}/notes/main` +
          `#ir-endpoint=${encodeURIComponent(info.endpoint)}&ir-token=${info.token}`,
      },
    ]);
    const res = await request('/meta?repo=notes&ref=main', {
      port: info.port,
      headers: { Origin: MEDIATOR, Authorization: `Bearer ${info.token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).commitSha, git(work, ['rev-parse', 'main']));
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
  }
});

const runCli = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI_ENTRY, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
};

test('cli: git-serve init makes a bare repository, refuses a bad name and an existing one', () => {
  const initRoot = join(tmp, 'init-root');
  const made = runCli(['git-serve', 'init', initRoot, 'fresh_1']);
  assert.equal(made.code, 0);
  assert.equal(git(join(initRoot, 'fresh_1.git'), ['rev-parse', '--is-bare-repository']), 'true');
  assert.equal(runCli(['git-serve', 'init', initRoot, 'fresh_1']).code, 1, 'already exists');
  for (const bad of ['a.b', 'a/b', '../x', 'x.git']) {
    const res = runCli(['git-serve', 'init', initRoot, bad]);
    assert.equal(res.code, 1, bad);
    assert.match(res.out, /Invalid repository name/);
  }
  assert.equal(runCli(['git-serve', 'init', initRoot]).code, 1);
});

test('cli: an unrecognized --origin is refused without --origin-unsafe', () => {
  const res = runCli(['git-serve', root, '--origin', 'https://evil.example']);
  assert.equal(res.code, 1);
  assert.match(res.out, /origin-unsafe/);
});
