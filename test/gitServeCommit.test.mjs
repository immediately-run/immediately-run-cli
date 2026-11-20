// G-GS-9, G-GS-14, G-GS-15 — `POST /commit` (GIT_SERVE_SPEC §8, R-GS-18 to
// R-GS-23; roadmap R3-1365). Runs against the compiled dist/.
//
// Every repository is a real bare repository in a temp directory, and every
// result is read back with real git (`rev-parse`, `log`, `ls-tree`, `fsck`),
// never from the server's own answer alone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

import { startGitServe } from '../dist/gitServe/server.js';
import {
  MAX_COMMIT_BODY_BYTES,
  parseAuthor,
  parseCommitRequest,
  planCommit,
} from '../dist/gitServe/commit.js';
import { addConnection } from '../dist/gitServe/connections.js';
import { parseTailnetIdentity, parseWhois } from '../dist/gitServe/tailscaleWhois.js';
import { runGitServeInit } from '../dist/commands/gitServe.js';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/tailscale-whois/', import.meta.url));
const ORIGIN = 'https://local.immediately.run';
const MEDIATOR = 'https://staging-immediately-run-devbridge.web.app';
const TOKEN = 'session-token-for-tests';
const IDENTITY = { name: 'Serving Machine', email: 'server@example.com' };
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

let tmp;
let seq = 0;

const git = (cwd, args) =>
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();

/** The SHA a fully-qualified ref names, or null when there is no such ref. */
const tryRev = async (cwd, ref) => {
  try {
    return git(cwd, ['rev-parse', '--verify', '-q', ref]);
  } catch {
    return null;
  }
};

/** A served root whose `notes` repository has, on `main`: a.txt, dir/run.sh
 *  (executable), a symlink `link`, a submodule entry `vendor/sub`, and a tag v1. */
const makeRoot = () => {
  const dir = join(tmp, `case-${++seq}`);
  const root = join(dir, 'root');
  runGitServeInit(root, 'notes');
  const bare = join(root, 'notes.git');
  const work = join(dir, 'work');
  mkdirSync(work);
  git(work, ['init', '-q']);
  git(work, ['config', 'user.email', 'dev@example.com']);
  git(work, ['config', 'user.name', 'Dev']);
  writeFileSync(join(work, 'a.txt'), 'hello\n');
  mkdirSync(join(work, 'dir'));
  writeFileSync(join(work, 'dir', 'run.sh'), '#!/bin/sh\n');
  chmodSync(join(work, 'dir', 'run.sh'), 0o755);
  symlinkSync('a.txt', join(work, 'link'));
  git(work, ['add', '.']);
  git(work, ['commit', '-q', '-m', 'first']);
  // A gitlink entry (mode 160000) written straight into the index.
  git(work, ['update-index', '--add', '--cacheinfo', `160000,${git(work, ['rev-parse', 'HEAD'])},vendor/sub`]);
  git(work, ['commit', '-q', '-m', 'second']);
  git(work, ['branch', '-M', 'main']);
  git(work, ['tag', 'v1']);
  git(work, ['push', '-q', bare, 'main:main', 'v1']);
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { dir, root, bare, work, tip: git(bare, ['rev-parse', 'refs/heads/main']) };
};

const post = (port, path, { headers = {}, body } = {}) =>
  new Promise((resolvePromise, reject) => {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          Origin: MEDIATOR,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          resolvePromise({ status: res.statusCode, headers: res.headers, body: parsed, text });
        });
      },
    );
    // A server that answers 413 early may close the socket under the upload; the
    // answer still arrives, so a write error waits for it before giving up.
    req.on('error', (e) => {
      if (e.code !== 'EPIPE' && e.code !== 'ECONNRESET') return reject(e);
      setTimeout(() => resolvePromise({ status: 0, error: e.code }), 2000);
    });
    if (payload) req.write(payload);
    req.end();
  });

/** A loopback server; its session credential carries `write` exactly when `allowCommit`. */
const loopback = async (root, { allowCommit = true } = {}) => {
  const handle = await startGitServe({
    root,
    origin: ORIGIN,
    token: TOKEN,
    port: 0,
    allowCommit,
    identity: IDENTITY,
    log: () => {},
  });
  const commit = (body, extra = {}) =>
    post(handle.port, '/commit', { headers: { Authorization: `Bearer ${TOKEN}`, ...(extra.headers ?? {}) }, body });
  return { handle, commit };
};

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ir-git-serve-commit-'));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

// --- the working path --------------------------------------------------------

