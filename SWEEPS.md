# V3 Release Audit — 50 Sweeps

Each sweep is one focused audit pass with a specific target and lens. Outcome is one of:
- **FIX** — defects found, fixed, pinned by tests (commit hash noted)
- **CLEAN** — no defects; evidence recorded (what was checked and why it holds)

Ledger is append-only per sweep. No sweep may be marked done without either a commit
containing its fix or a recorded justification with specific evidence.

| # | Target | Lens | Outcome | Commit |
|---|--------|------|---------|--------|
| 1 | settings-tab.ts | input validation, settings corruption | FIX — custom signaling server host/path accepted anything; "wss://server" (PeerJS docs' own spelling) built an unresolvable URL in `new Peer()` and the retry loop ran forever. Now normalized at input (settings-tab) and self-healed at load (main.ts loadSettings); helpers pinned in net.test.ts. Also verified: `addrs[0]` for "Copy IP and token" IS the preferred address (collectLocalIpv4 sorts best-first) — no defect. | (this commit) |
| 2 | ui.ts ConnectionModal + pairing flow | logic, race, leak | | |
| 3 | ui.ts remaining modals (QR, progress, confirm, binary conflict) | logic, error paths | | |
| 4 | types.ts | constants sanity, payload shapes vs handlers | | |
| 5 | core/storage impls (NodeFs, InMemory) | edge cases, contract honesty | | |
| 6 | main.ts | floating/unawaited promises | | |
| 7 | main.ts | memory bounds of every Map/Set | | |
| 8 | main.ts | peer-input validation per message type | | |
| 9 | main.ts lifecycle (onload/onunload) | registration vs teardown symmetry | | |
| 10 | main.ts vault events | debounce/ignore-window correctness | | |
| 11 | main.ts encryption (PSK, keys, wire) | failure containment, no plaintext fallback | | |
| 12 | main.ts send path (tasks → payloads) | stale-state, echo, delta fallback | | |
| 13 | main.ts chunked transfers | resumption, acks, integrity | | |
| 14 | main.ts receive apply (update/delta/delete) | conflict rules converge identically | | |
| 15 | main.ts receive apply (rename/folder) | scope guards, record moves | | |
| 16 | main.ts full-sync state machine | phase timeouts, batch accounting | | |
| 17 | main.ts Merkle reconciliation | traversal termination, both-direction exchange | | |
| 18 | main.ts locking + editor sync | deadlock, lock expiry, echo | | |
| 19 | main.ts heartbeat/liveness/status | false-dead, false-alive | | |
| 20 | QueueManager | epoch/dedup/retry/dispose races | | |
| 21 | ConnectionManager | backpressure waits, timeout leaks | | |
| 22 | core ConflictResolver (post-fix) | merge honesty, fallbacks | | |
| 23 | core MerkleManager + VersionVectorManager | diff correctness, algebra | | |
| 24 | ConfigSync | scope, trust, tombstones, baseline races | | |
| 25 | DirectIpServer | admission, reaper, replacement | | |
| 26 | DirectIpClient | backoff, fatal paths, buffer drain | | |
| 27 | SecureChannel (directip) | ordering, auth binding | | |
| 28 | discovery.ts | beacon lifecycle, listener leaks | | |
| 29 | peerjs integration | glare, duplicates, stale-peer events | | |
| 30 | utils framing (pack/unpack/TLV/base64/deflate) | truncation, overflow guards | | |
| 31 | utils versions.ts | property tests: symmetry, determinism | | |
| 32 | utils pairing/device-name/peer-error/net | edge inputs | | |
| 33 | utils direct-ip-auth.ts | crypto correctness, constant-time | | |
| 34 | manifest/state persistence (state.json, queue.json, hash-cache) | atomicity, recovery, migration | | |
| 35 | tombstone retention & pruning | expiry, resurrection windows | | |
| 36 | failed-sync retry machinery | backoff, retry caps, duplication | | |
| 37 | test suite audit | vacuous/weak tests | | |
| 38 | simulation ↔ production parity | model matches utils/versions decisions | | |
| 39 | jest mocks fidelity | obsidian/peerjs mocks vs real behavior | | |
| 40 | failure-path e2e coverage | offline edits, mid-sync drop, restart | | |
| 41 | README accuracy | claims vs behavior | | |
| 42 | constants & timeouts vs real networks | BATCH_TIMEOUT etc. vs slow links | | |
| 43 | rollup/build/CI config | build integrity, CI gates | | |
| 44 | property: pickVersion/newerVersion | symmetry across orderings | | |
| 45 | property: sanitizeVaultPath fuzz | traversal/encoding attacks | | |
| 46 | property: TLV/framing round-trip | fuzz round-trips | | |
| 47 | chaos: 3+ device mesh convergence | partition/heal matrix | | |
| 48 | e2e: three-device conflict convergence | same winner everywhere | | |
| 49 | e2e: rename/delete across three devices | tombstone propagation | | |
| 50 | final verification | all gates, release checklist | | |
