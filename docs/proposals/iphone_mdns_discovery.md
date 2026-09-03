# Proposal: mDNS/Bonjour discovery of the iPhone HUD (W2 addressing)

**Status: ADOPTED AND IMPLEMENTED ON BOTH SIDES — this document is now
historical.** Written 2026-07-10 as the Windows side's suggestion; adopted
canonically by `iPhone_rc` (Codex-maintained, the owner of the bridge
contract), which has advertised since `1e332ef`. The canonical Discovery
section is mirrored into `docs/windows_bridge_contract.md` at rev `84532ed`
(2026-07-14) — **that section, not this file, is the authority**. The Windows
side was built 2026-07-25 (VR-FPV batch CB4); see "As built" at the end.

The proposal below is preserved as written. Where it differs from the
canonical section, the canonical section wins; the service definition it
proposed was in fact adopted unchanged (service type, instance name, SRV port,
and all five TXT keys `v/role/tport/feat/dev` with the same meanings).

## Motivation

The Windows ground station needs the iPhone's IP address as the destination
for W2 telemetry (UDP 5601). Today the setup flow offers manual entry plus a
"last W3 sender" suggestion — both work, but both need the user to know or
produce the address. Bonjour discovery makes the phone announce itself:
zero-config addressing on any network, including the `W17-GRID` hotspot.

Discovery direction: **Windows discovers the iPhone** (Windows needs the W2
destination; nothing about W3 changes — it stays receive-only and LOG-ONLY).

## Service definition (what the iPhone advertises)

- Service type: `_w17hud._udp.local.`
- Instance name: `W17 HUD (<user's device name>)`
- Port: the iPhone app's W2 telemetry **listen** port (default `5601`)
- TXT record keys (all ASCII, all optional except `v`):

| Key | Value | Meaning |
|---|---|---|
| `v` | `1` | bridge contract version the app speaks |
| `role` | `hud` | future-proofing if other peers ever advertise |
| `tport` | `5601` | telemetry listen port (mirrors the SRV port) |
| `feat` | `w2` or `w2,w3` | whether the app will also emit W3 head-tracking intent |
| `dev` | short device name | display label for the Windows picker |

## Windows consumption (this repo, later milestone)

- Plugs into the existing seam `shared/addressProviders.mjs` →
  `mdnsCandidates()` (a declared stub today; the setup UI already merges
  candidate lists).
- Resolved addresses are **hints only**: shown in the PIT WALL address field
  as candidates the user confirms by hand — never auto-applied. The GRID
  reachability check stays the ground truth.
- Implementation options (decide at build time): a minimal one-shot mDNS
  query over `node:dgram` (PTR → SRV/TXT/A on 224.0.0.251:5353), or a vetted
  dependency. The repo's no-runtime-deps preference suggests the former.

## Safety notes

- mDNS is unauthenticated local-network chatter. A spoofed advertisement can
  at worst cause Windows to offer a wrong candidate; because candidates are
  user-confirmed and W2 is SEND-ONLY display telemetry, the worst case is
  telemetry JSON sent to a wrong local host. No control semantics ride on
  discovery, W3 stays log-only, and nothing here touches the firmware or any
  control path.
- The advertisement contains no secrets (device name is user-visible anyway).

## What iPhone_rc must implement

1. `NWListener` (or NetService) advertising `_w17hud._udp` with the TXT
   record above, active while the HUD app is foregrounded and its telemetry
   receiver is listening; withdrawn on background/stop.
2. `Info.plist`: `NSBonjourServices` = `_w17hud._udp`, plus the
   `NSLocalNetworkUsageDescription` string (required by iOS for local
   network access — the app likely already has it for UDP).
3. Contract addendum in `iPhone_rc/docs/windows_bridge_contract.md`
   (new "Discovery" section): service type, TXT keys, and the rule that
   discovery is advisory — receivers must treat it as a hint, not authority.
   Bump guidance: adding TXT keys is backward-compatible; changing the
   service type or key meanings requires a `v` bump.

## Rollout

1. iPhone_rc adopts (or amends) this proposal and lands the advertisement +
   contract addendum.
2. This repo re-syncs its contract copy (§1–7 verbatim, per the header rule)
   and implements `mdnsCandidates()` behind the existing seam.