test('a commit on an existing branch lands, with the edit and nothing else', async () => {
  const { root, bare, tip } = makeRoot();
  const s = await loopback(root);
  try {
    const res = await s.commit({
      repo: 'notes',
      branch: 'main',
      expectedSha: tip,
      message: 'Edit a.txt from the browser',
      changes: [
        { path: 'a.txt', contentBase64: b64('edited\n') },
        { path: 'new/deep/file.txt', contentBase64: b64('new\n') },
      ],
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.server, 'git-serve');
    const head = git(bare, ['rev-parse', 'refs/heads/main']);
    assert.equal(res.body.commitSha, head);
    assert.equal(res.body.treeSha, git(bare, ['rev-parse', `${head}^{tree}`]));
    assert.equal(git(bare, ['rev-parse', `${head}^`]), tip, 'the only parent is the tip it replaced');
    assert.equal(git(bare, ['rev-list', '--parents', '-1', head]).split(' ').length, 2);
    assert.equal(git(bare, ['show', `${head}:a.txt`]), 'edited');
    assert.equal(git(bare, ['show', `${head}:new/deep/file.txt`]), 'new');
    assert.deepEqual(git(bare, ['diff', '--name-status', tip, head]).split('\n').sort(), ['A\tnew/deep/file.txt', 'M\ta.txt']);
    // The answer for a read after the commit is the new tree.
    const tree = await new Promise((resolvePromise) => {
      http.get(
        { host: '127.0.0.1', port: s.handle.port, path: '/tree?repo=notes&ref=main', headers: { Origin: MEDIATOR, Authorization: `Bearer ${TOKEN}` } },
        (r) => {
          let t = '';
          r.on('data', (c) => (t += c)).on('end', () => resolvePromise(JSON.parse(t)));
        },
      );
    });
    assert.equal(tree.commitSha, head);
    git(bare, ['fsck', '--strict']);
  } finally {
    await s.handle.close();
  }
});

test('R-GS-22: the author and committer are the server\'s, and the connection is a trailer', async () => {
  const { root, bare, tip } = makeRoot();
  const s = await loopback(root);
  try {
    const res = await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'Subject line\n\nBody text.', changes: [{ path: 'a.txt', contentBase64: b64('x\n') }] });
    assert.equal(res.status, 200, res.text);
    const body = git(bare, ['log', '-1', '--format=%B', 'refs/heads/main']);
    assert.equal(body, 'Subject line\n\nBody text.\n\nGit-Serve-Connection: loopback');
    assert.equal(git(bare, ['log', '-1', '--format=%(trailers:key=Git-Serve-Connection,valueonly)', 'refs/heads/main']), 'loopback');
    assert.equal(git(bare, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', 'refs/heads/main']), 'Serving Machine <server@example.com>|Serving Machine <server@example.com>');
    // A request cannot name an author, a committer or a mode.
    const next = git(bare, ['rev-parse', 'refs/heads/main']);
    for (const extra of [{ author: 'Mallory <m@example.com>' }, { committer: 'x' }, { mode: '100755' }, { identity: {} }]) {
      const refused = await s.commit({ repo: 'notes', branch: 'main', expectedSha: next, message: 'm', changes: [{ path: 'a.txt', contentBase64: b64('y\n') }], ...extra });
      assert.equal(refused.status, 400, JSON.stringify(extra));
      assert.equal(refused.body.reason, 'unknown-field');
    }
    // Nor forge the trailer.
    const forged = await s.commit({ repo: 'notes', branch: 'main', expectedSha: next, message: 'm\n\nGit-Serve-Connection: someone-else', changes: [{ path: 'a.txt', contentBase64: b64('y\n') }] });
    assert.equal(forged.status, 400);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), next);
  } finally {
    await s.handle.close();
  }
});

test('R-GS-21: an executable stays 100755 after a content change; a new file is 100644', async () => {
  const { root, bare, tip } = makeRoot();
  const s = await loopback(root);
  try {
    const res = await s.commit({
      repo: 'notes',
      branch: 'main',
      expectedSha: tip,
      message: 'modes',
      changes: [
        { path: 'dir/run.sh', contentBase64: b64('#!/bin/sh\necho changed\n') },
        { path: 'dir/new.sh', contentBase64: b64('#!/bin/sh\n') },
      ],
    });
    assert.equal(res.status, 200, res.text);
    const modes = Object.fromEntries(git(bare, ['ls-tree', '-r', 'refs/heads/main']).split('\n').map((l) => [l.split('\t')[1], l.split(' ')[0]]));
    assert.equal(modes['dir/run.sh'], '100755');
    assert.equal(modes['dir/new.sh'], '100644');
    assert.equal(modes['a.txt'], '100644');
    assert.equal(modes['link'], '120000', 'untouched entries keep their modes');
    assert.equal(modes['vendor/sub'], '160000');
    // A change entry with a mode field is refused.
    const refused = await s.commit({ repo: 'notes', branch: 'main', expectedSha: res.body.commitSha, message: 'm', changes: [{ path: 'x.sh', contentBase64: b64('x'), mode: '100755' }] });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.reason, 'unknown-field');
    assert.equal(refused.body.path, 'x.sh');
  } finally {
    await s.handle.close();
  }
});

test('a delete removes the file; an empty file and binary bytes survive the round trip', async () => {
  const { root, bare, tip } = makeRoot();
  const s = await loopback(root);
  try {
    const bytes = Buffer.from([0, 255, 10, 13, 0, 128]);
    const res = await s.commit({
      repo: 'notes',
      branch: 'main',
      expectedSha: tip,
      message: 'delete and add',
      changes: [
        { path: 'a.txt', delete: true },
        { path: 'empty', contentBase64: '' },
        { path: 'bin.dat', contentBase64: bytes.toString('base64') },
      ],
    });
    assert.equal(res.status, 200, res.text);
    const names = git(bare, ['ls-tree', '-r', '--name-only', 'refs/heads/main']).split('\n');
    assert.ok(!names.includes('a.txt'));
    assert.equal(git(bare, ['cat-file', '-s', 'refs/heads/main:empty']), '0');
    assert.deepEqual(execFileSync('git', ['-C', bare, 'cat-file', 'blob', 'refs/heads/main:bin.dat']), bytes);
  } finally {
    await s.handle.close();
  }
});

