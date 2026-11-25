# tailscale-whois fixtures

What the local Tailscale daemon reports about a connecting address, recorded on
a live tailnet for roadmap item R3-1356 and consumed by
`test/gitServePeerGate.test.mjs` (R3-1360, `GIT_SERVE_SPEC` R-GS-16, gate G-GS-7).

Recorded 2026-11-20 with Tailscale 1.104.7 on Linux (the first five files) and
2026-11-25 with Tailscale 1.104.7 on macOS (`other-user.json`, `tagged.json`), by
`scripts/record-tailscale-whois.mjs`, which runs the probes and replaces every
identifier (tailnet name, logins, node keys, addresses, ids) with a fixed
placeholder. Key names, value types and the relations between ids are as
recorded.

| File | Probe | Recorded |
|---|---|---|
| `same-user.json` | `tailscale whois --json <address of a second device of the same user>` | yes |
| `self.json` | `tailscale whois --json <the serving node's own address>` | yes |
| `unknown.json` | `tailscale whois --json <an unused 100.x address>` — the CLI prints no JSON; the file holds its exit code and streams | yes |
| `daemon-down.txt` | the same command against a socket path with no daemon behind it (tailscaled itself was not stopped: no root on the recording machine) | yes |
| `status.json` | the fields of `tailscale status --json` git-serve reads for the serving node | yes |
| `other-user.json` | `tailscale whois --json <address of another user's device>` — a second member of the tailnet, invited, its node signed in as that user | yes |
| `tagged.json` | `tailscale whois --json <address of a tagged node>` — tagged at sign-in by a tag owner (the serving node's own user). Its user ids are kept as recorded: they name no person | yes |

## What the recordings establish

- The stable user id of a peer is `UserProfile.ID`, a number. For a user-owned
  device it equals `Node.User`. The serving node's own is `Self.UserID` in
  `tailscale status --json`, the same number.
- `whois` on the node's own address answers with the node itself:
  `Node.StableID` equals `Self.ID`.
- An address that is no peer exits 1 with `peer not found` on stderr.
- An unreachable daemon exits 1 with `Failed to connect to local Tailscale daemon`.

- Another user's device carries that user's own id in both `UserProfile.ID`
  and `Node.User`, a number different from the serving node's.
- A tagged node does not carry the id of the user who created it. `Node.User`
  and `UserProfile.ID` both hold a shared pseudo-user (`LoginName`
  `tagged-devices`), and `Node.Tags` lists the tags. Comparing user ids alone
  therefore refuses it; the gate also refuses any non-empty `Node.Tags`.
- A tagged node's own `tailscale status --json` reports a non-zero
  `Self.UserID` of a different pseudo-user, private to that node (its
  `LoginName` is the node's DNS name). It is not the id peers see, and it is
  nobody's: a tagged serving node must not compare peers with it.

To record again, on the serving machine:

```
node scripts/record-tailscale-whois.mjs sanitize other-user <address of the other user's device>
node scripts/record-tailscale-whois.mjs sanitize tagged     <address of the tagged node>
```
