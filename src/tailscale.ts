/*
 * Tailscale discovery for `immediately-run dev --bind tailscale` (Tier-1.5,
 * LOCAL_DEVELOPMENT_SPEC §9.1). The CLI needs three facts about the local node:
 *
 *   - the MagicDNS hostname (`mac.<tailnet>.ts.net`) — the Host-header pin target
 *     and the `ir-endpoint` host the iPhone's Safari connects to;
 *   - a tailnet interface IP to bind (the `100.x` CGNAT address) — so the server
 *     listens on the tailscale interface only, never `0.0.0.0` (spec §8/§9.1);
 *   - a real Let's Encrypt cert for that hostname (`tailscale cert`), so Safari
 *     gets a publicly-trusted https origin with nothing to install on the phone.
 *
 * Subprocess access is isolated here; the JSON parsing is split into the pure
 * {@link parseTailscaleSelf} so it can be unit-tested without a live tailnet.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TailscaleSelf {
  /** MagicDNS hostname, trailing dot stripped (e.g. `mac.tailxyz.ts.net`). */
  dnsName: string;
  /** Tailnet interface IP to bind — the `100.64.0.0/10` CGNAT address when present. */
  address: string;
}

export interface TailscaleCert {
  cert: Buffer;
  key: Buffer;
}

// Resolve a working `tailscale` CLI: PATH first, then the common Homebrew paths
// and the macOS app bundle (the GUI app does not always symlink onto PATH).
const TS_BIN_CANDIDATES = [
  'tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
];

export const resolveTailscaleBin = (): string => {
  for (const bin of TS_BIN_CANDIDATES) {
    try {
      execFileSync(bin, ['version'], { stdio: 'ignore' });
      return bin;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(
    'tailscale CLI not found. Install Tailscale and ensure `tailscale` is on PATH ' +
      '(macOS app: /Applications/Tailscale.app/Contents/MacOS/Tailscale).',
  );
};

// Pure parse of `tailscale status --json`, split out so the discovery contract is
// unit-testable without a live tailnet. Prefers the IPv4 CGNAT (`100.x`) address
// for the interface bind, falling back to the first listed tailnet IP.
export const parseTailscaleSelf = (json: string): TailscaleSelf => {
  let status: { Self?: { DNSName?: unknown; TailscaleIPs?: unknown } };
  try {
    status = JSON.parse(json);
  } catch {
    throw new Error(
      '`tailscale status --json` did not return JSON — is Tailscale installed and running?',
    );
  }
  const self = status?.Self;
  if (!self) {
    throw new Error(
      '`tailscale status --json` reported no Self node — is tailscaled running and signed in?',
    );
  }
  const dnsName = String(self.DNSName ?? '').replace(/\.$/, '');
  if (!dnsName) {
    throw new Error(
      'This tailnet node has no MagicDNS name — enable MagicDNS in the tailnet admin console.',
    );
  }
  const ips: string[] = Array.isArray(self.TailscaleIPs)
    ? self.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string')
    : [];
  const address = ips.find((ip) => ip.startsWith('100.')) ?? ips[0];
  if (!address) {
    throw new Error('This tailnet node has no tailnet IP to bind.');
  }
  return { dnsName, address };
};

export const tailscaleSelf = (bin: string = resolveTailscaleBin()): TailscaleSelf =>
  parseTailscaleSelf(execFileSync(bin, ['status', '--json'], { encoding: 'utf8' }));

export interface ResolveCertOptions {
  /** Explicit cert path; the key is its `.key` sibling unless {@link keyPath} is set. */
  certPath?: string;
  keyPath?: string;
  /** tailscale binary (resolved lazily only if a mint is needed). */
  bin?: string;
  /** Directory to mint into when no cert is found (default: first search dir). */
  provisionInto?: string;
}

// Locate the `tailscale cert` output for `host` (`<host>.crt` + `<host>.key`).
// The tutorial has the user run `tailscale cert <host>` (writes to cwd); we look
// at an explicit override first, then each search dir, and finally mint one via
// `tailscale cert` if absent. A cert certifies the hostname (not a port), so the
// server can present it on its normal high port with no privileged bind.
export const resolveTailscaleCert = (
  host: string,
  searchDirs: readonly string[],
  opts: ResolveCertOptions = {},
): TailscaleCert => {
  if (opts.certPath) {
    const keyPath = opts.keyPath ?? opts.certPath.replace(/\.crt$/, '.key');
    return { cert: readFileSync(opts.certPath), key: readFileSync(keyPath) };
  }
  for (const dir of searchDirs) {
    const crt = join(dir, `${host}.crt`);
    const key = join(dir, `${host}.key`);
    if (existsSync(crt) && existsSync(key)) {
      return { cert: readFileSync(crt), key: readFileSync(key) };
    }
  }
  // Not found on disk — mint it. `tailscale cert` writes a real Let's Encrypt
  // cert for the MagicDNS hostname; it auto-renews on the ~90-day cycle.
  const dir = opts.provisionInto ?? searchDirs[0] ?? process.cwd();
  const crt = join(dir, `${host}.crt`);
  const key = join(dir, `${host}.key`);
  try {
    execFileSync(opts.bin ?? resolveTailscaleBin(), [
      'cert',
      '--cert-file',
      crt,
      '--key-file',
      key,
      host,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `No TLS certificate for ${host} (looked for ${host}.crt / ${host}.key in ` +
        `${searchDirs.join(', ')}) and \`tailscale cert ${host}\` failed: ${detail}. ` +
        `Run \`tailscale cert ${host}\` once in this directory, then retry.`,
    );
  }
  return { cert: readFileSync(crt), key: readFileSync(key) };
};
