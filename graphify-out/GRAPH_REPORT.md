# Graph Report - .  (2026-07-06)

## Corpus Check
- Corpus is ~29,071 words - fits in a single context window. You may not need a graph.

## Summary
- 397 nodes · 933 edges · 19 communities (14 shown, 5 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 5 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

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
- [[_COMMUNITY_Plugin Initialization|Plugin Initialization]]
- [[_COMMUNITY_Plugin Manifest|Plugin Manifest]]
- [[_COMMUNITY_Readme Documentation|Readme Documentation]]
- [[_COMMUNITY_Settings Interface|Settings Interface]]
- [[_COMMUNITY_Git Analysis|Git Analysis]]
- [[_COMMUNITY_Graphify Agents|Graphify Agents]]
- [[_COMMUNITY_Network Queue Priority|Network Queue Priority]]
- [[_COMMUNITY_GitHub Actions|GitHub Actions]]

## God Nodes (most connected - your core abstractions)
1. `ObsidianDecentralizedPlugin` - 155 edges
2. `ConnectionModal` - 17 edges
3. `compilerOptions` - 16 edges
4. `DesktopLANDiscovery` - 15 edges
5. `DirectIpClient` - 14 edges
6. `PeerInfo` - 12 edges
7. `DirectIpServer` - 11 edges
8. `ObsidianDecentralizedSettingTab` - 10 edges
9. `DummyLANDiscovery` - 9 edges
10. `ConflictCenter` - 9 edges

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
- **Obsidian Decentralized Core Technologies** — readme_obsidian_decentralized, readme_peerjs, readme_webrtc, readme_signaling_server [EXTRACTED 1.00]
- **Performance Optimizations** — git_log_gethash_optimization, git_log_hash_cache_eviction, git_log_large_file_hashing, git_log_cached_read [INFERRED 0.95]

## Communities (19 total, 5 thin omitted)

### Community 0 - "Core Plugin Logic"
Cohesion: 0.08
Nodes (3): ObsidianDecentralizedPlugin, MerkleNode, SyncTask

### Community 1 - "Types and Utilities"
Cohesion: 0.05
Nodes (55): AckPayload, AdaptiveSyncConfig, BasePayload, BatchCompletePayload, BatchState, ClusterForgetPayload, ClusterKickPayload, DEFAULT_SETTINGS (+47 more)

### Community 2 - "Conflict Resolution UI"
Cohesion: 0.07
Nodes (8): BinaryConflictResolutionModal, ConflictCenter, ConflictListModal, ConflictResolutionModal, formatBytes(), QRScannerModal, SelectPeerModal, SyncProgressModal

### Community 3 - "LAN Discovery"
Cohesion: 0.10
Nodes (12): DesktopLANDiscovery, DummyLANDiscovery, assert(), assertEquals(), fs, Module, obsidian, path (+4 more)

### Community 4 - "Package Configuration"
Cohesion: 0.07
Nodes (28): author, dependencies, diff-match-patch, html5-qrcode, pako, peerjs, qrcode, ws (+20 more)

### Community 5 - "Direct IP Networking"
Cohesion: 0.12
Nodes (4): DirectIpClient, DirectIpServer, encodeMessage(), ServerClientEntry

### Community 6 - "Connection Manager UI"
Cohesion: 0.13
Nodes (4): ClusterGossipPayload, ClusterRenamePayload, CompanionPairPayload, ConnectionModal

### Community 7 - "TypeScript Config"
Cohesion: 0.11
Nodes (17): compilerOptions, allowJs, baseUrl, esModuleInterop, importHelpers, inlineSourceMap, inlineSources, isolatedModules (+9 more)

### Community 8 - "File System Operations"
Cohesion: 0.17
Nodes (6): FileDeletePayload, FileRenamePayload, FolderCreatePayload, FolderDeletePayload, FolderRenamePayload, decompressText()

### Community 11 - "Plugin Manifest"
Cohesion: 0.22
Nodes (8): author, authorUrl, description, id, isDesktopOnly, minAppVersion, name, version

### Community 12 - "Readme Documentation"
Cohesion: 0.25
Nodes (8): Companion Mode, Conflict Center, Direct IP Mode, LAN Discovery, Obsidian Decentralized, PeerJS, Signaling Server, WebRTC

### Community 14 - "Git Analysis"
Cohesion: 0.33
Nodes (6): Use cachedRead, getHash Optimization, Map Insertion Order Eviction, Large File Stat Hashing, ObsidianDecentralizedPlugin, Rename Vector Cache Transfer

### Community 15 - "Graphify Agents"
Cohesion: 0.50
Nodes (4): graph.json, GRAPH_REPORT.md, Graphify Usage Rule, Graphify Workflow

## Knowledge Gaps
- **78 isolated node(s):** `ServerClientEntry`, `id`, `name`, `version`, `minAppVersion` (+73 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ObsidianDecentralizedPlugin` connect `Core Plugin Logic` to `Types and Utilities`, `Conflict Resolution UI`, `LAN Discovery`, `Direct IP Networking`, `Connection Manager UI`, `File System Operations`, `Conflict Resolution Logic`, `Plugin Initialization`, `Settings Interface`, `Network Queue Priority`?**
  _High betweenness centrality (0.385) - this node is a cross-community bridge._
- **Why does `ConnectionModal` connect `Connection Manager UI` to `Types and Utilities`, `Conflict Resolution UI`, `LAN Discovery`?**
  _High betweenness centrality (0.045) - this node is a cross-community bridge._
- **Why does `DesktopLANDiscovery` connect `LAN Discovery` to `Types and Utilities`?**
  _High betweenness centrality (0.041) - this node is a cross-community bridge._
- **What connects `ServerClientEntry`, `id`, `name` to the rest of the system?**
  _83 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Core Plugin Logic` be split into smaller, more focused modules?**
  _Cohesion score 0.07763023493360573 - nodes in this community are weakly interconnected._
- **Should `Types and Utilities` be split into smaller, more focused modules?**
  _Cohesion score 0.05336538461538461 - nodes in this community are weakly interconnected._
- **Should `Conflict Resolution UI` be split into smaller, more focused modules?**
  _Cohesion score 0.06554621848739496 - nodes in this community are weakly interconnected._