// --- G-GS-9 ------------------------------------------------------------------

test('G-GS-9: two commits raced at one expectedSha give one 200 and one 409 naming the winner', async () => {
  const { root, bare, tip } = makeRoot();
  const s = await loopback(root);
  try {
    const make = (n) => s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: `racer ${n}`, changes: [{ path: `racer-${n}.txt`, contentBase64: b64(`${n}\n`) }] });
    const results = await Promise.all([make(1), make(2), make(3)]);
    const won = results.filter((r) => r.status === 200);
    const lost = results.filter((r) => r.status === 409);
    assert.equal(won.length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.equal(lost.length, 2);
    const head = git(bare, ['rev-parse', 'refs/heads/main']);
    assert.equal(won[0].body.commitSha, head);
    for (const l of lost) {
      assert.equal(l.body.reason, 'conflict');
      assert.equal(l.body.currentSha, head, 'the 409 carries the winner\'s SHA');
    }
    // Exactly one commit landed on top of the old tip: no ref was left half-moved.
    assert.equal(git(bare, ['rev-parse', `${head}^`]), tip);
    assert.equal(git(bare, ['rev-list', '--count', `${tip}..${head}`]), '1');
    git(bare, ['fsck', '--strict']);
  } finally {
    await s.handle.close();
  }
});

test('G-GS-9: a tag name, a non-tip expectedSha and a base beside an expectedSha are refused, and the branch does not move', async () => {
  const { root, bare, work, tip } = makeRoot();
  const first = git(work, ['rev-parse', 'main~1']); // a real commit that is not the tip
  const s = await loopback(root);
  const change = [{ path: 'a.txt', contentBase64: b64('z\n') }];
  const unchanged = () => {
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), tip);
    assert.equal(git(bare, ['rev-parse', 'refs/tags/v1']), tip);
    assert.deepEqual(git(bare, ['for-each-ref', '--format=%(refname)']).split('\n').sort(), ['refs/heads/main', 'refs/tags/v1']);
  };
  try {
    // An expectedSha that is a real commit but not the tip: 409 with the tip.
    const stale = await s.commit({ repo: 'notes', branch: 'main', expectedSha: first, message: 'm', changes: change });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.currentSha, tip);
    unchanged();
    // A baseSha together with a non-null expectedSha.
    const both = await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, baseSha: first, message: 'm', changes: change });
    assert.equal(both.status, 400);
    assert.equal(both.body.reason, 'base-with-expected');
    unchanged();
    // Only refs/heads/ is writable: nothing spelled as a branch reaches a tag.
    for (const branch of ['refs/tags/v1', '../tags/v1', 'v1^{}', 'tags/v1/..', '-x', 'main..v1', 'HEAD', '']) {
      const res = await s.commit({ repo: 'notes', branch, expectedSha: tip, message: 'm', changes: change });
      assert.ok(res.status === 400 || res.status === 409, `${branch}: ${res.status}`);
      unchanged();
    }
    // As a NEW branch the same names are refused by the name check itself, before
    // any ref is looked at: the answer is a 400 `branch`, and no ref appears.
    for (const branch of ['../tags/v1', 'v1^{}', '-x', 'main..v1', 'HEAD', '', 'a b', 'x.lock', '@{-1}']) {
      const res = await s.commit({ repo: 'notes', branch, expectedSha: null, baseSha: tip, message: 'm', changes: change });
      assert.equal(res.status, 400, `${JSON.stringify(branch)}: ${res.status}`);
      assert.equal(res.body.reason, 'branch', JSON.stringify(branch));
      unchanged();
    }
    // The tag's NAME as a branch is simply a new branch called v1, and needs a base.
    const tagName = await s.commit({ repo: 'notes', branch: 'v1', expectedSha: tip, message: 'm', changes: change });
    assert.equal(tagName.status, 409, 'refs/heads/v1 does not exist, so it is not at the expected tip');
    assert.equal(tagName.body.currentSha, null);
    unchanged();
    // An unknown base, and a base that is a tree, are refused.
    for (const baseSha of ['0123456789abcdef0123456789abcdef01234567', git(bare, ['rev-parse', `${tip}^{tree}`])]) {
      const res = await s.commit({ repo: 'notes', branch: 'fresh', expectedSha: null, baseSha, message: 'm', changes: change });
      assert.equal(res.status, 400, baseSha);
      assert.equal(res.body.reason, 'unknown-base');
      unchanged();
    }
    // No base at all for a new branch; empty changes; empty message; a huge message.
    assert.equal((await s.commit({ repo: 'notes', branch: 'fresh', expectedSha: null, message: 'm', changes: change })).body.reason, 'no-base');
    assert.equal((await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'm', changes: [] })).body.reason, 'no-changes');
    assert.equal((await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: '  \n', changes: change })).body.reason, 'message');
    assert.equal((await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'x'.repeat(64 * 1024 + 1), changes: change })).body.reason, 'message');
    assert.equal((await s.commit({ repo: 'absent', branch: 'main', expectedSha: tip, message: 'm', changes: change })).status, 404);
    assert.equal((await s.commit({ repo: '../notes', branch: 'main', expectedSha: tip, message: 'm', changes: change })).status, 400);
    unchanged();
    git(bare, ['fsck', '--strict']);
  } finally {
    await s.handle.close();
  }
});

