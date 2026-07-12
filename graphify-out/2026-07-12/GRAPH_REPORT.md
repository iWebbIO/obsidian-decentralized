# Graph Report - obsidian-decentralized  (2026-07-11)

## Corpus Check
- 30 files · ~32,813 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 521 nodes · 1260 edges · 37 communities (18 shown, 19 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b0689961`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Main Plugin Controller|Main Plugin Controller]]
- [[_COMMUNITY_Type Definitions|Type Definitions]]
- [[_COMMUNITY_Core Managers and Utilities|Core Managers and Utilities]]
- [[_COMMUNITY_UI and Connection Handling|UI and Connection Handling]]
- [[_COMMUNITY_Direct IP and Websockets|Direct IP and Websockets]]
- [[_COMMUNITY_Package Config and Conflict UI|Package Config and Conflict UI]]
- [[_COMMUNITY_Modals and Conflict Center|Modals and Conflict Center]]
- [[_COMMUNITY_LAN Discovery|LAN Discovery]]
- [[_COMMUNITY_Documentation|Documentation]]
- [[_COMMUNITY_Obsidian API Mocks|Obsidian API Mocks]]
- [[_COMMUNITY_TypeScript Configuration|TypeScript Configuration]]
- [[_COMMUNITY_Plugin Manifest|Plugin Manifest]]
- [[_COMMUNITY_Test Utilities|Test Utilities]]
- [[_COMMUNITY_Datagram Mocks|Datagram Mocks]]
- [[_COMMUNITY_Discovery Types|Discovery Types]]
- [[_COMMUNITY_Git Log Analysis|Git Log Analysis]]
- [[_COMMUNITY_Graphify Agent Rule|Graphify Agent Rule]]
- [[_COMMUNITY_Graphify Workflow|Graphify Workflow]]
- [[_COMMUNITY_Sync Error Types|Sync Error Types]]
- [[_COMMUNITY_Graphify Rule Sub-component|Graphify Rule Sub-component]]
- [[_COMMUNITY_Graphify Report Rule|Graphify Report Rule]]
- [[_COMMUNITY_Agent Tools Configuration|Agent Tools Configuration]]
- [[_COMMUNITY_Graphify Workflow Logic|Graphify Workflow Logic]]
- [[_COMMUNITY_GitHub Actions Workflow|GitHub Actions Workflow]]
- [[_COMMUNITY_Readme Companion Mode|Readme Companion Mode]]
- [[_COMMUNITY_Readme Direct IP|Readme Direct IP]]
- [[_COMMUNITY_Readme LAN Discovery|Readme LAN Discovery]]
- [[_COMMUNITY_Readme PeerJS|Readme PeerJS]]
- [[_COMMUNITY_Readme Signaling Server|Readme Signaling Server]]
- [[_COMMUNITY_Readme WebRTC|Readme WebRTC]]
- [[_COMMUNITY_FileManager|FileManager]]
- [[_COMMUNITY_.broadcastData|.broadcastData]]
- [[_COMMUNITY_BinaryConflictResolutionModal|BinaryConflictResolutionModal]]
- [[_COMMUNITY_QRScannerModal|QRScannerModal]]

## God Nodes (most connected - your core abstractions)
1. `ObsidianDecentralizedPlugin` - 161 edges
2. `TimeoutManager` - 19 edges
3. `ConnectionModal` - 17 edges
4. `DesktopLANDiscovery` - 16 edges
5. `QueueManager` - 16 edges
6. `compilerOptions` - 16 edges
7. `DirectIpClient` - 15 edges
8. `PeerInfo` - 13 edges
9. `DirectIpServer` - 12 edges
10. `ILANDiscovery` - 12 edges

## Surprising Connections (you probably didn't know these)
- `ObsidianDecentralizedPlugin` --references--> `DirectIpServer`  [EXTRACTED]
  main.ts → directip.ts
- `ObsidianDecentralizedPlugin` --references--> `DirectIpClient`  [EXTRACTED]
  main.ts → directip.ts
- `DesktopLANDiscovery` --references--> `PeerInfo`  [EXTRACTED]
  discovery.ts → types.ts
- `ObsidianDecentralizedPlugin` --references--> `ConnectionManager`  [EXTRACTED]
  main.ts → src/core/ConnectionManager.ts
- `ObsidianDecentralizedPlugin` --references--> `FileManager`  [EXTRACTED]
  main.ts → src/core/FileManager.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Performance Optimizations** — git_log_gethash_optimization, git_log_hash_cache_eviction, git_log_large_file_hashing, git_log_cached_read [INFERRED 0.95]

## Communities (37 total, 19 thin omitted)

### Community 0 - "Main Plugin Controller"
Cohesion: 0.08
Nodes (3): ObsidianDecentralizedPlugin, FileUpdatePayload, VersionVector

### Community 1 - "Type Definitions"
Cohesion: 0.06
Nodes (55): NOTE: lastSentContent eviction is handled by the 60-s cleanupPendingChunks inter, AckPayload, AdaptiveSyncConfig, BasePayload, BatchCompletePayload, BatchState, ClusterForgetPayload, ClusterGossipPayload (+47 more)

### Community 2 - "Core Managers and Utilities"
Cohesion: 0.09
Nodes (9): ConnectionManager, QueueItem, QueueManager, TODO: implement loadQueueFromDisk() using IndexedDB or vault adapter to survive, TODO: implement saveQueueToDisk() to persist queue state; call it on addToQueue/, TODO: call loadQueueFromDisk() here once IndexedDB persistence is implemented, SyncEngine, TimeoutManager (+1 more)

### Community 3 - "UI and Connection Handling"
Cohesion: 0.09
Nodes (3): ObsidianDecentralizedSettingTab, SyncStatusState, ConnectionModal

### Community 4 - "Direct IP and Websockets"
Cohesion: 0.09
Nodes (10): decodeMessage(), DirectIpClient, DirectIpServer, encodeMessage(), ServerClientEntry, textDecoder, textEncoder, MockWebSocket (+2 more)

### Community 5 - "Package Config and Conflict UI"
Cohesion: 0.06
Nodes (31): author, dependencies, diff-match-patch, html5-qrcode, pako, peerjs, qrcode, description (+23 more)

### Community 6 - "Modals and Conflict Center"
Cohesion: 0.15
Nodes (6): DEFAULT_SETTINGS, DiscoveryBeacon, PeerInfo, formatBytes(), SelectPeerModal, SyncProgressModal

### Community 7 - "LAN Discovery"
Cohesion: 0.11
Nodes (3): DesktopLANDiscovery, DummyLANDiscovery, ILANDiscovery

### Community 8 - "Documentation"
Cohesion: 0.10
Nodes (20): ⚙️ Configuration & Advanced Features, ⚔️ Conflict Center, Conflict Resolution, 🤝 Contributing, ✨ Core Features, Experimental: Direct IP Mode, 🚀 Getting Started: Connecting Your First Devices, 🤔 How It Works (+12 more)

### Community 9 - "Obsidian API Mocks"
Cohesion: 0.10
Nodes (6): Modal, Notice, Platform, Setting, TFile, obsidian

### Community 10 - "TypeScript Configuration"
Cohesion: 0.11
Nodes (17): compilerOptions, allowJs, baseUrl, esModuleInterop, importHelpers, inlineSourceMap, inlineSources, isolatedModules (+9 more)

### Community 11 - "Plugin Manifest"
Cohesion: 0.22
Nodes (8): author, authorUrl, description, id, isDesktopOnly, minAppVersion, name, version

### Community 12 - "Test Utilities"
Cohesion: 0.28
Nodes (7): assert(), assertEquals(), fs, Module, obsidian, path, runTests()

### Community 15 - "Git Log Analysis"
Cohesion: 0.33
Nodes (6): Use cachedRead, getHash Optimization, Map Insertion Order Eviction, Large File Stat Hashing, ObsidianDecentralizedPlugin, Rename Vector Cache Transfer

### Community 19 - "Sync Error Types"
Cohesion: 0.20
Nodes (12): FileBatchBinaryPayload, SyncError, SyncErrorCategory, arrayBufferToBase64(), base64ToArrayBuffer(), compressText(), decompressText(), PackedFile (+4 more)

## Knowledge Gaps
- **103 isolated node(s):** `Platform`, `textEncoder`, `textDecoder`, `ServerClientEntry`, `id` (+98 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **19 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ObsidianDecentralizedPlugin` connect `Main Plugin Controller` to `Type Definitions`, `.broadcastData`, `UI and Connection Handling`, `Direct IP and Websockets`, `Package Config and Conflict UI`, `Core Managers and Utilities`, `FileManager`, `LAN Discovery`, `Modals and Conflict Center`, `Discovery Types`, `Sync Error Types`?**
  _High betweenness centrality (0.347) - this node is a cross-community bridge._
- **Why does `dependencies` connect `Package Config and Conflict UI` to `Direct IP and Websockets`?**
  _High betweenness centrality (0.139) - this node is a cross-community bridge._
- **Why does `diff-match-patch` connect `Package Config and Conflict UI` to `Main Plugin Controller`?**
  _High betweenness centrality (0.127) - this node is a cross-community bridge._
- **What connects `Platform`, `textEncoder`, `textDecoder` to the rest of the system?**
  _112 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Main Plugin Controller` be split into smaller, more focused modules?**
  _Cohesion score 0.0822638333683989 - nodes in this community are weakly interconnected._
- **Should `Type Definitions` be split into smaller, more focused modules?**
  _Cohesion score 0.05952380952380952 - nodes in this community are weakly interconnected._
- **Should `Core Managers and Utilities` be split into smaller, more focused modules?**
  _Cohesion score 0.08858858858858859 - nodes in this community are weakly interconnected._