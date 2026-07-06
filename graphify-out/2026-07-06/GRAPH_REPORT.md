# Graph Report - obsidian-decentralized  (2026-07-06)

## Corpus Check
- 15 files · ~29,076 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 430 nodes · 1117 edges · 28 communities (15 shown, 13 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `51fe3dff`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Core Plugin Logic|Core Plugin Logic]]
- [[_COMMUNITY_Types and Utilities|Types and Utilities]]
- [[_COMMUNITY_Conflict Resolution UI|Conflict Resolution UI]]
- [[_COMMUNITY_LAN Discovery|LAN Discovery]]
- [[_COMMUNITY_Package Configuration|Package Configuration]]
- [[_COMMUNITY_Direct IP Networking|Direct IP Networking]]
- [[_COMMUNITY_Connection Manager UI|Connection Manager UI]]
- [[_COMMUNITY_TypeScript Config|TypeScript Config]]
- [[_COMMUNITY_File System Operations|File System Operations]]
- [[_COMMUNITY_Conflict Resolution Logic|Conflict Resolution Logic]]
- [[_COMMUNITY_Plugin Manifest|Plugin Manifest]]
- [[_COMMUNITY_Readme Documentation|Readme Documentation]]
- [[_COMMUNITY_Settings Interface|Settings Interface]]
- [[_COMMUNITY_Git Analysis|Git Analysis]]
- [[_COMMUNITY_Graphify Agents|Graphify Agents]]
- [[_COMMUNITY_Network Queue Priority|Network Queue Priority]]
- [[_COMMUNITY_GitHub Actions|GitHub Actions]]
- [[_COMMUNITY_GRAPH_REPORT|GRAPH_REPORT.md]]
- [[_COMMUNITY_Graphify Usage Rule|Graphify Usage Rule]]
- [[_COMMUNITY_Graphify Workflow|Graphify Workflow]]
- [[_COMMUNITY_Companion Mode|Companion Mode]]
- [[_COMMUNITY_Direct IP Mode|Direct IP Mode]]
- [[_COMMUNITY_LAN Discovery|LAN Discovery]]
- [[_COMMUNITY_PeerJS|PeerJS]]
- [[_COMMUNITY_Signaling Server|Signaling Server]]
- [[_COMMUNITY_WebRTC|WebRTC]]

## God Nodes (most connected - your core abstractions)
1. `ObsidianDecentralizedPlugin` - 156 edges
2. `ConnectionModal` - 17 edges
3. `compilerOptions` - 16 edges
4. `DesktopLANDiscovery` - 15 edges
5. `DirectIpClient` - 14 edges
6. `PeerInfo` - 12 edges
7. `ILANDiscovery` - 12 edges
8. `Obsidian Decentralized` - 12 edges
9. `DirectIpServer` - 11 edges
10. `ObsidianDecentralizedSettingTab` - 10 edges

## Surprising Connections (you probably didn't know these)
- `ObsidianDecentralizedPlugin` --references--> `DirectIpServer`  [EXTRACTED]
  main.ts → directip.ts
- `ObsidianDecentralizedPlugin` --references--> `DirectIpClient`  [EXTRACTED]
  main.ts → directip.ts
- `ObsidianDecentralizedPlugin` --references--> `DeviceRole`  [EXTRACTED]
  main.ts → types.ts
- `ObsidianDecentralizedPlugin` --references--> `FailedSync`  [EXTRACTED]
  main.ts → types.ts
- `ObsidianDecentralizedPlugin` --references--> `ILANDiscovery`  [EXTRACTED]
  main.ts → types.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Performance Optimizations** — git_log_gethash_optimization, git_log_hash_cache_eviction, git_log_large_file_hashing, git_log_cached_read [INFERRED 0.95]

## Communities (28 total, 13 thin omitted)

### Community 0 - "Core Plugin Logic"
Cohesion: 0.09
Nodes (5): ObsidianDecentralizedPlugin, FileUpdatePayload, SyncTask, VersionVector, compressText()

### Community 1 - "Types and Utilities"
Cohesion: 0.05
Nodes (57): AckPayload, AdaptiveSyncConfig, BasePayload, BatchCompletePayload, BatchState, ClusterKickPayload, DEFAULT_SETTINGS, DeviceRole (+49 more)