test('G-GS-9: a new branch from baseSha lands; the same name again is a 409', async () => {
  const { root, bare, tip } = makeRoot();
  const s = await loopback(root);
  try {
    const body = { repo: 'notes', branch: 'feature/from-browser', expectedSha: null, baseSha: tip, message: 'branch', changes: [{ path: 'a.txt', contentBase64: b64('branched\n') }] };
    const made = await s.commit(body);
    assert.equal(made.status, 200, made.text);
    const head = git(bare, ['rev-parse', 'refs/heads/feature/from-browser']);
    assert.equal(made.body.commitSha, head);
    assert.equal(git(bare, ['rev-parse', `${head}^`]), tip);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), tip, 'the base branch is untouched');
    const again = await s.commit(body);
    assert.equal(again.status, 409);
    assert.equal(again.body.currentSha, head);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/feature/from-browser']), head);
    // A base that is the tag's commit works the same way (the mount was on a tag).
    const fromTag = await s.commit({ ...body, branch: 'from-tag', baseSha: git(bare, ['rev-parse', 'refs/tags/v1^{commit}']) });
    assert.equal(fromTag.status, 200);
    assert.equal(git(bare, ['rev-parse', 'refs/tags/v1']), tip, 'the tag is unchanged');
  } finally {
    await s.handle.close();
  }
});

// --- G-GS-14 -----------------------------------------------------------------

test('G-GS-14: the hostile-path table — each is a 400 naming the path, and the repository stays clean', async () => {
  const { root, bare, tip } = makeRoot();
  const s = await loopback(root);
  try {
    const hostile = [
      ['.git/config', 'path-refused'],
      ['.GIT/config', 'path-refused'],
      ['.git /x', 'path-refused'], // a trailing space (NTFS)
      ['GIT~1/x', 'path-refused'], // a short name (NTFS)
      ['.g‌it/x', 'path-refused'], // a zero-width character (HFS)
      ['a/../b', 'path-refused'],
      ['./a', 'path-refused'],
      ['a//b', 'path-refused'],
      ['dir/.git/hooks/pre-commit', 'path-refused'],
      ['a\\b', 'path-backslash'],
      ['.gitmodules', 'gitmodules'],
      ['.GITMODULES', 'gitmodules'],
      // The spellings an NTFS or HFS+ checkout resolves to .gitmodules. git's own
      // check refuses these for symlinks only, so the server must.
      ['.gitmodules ', 'gitmodules'],
      ['.gitmodules.', 'gitmodules'],
      ['.gitmodules. .', 'gitmodules'],
      ['GITMOD~1', 'gitmodules'],
      ['gi7eba~1', 'gitmodules'],
      ['.gitmodules::$DATA', 'gitmodules'],
      ['.gitmodules:$DATA', 'gitmodules'],
      ['.git\u200cmodules', 'gitmodules'],
      ['.gitmodules\u200d', 'gitmodules'],
      ['sub/dir/.GitModules', 'gitmodules'],
      ['link', 'under-symlink'], // the symlink entry itself
      ['link/inside', 'under-symlink'],
      ['vendor/sub', 'under-submodule'],
      ['vendor/sub/file', 'under-submodule'],
      ['dir', 'file-over-directory'],
      ['a.txt/child', 'directory-over-file'],
      ['/abs', 'path-malformed'],
      ['trailing/', 'path-malformed'],
      ['', 'path-malformed'],
      ['nul\0byte', 'path-malformed'],
      ['new\nline', 'path-malformed'],
    ];
    for (const [path, reason] of hostile) {
      const res = await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'hostile', changes: [{ path, contentBase64: b64('x') }] });
      assert.equal(res.status, 400, `${JSON.stringify(path)} → ${res.status} ${res.text}`);
      assert.equal(res.body.reason, reason, JSON.stringify(path));
      if (reason !== 'path-refused') assert.equal(res.body.path, path);
      else assert.ok(res.body.path === undefined || typeof res.body.path === 'string');
      assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), tip, `${JSON.stringify(path)} moved the branch`);
    }
    // A hostile path beside a good one refuses the whole request.
    const mixed = await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'mixed', changes: [{ path: 'good.txt', contentBase64: b64('x') }, { path: '.git/config', contentBase64: b64('x') }] });
    assert.equal(mixed.status, 400);
    assert.equal(mixed.body.path, '.git/config', 'git\'s refusal names the path');
    // Deletes: a symlink, a path under a submodule, an absent path, and .gitmodules.
    for (const [path, reason] of [['link', 'under-symlink'], ['vendor/sub', 'under-submodule'], ['nope.txt', 'delete-absent'], ['dir', 'delete-absent'], ['.gitmodules', 'gitmodules']]) {
      const res = await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'del', changes: [{ path, delete: true }] });
      assert.equal(res.status, 400, path);
      assert.equal(res.body.reason, reason, path);
    }
    // A duplicate path in one request.
    const dup = await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'dup', changes: [{ path: 'a.txt', contentBase64: b64('1') }, { path: 'a.txt', delete: true }] });
    assert.equal(dup.body.reason, 'path-duplicate');
    // A file and a directory of the same name in one request.
    const clash = await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'clash', changes: [{ path: 'n', contentBase64: b64('1') }, { path: 'n/m', contentBase64: b64('2') }] });
    assert.equal(clash.status, 400);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), tip);
    assert.deepEqual(git(bare, ['for-each-ref', '--format=%(refname)']).split('\n').sort(), ['refs/heads/main', 'refs/tags/v1']);
    git(bare, ['fsck', '--strict']);
    // Nothing was written into the repository's own files by any of it.
    assert.ok(!readFileSync(join(bare, 'config'), 'utf8').includes('x\n[') );
    assert.ok(!readdirSync(bare).includes('index'), 'the private index never lands in the repository');
  } finally {
    await s.handle.close();
  }
});

