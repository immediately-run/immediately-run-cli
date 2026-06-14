import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../dist/args.js';
import {
  runPreAuth,
  buildPreAuthBody,
  preAuthUrl,
  reportOutcome,
  PREAUTH_USAGE,
  ID_TOKEN_ENV,
} from '../dist/commands/preauth.js';

// A stub fetch that records the request and returns a canned response.
const stubFetch = (status, body) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status, json: async () => body };
  };
  return { fetchImpl, calls };
};

const collect = () => {
  const out = [];
  return { sink: (m) => out.push(m), out };
};

const baseDeps = (over = {}) => {
  const log = collect();
  const errorLog = collect();
  return {
    deps: {
      readFile: () => {
        throw new Error('no policy file in this test');
      },
      env: {},
      log: log.sink,
      errorLog: errorLog.sink,
      ...over,
    },
    log,
    errorLog,
  };
};

test('preauth — a clean policy POSTs the body with bearer token + Origin and exits 0', async () => {
  const { fetchImpl, calls } = stubFetch(200, { ok: true, mint: { ok: true, netFetchOk: true, minted: [] } });
  const { deps, log } = baseDeps({ fetchImpl });
  const args = parseArgs([
    'github__acme__headless-runner',
    '--capabilities', 'net:fetch',
    '--net-fetch', 'https://api.example.com',
    '--token', 'id-token-123',
  ]);

  const code = await runPreAuth(args, deps);
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://immediately.run/api/v1/preauth');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer id-token-123');
  assert.equal(calls[0].init.headers.origin, 'https://immediately.run');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    appKey: 'github__acme__headless-runner',
    capabilities: ['net:fetch'],
    mounts: [],
    netFetchHosts: [{ origin: 'https://api.example.com' }],
  });
  assert.ok(log.out.join('\n').includes('Applied pre-auth'));
});

test('preauth — an over-broad policy (422) surfaces every refusal and exits non-zero, minting nothing', async () => {
  const { fetchImpl, calls } = stubFetch(422, {
    ok: false,
    code: 'refused',
    refused: [
      { capability: 'spaces:user', reason: 'broad-elevated' },
      { capability: 'bogus:x', reason: 'unknown' },
    ],
  });
  const { deps, errorLog } = baseDeps({ fetchImpl });
  const args = parseArgs([
    'github__acme__headless-runner',
    '--capabilities', 'net:fetch,spaces:user,bogus:x',
    '--token', 'id-token-123',
  ]);

  const code = await runPreAuth(args, deps);
  assert.notEqual(code, 0);
  assert.equal(code, 1);
  // The request was made (one POST) but the backend refused it whole.
  assert.equal(calls.length, 1);
  const errs = errorLog.out.join('\n');
  assert.ok(errs.includes('spaces:user: broad-elevated'));
  assert.ok(errs.includes('bogus:x: unknown'));
  assert.ok(errs.includes('NOTHING was minted'));
});

test('preauth — missing token never hits the network and exits 2', async () => {
  const { fetchImpl, calls } = stubFetch(200, { ok: true });
  const { deps, errorLog } = baseDeps({ fetchImpl });
  const code = await runPreAuth(parseArgs(['app', '--capabilities', 'net:fetch']), deps);
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
  assert.ok(errorLog.out.join('\n').includes(ID_TOKEN_ENV));
});

test('preauth — an unrecognized --origin without --origin-unsafe is refused (exit 2, no network)', async () => {
  const { fetchImpl, calls } = stubFetch(200, { ok: true });
  const { deps } = baseDeps({ fetchImpl });
  const code = await runPreAuth(
    parseArgs(['app', '--capabilities', 'net:fetch', '--token', 't', '--origin', 'https://evil.example']),
    deps,
  );
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
});

test('preauth — the ID token can come from the environment', async () => {
  const { fetchImpl, calls } = stubFetch(200, { ok: true, mint: {} });
  const { deps } = baseDeps({ fetchImpl, env: { [ID_TOKEN_ENV]: 'env-token' } });
  const code = await runPreAuth(parseArgs(['app', '--capabilities', 'net:fetch']), deps);
  assert.equal(code, 0);
  assert.equal(calls[0].init.headers.authorization, 'Bearer env-token');
});

test('preauth — a network failure exits 3', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const { deps, errorLog } = baseDeps({ fetchImpl });
  const code = await runPreAuth(parseArgs(['app', '--capabilities', 'net:fetch', '--token', 't']), deps);
  assert.equal(code, 3);
  assert.ok(errorLog.out.join('\n').includes('Network error'));
});

test('buildPreAuthBody — reads a --policy file and lets the positional override appKey', () => {
  const policy = JSON.stringify({
    appKey: 'from-file',
    capabilities: ['task:invoke'],
    netFetchHosts: [{ origin: 'https://a.example' }],
  });
  const built = buildPreAuthBody(parseArgs(['positional-app', '--policy', 'p.json']), {
    readFile: () => policy,
  });
  assert.ok(built.ok);
  assert.equal(built.body.appKey, 'positional-app');
  assert.deepEqual(built.body.capabilities, ['task:invoke']);
  assert.deepEqual(built.body.netFetchHosts, [{ origin: 'https://a.example' }]);
});

test('buildPreAuthBody — fail-closed on missing appKey and on an empty policy', () => {
  const noApp = buildPreAuthBody(parseArgs(['--capabilities', 'net:fetch']), { readFile: () => '{}' });
  assert.equal(noApp.ok, false);
  const empty = buildPreAuthBody(parseArgs(['app']), { readFile: () => '{}' });
  assert.equal(empty.ok, false);
});

test('preAuthUrl — targets the shared API prefix and normalizes trailing slashes', () => {
  assert.equal(preAuthUrl('https://immediately.run'), 'https://immediately.run/api/v1/preauth');
  assert.equal(preAuthUrl('https://immediately.run/'), 'https://immediately.run/api/v1/preauth');
});

test('reportOutcome — a 200 with a falsy ok body is not treated as success', () => {
  const errorLog = collect();
  const log = collect();
  const code = reportOutcome(
    { status: 200, json: { ok: false } },
    { appKey: 'a', capabilities: [], mounts: [], netFetchHosts: [] },
    { log: log.sink, errorLog: errorLog.sink },
    false,
  );
  assert.notEqual(code, 0);
});

test('preauth --help documents the policy shape and the --origin override', async () => {
  const { deps, log } = baseDeps();
  const code = await runPreAuth(parseArgs(['--help']), deps);
  assert.equal(code, 0);
  const help = log.out.join('\n');
  assert.ok(help === PREAUTH_USAGE || help.includes('--policy'));
  assert.ok(help.includes('--policy'));
  assert.ok(help.includes('--origin'));
  assert.ok(help.includes('capabilities'));
});