### Community 2 - "Conflict Resolution UI"
Cohesion: 0.07
Nodes (8): BinaryConflictResolutionModal, ConflictCenter, ConflictListModal, ConflictResolutionModal, formatBytes(), QRScannerModal, SelectPeerModal, SyncProgressModal

### Community 3 - "LAN Discovery"
Cohesion: 0.11
Nodes (5): DesktopLANDiscovery, DummyLANDiscovery, DiscoveryBeacon, ILANDiscovery, PeerInfo

### Community 4 - "Package Configuration"
Cohesion: 0.07
Nodes (27): author, dependencies, html5-qrcode, pako, peerjs, qrcode, ws, description (+19 more)

### Community 5 - "Direct IP Networking"
Cohesion: 0.11
Nodes (9): decodeMessage(), DirectIpClient, DirectIpServer, encodeMessage(), ServerClientEntry, textDecoder, textEncoder, DirectIpConfig (+1 more)

### Community 6 - "Connection Manager UI"
Cohesion: 0.08
Nodes (8): ObsidianDecentralizedSettingTab, ClusterForgetPayload, ClusterGossipPayload, ClusterRenamePayload, CompanionPairPayload, SyncStatusState, VaultManifest, ConnectionModal

### Community 7 - "TypeScript Config"
Cohesion: 0.11
Nodes (17): compilerOptions, allowJs, baseUrl, esModuleInterop, importHelpers, inlineSourceMap, inlineSources, isolatedModules (+9 more)

### Community 8 - "File System Operations"
Cohesion: 0.31
Nodes (7): assert(), assertEquals(), fs, Module, obsidian, path, runTests()

### Community 11 - "Plugin Manifest"
Cohesion: 0.22
Nodes (8): author, authorUrl, description, id, isDesktopOnly, minAppVersion, name, version

### Community 12 - "Readme Documentation"
Cohesion: 0.10
Nodes (20): ⚙️ Configuration & Advanced Features, ⚔️ Conflict Center, Conflict Resolution, 🤝 Contributing, ✨ Core Features, Experimental: Direct IP Mode, 🚀 Getting Started: Connecting Your First Devices, 🤔 How It Works (+12 more)

### Community 14 - "Git Analysis"
Cohesion: 0.33
Nodes (6): Use cachedRead, getHash Optimization, Map Insertion Order Eviction, Large File Stat Hashing, ObsidianDecentralizedPlugin, Rename Vector Cache Transfer

### Community 16 - "Network Queue Priority"
Cohesion: 0.25
Nodes (4): diff-match-patch, EditorDeltaPayload, HandshakePayload, SyncData

## Knowledge Gaps
- **100 isolated node(s):** `textEncoder`, `textDecoder`, `ServerClientEntry`, `id`, `name` (+95 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **13 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ObsidianDecentralizedPlugin` connect `Core Plugin Logic` to `Types and Utilities`, `Conflict Resolution UI`, `LAN Discovery`, `Direct IP Networking`, `Connection Manager UI`, `Plugin Initialization`, `Network Queue Priority`?**
  _High betweenness centrality (0.345) - this node is a cross-community bridge._
- **Why does `dependencies` connect `Package Configuration` to `Network Queue Priority`?**
  _High betweenness centrality (0.093) - this node is a cross-community bridge._
- **Why does `diff-match-patch` connect `Network Queue Priority` to `Core Plugin Logic`, `Conflict Resolution UI`, `Package Configuration`?**
  _High betweenness centrality (0.089) - this node is a cross-community bridge._
- **What connects `textEncoder`, `textDecoder`, `ServerClientEntry` to the rest of the system?**
  _105 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Core Plugin Logic` be split into smaller, more focused modules?**
  _Cohesion score 0.09413233458177278 - nodes in this community are weakly interconnected._
- **Should `Types and Utilities` be split into smaller, more focused modules?**
  _Cohesion score 0.05110809588421529 - nodes in this community are weakly interconnected._
- **Should `Conflict Resolution UI` be split into smaller, more focused modules?**
  _Cohesion score 0.06890756302521009 - nodes in this community are weakly interconnected._