test('the temp index is removed after a success and after a refusal', async () => {
  const { root, bare, tip } = makeRoot();
  const s = await loopback(root);
  const scratchDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('git-serve-commit-'));
  try {
    const before = scratchDirs().length;
    const landed = await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'ok', changes: [{ path: 'a.txt', contentBase64: b64('1') }] });
    assert.equal(landed.status, 200, landed.text);
    const now = git(bare, ['rev-parse', 'refs/heads/main']);
    assert.notEqual(now, tip);
    // Two refusals that are made with the scratch index already on disk. Both
    // name the CURRENT tip, so neither is turned away earlier as a conflict.
    // A path only git's own check refuses, found when the index is read back:
    const hostile = await s.commit({ repo: 'notes', branch: 'main', expectedSha: now, message: 'bad', changes: [{ path: '.git/x', contentBase64: b64('3') }] });
    assert.equal(hostile.status, 400, hostile.text);
    assert.equal(hostile.body.reason, 'path-refused');
    // A change that changes nothing, found after the tree is written:
    const same = await s.commit({ repo: 'notes', branch: 'main', expectedSha: now, message: 'same', changes: [{ path: 'a.txt', contentBase64: b64('1') }] });
    assert.equal(same.status, 400, same.text);
    assert.equal(same.body.reason, 'no-change');
    // And one refused before any scratch directory is made.
    const stale = await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'stale', changes: [{ path: 'a.txt', contentBase64: b64('2') }] });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), now);
    assert.equal(scratchDirs().length, before);
  } finally {
    await s.handle.close();
  }
});

test('a new branch cannot take the name of an existing tag', async () => {
  const { root, bare, tip } = makeRoot(); // holds the tag v1
  const s = await loopback(root);
  const change = [{ path: 'a.txt', contentBase64: b64('under a tag name\n') }];
  const refs = () => git(bare, ['for-each-ref', '--format=%(refname) %(objectname)']);
  try {
    const before = refs();
    const res = await s.commit({ repo: 'notes', branch: 'v1', expectedSha: null, baseSha: tip, message: 'm', changes: change });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body.reason, 'branch', 'the reason an unusable branch name gets');
    assert.equal(refs(), before, 'no ref was created or moved');
    // A nested tag name is refused the same way; a name no tag has lands.
    git(bare, ['tag', 'release/1.0', tip]);
    const nested = await s.commit({ repo: 'notes', branch: 'release/1.0', expectedSha: null, baseSha: tip, message: 'm', changes: change });
    assert.equal(nested.status, 400, nested.text);
    assert.equal(nested.body.reason, 'branch');
    assert.equal((await tryRev(bare, 'refs/heads/release/1.0')), null);
    const free = await s.commit({ repo: 'notes', branch: 'v1-work', expectedSha: null, baseSha: tip, message: 'm', changes: change });
    assert.equal(free.status, 200, free.text);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/v1-work']), free.body.commitSha);
    assert.equal(git(bare, ['rev-parse', 'refs/tags/v1']), tip, 'the tag is unchanged');
  } finally {
    await s.handle.close();
  }
});

test('R-GS-22: the connection trailer joins the message\'s own trailer block, so the user\'s trailers survive', async () => {
  const { root, bare, tip } = makeRoot();
  const s = await loopback(root);
  const trailers = () => git(bare, ['log', '-1', '--format=%(trailers:only)', 'refs/heads/main']);
  const message = () => git(bare, ['log', '-1', '--format=%B', 'refs/heads/main']);
  let seq = 0;
  const commit = async (text) => {
    const res = await s.commit({ repo: 'notes', branch: 'main', expectedSha: git(bare, ['rev-parse', 'refs/heads/main']), message: text, changes: [{ path: 'a.txt', contentBase64: b64(`trailer ${++seq}\n`) }] });
    assert.equal(res.status, 200, res.text);
  };
  try {
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), tip);
    // The message ends in a trailer block: git must read all three as trailers.
    await commit('Subject\n\nBody text.\n\nSigned-off-by: Dev <dev@example.com>\nCo-authored-by: Pat <pat@example.com>\n');
    assert.equal(trailers(), 'Signed-off-by: Dev <dev@example.com>\nCo-authored-by: Pat <pat@example.com>\nGit-Serve-Connection: loopback');
    assert.equal(message(), 'Subject\n\nBody text.\n\nSigned-off-by: Dev <dev@example.com>\nCo-authored-by: Pat <pat@example.com>\nGit-Serve-Connection: loopback');
    // A subject and a trailer block, with no body between.
    await commit('Subject\n\nReviewed-by: Rev <rev@example.com>');
    assert.equal(trailers(), 'Reviewed-by: Rev <rev@example.com>\nGit-Serve-Connection: loopback');
    // A last paragraph of prose is not a trailer block: the trailer gets its own.
    await commit('Subject\n\nNote: this is prose,\nnot a trailer block.');
    assert.equal(trailers(), 'Git-Serve-Connection: loopback');
    assert.equal(message(), 'Subject\n\nNote: this is prose,\nnot a trailer block.\n\nGit-Serve-Connection: loopback');
    // A one-line message that looks like a trailer is a subject.
    await commit('Fix: the thing');
    assert.equal(trailers(), 'Git-Serve-Connection: loopback');
    assert.equal(message(), 'Fix: the thing\n\nGit-Serve-Connection: loopback');
    // A forged connection trailer inside a real trailer block is still refused.
    const head = git(bare, ['rev-parse', 'refs/heads/main']);
    const forged = await s.commit({ repo: 'notes', branch: 'main', expectedSha: head, message: 'Subject\n\nSigned-off-by: Dev <dev@example.com>\ngit-serve-connection : someone-else', changes: [{ path: 'a.txt', contentBase64: b64('forged\n') }] });
    assert.equal(forged.status, 400);
    assert.equal(forged.body.reason, 'message');
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), head);
  } finally {
    await s.handle.close();
  }
});