3. Bench validation on the hotspot and on a shared network; only then does
   the suggestion chip start offering mDNS candidates.

Steps 1 and 2 are **done** (2026-07-14 / 2026-07-25). Step 3 is **PENDING** —
no iPhone on hand, and the office guest network isolates clients.

---

## As built (Windows side, 2026-07-25 — VR-FPV batch CB4)

The proposal's "decide at build time" question was settled in favour of the
hand-rolled option: **no dependency was added.** Three modules, each with its
own hermetic tests:

| Module | Role |
|---|---|
| `shared/dnsWire.js` | DNS/mDNS wire codec — encode one query, decode a response |
| `shared/hudDiscovery.js` | contract policy — which advertisements become candidates |
| `main/HudDiscovery.js` | `node:dgram` transport, cache, lifecycle |

Decisions that go beyond what the proposal specified, all made because
discovery is advisory and must never become a liability:

- **No new IPC or preload surface.** Discovered HUDs ride the existing
  `setup:addr-hint` channel alongside the last-W3-sender hint — that channel
  already answers "what could the iPhone's address be?". The preload surface
  stays unchanged by this feature — pinned by `test/ipcSurface.test.js` at
  exactly 28 methods as of the 2026-08-17 race-day wave (24 before it; this
  proposal's mDNS work added none of the four RACE DAY keys and predates
  that count).
- **Demand-driven.** The socket opens and the query goes out only while the
  setup flow polls for a suggestion (PIT WALL active). No background browsing,
  and therefore no env-var gate: not looking is the off switch.
- **Ephemeral port + QU bit**, not a bind on 5353 — Windows runs its own mDNS
  responder, so a shared bind is the most likely thing to fail on the
  deployment target. Trade-off: unicast answers carry short TTLs, some
  responders rate-limit them, and a responder that answers the first QU query
  by multicast (RFC 6762 §5.4) will not be heard.
- **The query goes out of EVERY local IPv4 interface**, with IP TTL 255. The
  bench host is multi-homed by design (office Wi-Fi or Ethernet holding the
  default route, plus the hotspot/RT5370 adapter the phone is actually on); a
  plain send follows the routing table and would silently never reach the
  phone's subnet.
- **A TTL-0 goodbye retires the entry** (RFC 6762 §10.1) instead of refreshing
  it — caching a withdrawal as a sighting would extend the suggestion's life by
  another 30 s, exactly backwards. The lowest TTL across an instance's records
  wins.
- **Never in SIM mode.** `W17_WIFI_SIM` presents a canned network step, and a
  simulated step must not put real multicast on a real LAN.
- **Decline reasons are logged** (bounded to 5 per socket), because "why is my
  phone not being offered?" is the first question a bench session will ask.
- **Sender must match the advertised address.** An advertisement naming a
  different host than the datagram's sender is declined and logged (bounded to
  5 lines) — a spoofer on the link cannot get a third host offered.
- **`tport` must match the SRV port**; a disagreement is declined rather than
  guessed at, per the contract's "must match" rule.
- **Everything ages out** (30 s) and is capped (8 candidates, 32-char ASCII
  device label), because the phone withdraws its advertisement when it
  backgrounds and we may never see the goodbye.

### Known residual limitations (accepted, not defects)

- **Real-device verification is PENDING.** Every test is a byte fixture; no
  advertising iPhone has been observed by this code. The assumptions a real
  device would test first are the QU-bit response behavior and the
  sender/address match; both name themselves in the log when they decline
  something.
- **Subnet-directed broadcast addresses are not rejected.** `x.x.x.255` on a /24
  passes validation because the netmask is not knowable from an advertisement,
  and rejecting a trailing `.255` outright would wrongly drop legitimate hosts
  on larger subnets. Bounded consequence: an operator who confirms such an
  address sends display-only telemetry to a broadcast address. Discovery adds
  no control authority and the GRID ping remains ground truth.
- **Wall-clock, not monotonic.** A large backwards clock step pauses querying
  and freezes entry ages until it catches up. This matches every other timing
  seam in the repo (`main/remoteAddrHint.js` and friends all take
  `clock = () => Date.now()`); diverging here alone was judged not worth it.
