# Proposal: mDNS/Bonjour discovery of the iPhone HUD (W2 addressing)

**Status: PROPOSAL ONLY — nothing is implemented on either side.**
Owner of the canonical bridge contract is the iPhone app repo (`iPhone_rc`,
Codex-maintained). This document is the Windows side's concrete suggestion,
written so it can be adopted there and mirrored back here deliberately, per
the bridge-contract rule (no unilateral contract changes). Date: 2026-07-10.

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