test('a branch that is a symbolic ref is refused: a commit never follows it to a tag', async () => {
  const { root, bare, tip } = makeRoot();
  git(bare, ['tag', 'rel', tip]);
  git(bare, ['symbolic-ref', 'refs/heads/alias', 'refs/tags/rel']);
  const s = await loopback(root);
  try {
    const res = await s.commit({ repo: 'notes', branch: 'alias', expectedSha: tip, message: 'm', changes: [{ path: 'a.txt', contentBase64: b64('via alias\n') }] });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body.reason, 'branch');
    assert.equal(git(bare, ['rev-parse', 'refs/tags/rel']), tip, 'the tag did not move');
  } finally {
    await s.handle.close();
  }
});

test('a failed swap is a conflict only when the branch moved', async () => {
  const { root, bare, tip } = makeRoot();
  const s = await loopback(root);
  const change = [{ path: 'a.txt', contentBase64: b64('swap\n') }];
  try {
    // A new branch whose name collides with an existing branch can never exist.
    const clash = await s.commit({ repo: 'notes', branch: 'main/x', expectedSha: null, baseSha: tip, message: 'm', changes: change });
    assert.equal(clash.status, 400, clash.text);
    assert.equal(clash.body.reason, 'branch');
    // A held lock on the ref: not a conflict (the tip is where the request said).
    writeFileSync(join(bare, 'refs', 'heads', 'main.lock'), '');
    const locked = await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'm', changes: change });
    assert.equal(locked.status, 500, locked.text);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), tip);
    rmSync(join(bare, 'refs', 'heads', 'main.lock'));
    assert.equal((await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'm', changes: change })).status, 200);
  } finally {
    await s.handle.close();
  }
});

test('a request that changes nothing is refused, not landed as an empty commit', async () => {
  const { root, bare, tip } = makeRoot();
  const s = await loopback(root);
  try {
    const res = await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'same', changes: [{ path: 'a.txt', contentBase64: b64('hello\n') }] });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body.reason, 'no-change');
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), tip);
  } finally {
    await s.handle.close();
  }
});

test('a small body cannot cost much: deep paths, long paths and huge change lists are refused at once', async () => {
  const { root, bare, tip } = makeRoot();
  const s = await loopback(root);
  try {
    const started = Date.now();
    // 120,000 segments in 240 KB: this used to stall the server and exhaust its heap.
    const deep = await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'm', changes: [{ path: 'a/'.repeat(120000) + 'f', contentBase64: '' }] });
    assert.equal(deep.status, 400);
    assert.equal(deep.body.reason, 'path-too-long');
    assert.equal(deep.body.path, undefined, 'the path is not echoed back');
    assert.equal((await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'm', changes: [{ path: 'a/'.repeat(64) + 'f', contentBase64: '' }] })).body.reason, 'path-too-long');
    assert.equal((await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'm', changes: [{ path: 'x'.repeat(4097), contentBase64: '' }] })).body.reason, 'path-too-long');
    const many = Array.from({ length: 2001 }, (_, i) => ({ path: `f${i}`, contentBase64: '' }));
    assert.equal((await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'm', changes: many })).body.reason, 'too-many-changes');
    assert.ok(Date.now() - started < 5000, `the four refusals took ${Date.now() - started} ms`);
    // The server is alive, and a path at the limits still commits.
    const ok = await s.commit({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'm', changes: [{ path: 'd/'.repeat(63) + 'f', contentBase64: b64('deep\n') }] });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), ok.body.commitSha);
  } finally {
    await s.handle.close();
  }
});

// --- G-GS-15 -----------------------------------------------------------------

test('G-GS-15: each of the two gates refuses alone — the flag, and the write scope', async () => {
  const identity = parseTailnetIdentity(readFileSync(join(FIXTURES, 'status.json'), 'utf8'));
  const sameUser = parseWhois(0, readFileSync(join(FIXTURES, 'same-user.json'), 'utf8'), '');
  const HOST = 'serving-node.example-tailnet.ts.net';
  const run = async (allowCommit) => {
    const { root, bare, tip } = makeRoot();
    const read = addConnection(root, 'read');
    const write = addConnection(root, 'write');
    const handle = await startGitServe({
      root,
      origin: ORIGIN,
      port: 0,
      allowCommit,
      identity: IDENTITY,
      log: () => {},
      tailnet: { host: HOST, address: '127.0.0.1', peerGate: { self: identity.self, allowUserIds: new Set(), whois: async () => sameUser } },
    });
    const commit = (token) =>
      post(handle.port, '/commit', {
        headers: { Host: `${HOST}:${handle.port}`, Authorization: `Bearer ${token}` },
        body: { repo: 'notes', branch: 'main', expectedSha: tip, message: 'gate', changes: [{ path: 'a.txt', contentBase64: b64('gate\n') }] },
      });
    return { handle, bare, tip, read, write, commit };
  };

  // Without --allow-commit, a `write` connection gets 403.
  const off = await run(false);
  try {
    const res = await off.commit(off.write.token);
    assert.equal(res.status, 403);
    assert.equal(res.body.reason, 'commit-disabled');
    assert.equal((await off.commit(off.read.token)).status, 403);
    assert.equal(git(off.bare, ['rev-parse', 'refs/heads/main']), off.tip);
  } finally {
    await off.handle.close();
  }

  // With it, a `read` connection gets 403, and a `write` one commits.
  const on = await run(true);
  try {
    const refused = await on.commit(on.read.token);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.reason, 'scope');
    assert.equal(git(on.bare, ['rev-parse', 'refs/heads/main']), on.tip);
    assert.equal((await on.commit('not-a-token')).status, 401);
    const ok = await on.commit(on.write.token);
    assert.equal(ok.status, 200, ok.text);
    // The trailer names the connection that committed.
    assert.equal(git(on.bare, ['log', '-1', '--format=%(trailers:key=Git-Serve-Connection,valueonly)', 'refs/heads/main']), on.write.record.id);
  } finally {
    await on.handle.close();
  }
});

test('G-GS-15: on loopback the flag is the one gate, and /meta reports it', async () => {
  const { root, bare, tip } = makeRoot();
  const meta = (port) =>
    new Promise((resolvePromise) => {
      http.get({ host: '127.0.0.1', port, path: '/meta', headers: { Origin: MEDIATOR, Authorization: `Bearer ${TOKEN}` } }, (r) => {
        let t = '';
        r.on('data', (c) => (t += c)).on('end', () => resolvePromise(JSON.parse(t)));
      });
    });
  const body = { repo: 'notes', branch: 'main', expectedSha: tip, message: 'm', changes: [{ path: 'a.txt', contentBase64: b64('1') }] };
  const off = await loopback(root, { allowCommit: false });
  try {
    assert.equal((await meta(off.handle.port)).allowCommit, false);
    const res = await off.commit(body);
    assert.equal(res.status, 403);
    assert.equal(res.body.reason, 'commit-disabled');
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), tip);
  } finally {
    await off.handle.close();
  }
  const on = await loopback(root, { allowCommit: true });
  try {
    assert.equal((await meta(on.handle.port)).allowCommit, true);
    assert.equal((await on.commit(body)).status, 200);
    // Still behind every browser-class guard.
    assert.equal((await post(on.handle.port, '/commit', { headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' }, body })).status, 403);
    assert.equal((await post(on.handle.port, '/commit', { body })).status, 401);
    assert.equal((await post(on.handle.port, `/commit?token=${TOKEN}`, { body })).status, 401);
  } finally {
    await on.handle.close();
  }
});

test('G-GS-15: a body one byte over the limit is a 413; one at the limit is read', async () => {
  const { root, bare, tip } = makeRoot();
  const s = await loopback(root);
  try {
    assert.equal(MAX_COMMIT_BODY_BYTES, 4 * 1024 * 1024);
    // Pad the JSON to an exact size with a large (valid) file content.
    const bodyOfSize = (size) => {
      const shell = JSON.stringify({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'big', changes: [{ path: 'big.bin', contentBase64: '' }] });
      const room = size - shell.length;
      const content = 'A'.repeat(room - (room % 4)); // valid base64
      const padded = JSON.stringify({ repo: 'notes', branch: 'main', expectedSha: tip, message: 'big', changes: [{ path: 'big.bin', contentBase64: content }] });
      return Buffer.from(padded + ' '.repeat(size - padded.length));
    };
    const over = await post(s.handle.port, '/commit', { headers: { Authorization: `Bearer ${TOKEN}` }, body: bodyOfSize(MAX_COMMIT_BODY_BYTES + 1) });
    assert.equal(over.status, 413, `over the limit: ${over.status} ${over.error ?? ''}`);
    assert.equal(over.body.reason, 'too-large');
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), tip, 'nothing landed');
    // Without a Content-Length (chunked), the count is made as the bytes arrive.
    const chunked = await new Promise((resolvePromise) => {
      const req = http.request(
        { host: '127.0.0.1', port: s.handle.port, path: '/commit', method: 'POST', headers: { Origin: MEDIATOR, Authorization: `Bearer ${TOKEN}`, 'Transfer-Encoding': 'chunked' } },
        (res) => res.resume().on('end', () => resolvePromise(res.statusCode)),
      );
      req.on('error', () => resolvePromise(0));
      const piece = Buffer.alloc(1024 * 1024, 0x20);
      for (let i = 0; i < 5; i++) req.write(piece);
      req.end();
    });
    assert.ok(chunked === 413 || chunked === 0, `chunked over the limit: ${chunked}`);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), tip);
    const at = await post(s.handle.port, '/commit', { headers: { Authorization: `Bearer ${TOKEN}` }, body: bodyOfSize(MAX_COMMIT_BODY_BYTES) });
    assert.equal(at.status, 200, at.text);
    assert.ok(Number(git(bare, ['cat-file', '-s', 'refs/heads/main:big.bin'])) > 3 * 1024 * 1024 - 4096);
  } finally {
    await s.handle.close();
  }
});

test('a body that is not JSON, or not an object, is a 400', async () => {
  const { root, tip } = makeRoot();
  const s = await loopback(root);
  try {
    for (const raw of ['', 'not json', '[]', 'null', '"x"', '{"repo":']) {
      const res = await post(s.handle.port, '/commit', { headers: { Authorization: `Bearer ${TOKEN}` }, body: Buffer.from(raw) });
      assert.equal(res.status, 400, JSON.stringify(raw));
    }
    for (const body of [
      { repo: 'notes', branch: 'main', expectedSha: tip.toUpperCase(), message: 'm', changes: [{ path: 'a', contentBase64: '' }] },
      { repo: 'notes', branch: 'main', expectedSha: 'main', message: 'm', changes: [{ path: 'a', contentBase64: '' }] },
      { repo: 'notes', branch: 'main', message: 'm', changes: [{ path: 'a', contentBase64: '' }] },
      { repo: 'notes', branch: 'main', expectedSha: tip, message: 'm', changes: [{ path: 'a', contentBase64: 'not base64!' }] },
      { repo: 'notes', branch: 'main', expectedSha: tip, message: 'm', changes: [{ path: 'a' }] },
      { repo: 'notes', branch: 'main', expectedSha: tip, message: 'm', changes: [{ path: 'a', delete: false }] },
      { repo: 'notes', branch: 'main', expectedSha: tip, message: 'm', changes: [{ path: 'a', delete: true, contentBase64: '' }] },
      { repo: 'notes', branch: 'main', expectedSha: tip, message: 'm', changes: 'a' },
      { repo: 'notes', branch: 'main', expectedSha: tip, message: 7, changes: [{ path: 'a', contentBase64: '' }] },
    ]) {
      assert.equal((await s.commit(body)).status, 400, JSON.stringify(body).slice(0, 120));
    }
  } finally {
    await s.handle.close();
  }
});

// --- units -------------------------------------------------------------------

test('planCommit: modes come from the parent tree, never from the request', () => {
  const parent = new Map([
    ['a.txt', { mode: '100644', sha: 'x' }],
    ['bin/run', { mode: '100755', sha: 'y' }],
  ]);
  const planned = planCommit(
    { repo: 'r', branch: 'b', expectedSha: null, message: 'm', changes: [{ path: 'bin/run', contentBase64: b64('1') }, { path: 'bin/new', contentBase64: b64('2') }, { path: 'a.txt', delete: true }] },
    parent,
  );
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.plan.writes.map((w) => [w.path, w.mode]), [['bin/run', '100755'], ['bin/new', '100644']]);
  assert.deepEqual(planned.plan.deletes, ['a.txt']);
});

test('parseCommitRequest and parseAuthor', () => {
  assert.equal(parseCommitRequest({ repo: 'r', branch: 'b', expectedSha: null, baseSha: 'a'.repeat(40), message: 'm', changes: [{ path: 'p', contentBase64: '' }] }).ok, true);
  assert.equal(parseCommitRequest({ repo: 'r', branch: 'b', expectedSha: null, baseSha: 'a'.repeat(40), message: 'm', changes: [{ path: 'p', contentBase64: '' }], force: true }).ok, false);
  assert.deepEqual(parseAuthor('Ada Lovelace <ada@example.com>'), { name: 'Ada Lovelace', email: 'ada@example.com' });
  assert.deepEqual(parseAuthor('  A  <a@b>  '), { name: 'A', email: 'a@b' });
  for (const bad of ['Ada', '<a@b>', 'A <a b>', 'A <a@b> x', '']) assert.equal(parseAuthor(bad), null, bad);
});

// --- the command -------------------------------------------------------------

const cli = (args, env = {}) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI_ENTRY, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
};

test('cli: --allow-commit without a git identity is a start-up error; a bad --author is refused', () => {
  const { root, dir } = makeRoot();
  // A HOME with no git config, and no system config: the machine has no identity.
  const home = join(dir, 'empty-home');
  mkdirSync(home);
  const noIdentity = { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'none') };
  const res = cli(['git-serve', root, '--port', '0', '--allow-commit'], noIdentity);
  assert.equal(res.code, 1);
  assert.match(res.out, /--author/);
  const bad = cli(['git-serve', root, '--port', '0', '--allow-commit', '--author', 'no email'], noIdentity);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /Name <email>/);
  const without = cli(['git-serve', root, '--port', '0', '--author', 'A <a@example.com>'], noIdentity);
  assert.equal(without.code, 1, '--author without --allow-commit is refused');
});
