# Obsidian Decentralized

![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)
![Obsidian Decentralized Banner](https://mwassets.github.io/files/obsidian-decentralized/banner.png)

Sync your Obsidian notes across devices **without a central server**. This plugin uses peer-to-peer technologies (WebRTC via PeerJS) to transfer your files directly between your devices, offering a free, private, and local-first alternative to cloud-based sync services.

Your notes are your own. This plugin ensures they stay that way.

---

## 📋 Table of Contents

- [Core Features](#-core-features)
- [How It Works](#-how-it-works)
- [Manual Installation](#-manual-installation)
- [🚀 Getting Started: Connecting Your First Devices](#-getting-started-connecting-your-first-devices)
  - [Method A: Quick Pair (recommended)](#method-a-quick-pair-recommended)
  - [Method B: Primary sync partner (for automatic reconnection)](#method-b-primary-sync-partner-for-automatic-reconnection)
  - [Method C: Offline Mode (no internet at all)](#method-c-offline-mode-no-internet-at-all)
- [⚙️ Configuration & Advanced Features](#️-configuration--advanced-features)
  - [Selective Sync](#selective-sync)
  - [Conflict Resolution](#conflict-resolution)
  - [Syncing Attachments and Config Files](#syncing-attachments-and-config-files)
  - [Offline Mode](#offline-mode-no-signaling-server)
  - [Using a Custom Signaling Server](#using-a-custom-signaling-server)
- [Conflict Center](#-conflict-center)
- [Security and Privacy](#-security-and-privacy)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✨ Core Features

-   **🌐 True Peer-to-Peer Sync:** Files are sent directly from one device to another. No cloud storage, no middleman.
-   **🕵️‍♂️ LAN Discovery:** On desktop, Connect devices lists other vaults on the same Wi-Fi. Tap one only after that device also has Connect devices open (it shares the pairing key).
-   **🤝 Multiple Connection Methods:** Pair with the full pairing code or its QR (device ID plus encryption key). A short device ID alone is refused. On the same Wi-Fi you can tap a nearby device. With no internet, use Offline Mode (one desktop hosts; others join with its IP and token).
-   **⚙️ Powerful Sync Engine:**
    -   Handles file/folder creation, deletion, and renaming. Edits made while devices are apart are exchanged when they reconnect.
    -   Efficiently syncs only the changes.
    -   Intelligently chunks large files to handle attachments and media.
    -   Files deleted on another device go to your trash, so a mistake can be undone.
-   **⚔️ Conflict Management:**
    -   When a note changes on two devices before they sync, the more recent change is kept on every device and the other is saved as `Note (conflict on DATE).md`. There is no automatic merge of conflicting edits.
    -   A dedicated "Conflict Center" in the ribbon helps you review and resolve conflicts on any device.
-   **🎛️ Granular Control:**
    -   Selectively include or exclude folders from sync.
    -   Optionally sync all file types (images, PDFs, etc.).
    -   Your theme, CSS snippets and appearance sync automatically; settings, hotkeys and other plugins can be added in Manual mode.
-   **🏡 Fully Self-Hostable:** For ultimate privacy, you can run your own PeerJS signaling server.
-   **📱 Cross-Platform:** Works on Desktop (Windows, macOS, Linux) and Mobile (via PeerJS). LAN Discovery is desktop-only.

## 🤔 How It Works

This plugin uses **PeerJS**, which leverages **WebRTC** technology. Think of it like this:

1.  **The Matchmaker (Signaling Server):** When you want to connect two devices, they both check in with a public "signaling server." This server is like a switchboard operator; it introduces your devices to each other and helps them establish a direct communication channel.
2.  **The Direct Line (P2P Connection):** Once the introduction is made, the signaling server steps away. Your devices then communicate **directly** with each other.
3.  **Data Transfer:** All your files, changes, and deletions are sent over this direct, encrypted channel. **Your notes are never stored on any third-party server.** See [Security and Privacy](#-security-and-privacy) for exactly what "encrypted" covers.

For LAN connections, the plugin can also use multicast UDP packets to broadcast its presence, allowing for automatic discovery without relying on an internet-based signaling server.

## 📥 Manual Installation

No Git, Node, or clone is needed. You only copy **three files** from the GitHub release.

1.  Open the [**Releases**](https://github.com/iWebbIO/obsidian-decentralized/releases) page and click the newest version.
2.  Scroll to **Assets** and download these three files one by one:
    -   **`main.js`**
    -   **`manifest.json`**
    -   **`styles.css`**

    All three are required — without `styles.css` the pairing screens render unstyled.

    Skip **Source code (zip)** and **Source code (tar.gz)**. Those are the project source, not the plugin. Do not use the green **Code** → **Download ZIP** button on the repo home page either.
3.  In your file explorer, open your vault and go to `.obsidian/plugins/`.
    -   If you don't see `.obsidian`, enable "Show hidden files."
    -   If `plugins` is missing, create it.
4.  Inside `plugins`, create a folder named `obsidian-decentralized`.
5.  Copy **only** the three files into that folder — `main.js`, `manifest.json`, and `styles.css`. When you are done, the folder must look like this and contain nothing else:

    ```
    <YourVault>/.obsidian/plugins/obsidian-decentralized/main.js
    <YourVault>/.obsidian/plugins/obsidian-decentralized/manifest.json
    <YourVault>/.obsidian/plugins/obsidian-decentralized/styles.css
    ```

    Do **not** drop the three files directly into `plugins/`. Do **not** copy the rest of the repository (`src/`, `package.json`, and so on).
6.  Restart Obsidian, or go to `Settings` → `Community Plugins` and toggle another plugin off and on.
7.  Go to `Settings` → `Community Plugins`. Turn **Restricted mode** off if it is on. "Obsidian Decentralized" should now be listed.
8.  Click the toggle to **enable** the plugin.

## 🚀 Getting Started: Connecting Your First Devices

Open the connection helper: the **Connect devices** button in settings, the **`users`** ribbon icon, or the "Connect to a device" command. Name this device at the top of that screen (Phone, Desktop) so the other side can tell you apart — new installs no longer all show up as "My New Device."

The helper has two tabs — **Quick Pair** and **Advanced**.

### Method A: Quick Pair (recommended)

Quick Pair shows **one pairing code** (device ID + encryption key) and a QR of the same code.

**On Device A (e.g. your desktop):**
1.  Open the connection helper and stay on the **Quick Pair** tab.
2.  Press **Copy pairing code**, or leave the QR on screen.

**On Device B (e.g. your phone):**
1.  Open the connection helper on the **Quick Pair** tab.
2.  Paste the code and press **Connect**, or tap **Scan their QR code**.
3.  On the same Wi-Fi, Device A also appears under **Nearby** once it has this screen open — tap it. If it says to open Connect devices on that device first, do that, then tap again.
4.  When pairing succeeds, tap **Keep us connected automatically** so the two devices reconnect on their own.

> **🔑 The code on screen is the whole secret.** Treat it like a password — anyone who has it can pair with you. Pasting only a short device ID is rejected; copy the code from the other device.

### Method B: Primary sync partner (for automatic reconnection)

The **Keep us connected automatically** button after pairing sets this. You can also do it later:

1.  Open `Settings` → `Obsidian Decentralized` and find the device under **Your devices**.
2.  Click the **star** icon ("Set as Primary Sync Partner").

### Method C: Offline Mode (no internet at all)

See [Offline Mode](#offline-mode-no-signaling-server) below.

> **💡 Pro tip:** If two vaults ever look out of step, run a **Force Full Sync** — the `refresh-cw` ribbon icon, or the "Force full sync with a device" command — and pick the device to sync with.

### Syncing three or more devices

More than two devices is supported: every device keeps the others in its **Your devices**
list, gossips that list to whoever it connects to, and retries all of them in the background.
An entry that is powered off or unreachable is simply skipped — it does not knock the other
links offline, and it does not change your status.

Two things to know when you go past two devices:

-   **Pairing is per pair of devices, not per cluster.** A key is established between the two
    devices that scanned each other's code. If your phone paired with your desktop and later
    with your laptop, the desktop and laptop still have no key with each other, so that
    particular link is unencrypted until you pair those two directly. After the third pair,
    Connect devices tells you which other devices still need a direct pairing. In
    **Your devices**, a gossiped device that is **Not encrypted** has a **Pair** button —
    Reconnect cannot create the key.
-   **With "strict security" on, every link must be paired.** A device introduced only by
    gossip is refused with a notice asking you to pair. Pair each device with each other
    device (or leave strict security off, its default).
-   **Remove from group actually removes that device.** Trash (or Forget) drops it from
    every member's list and stops auto-reconnect. It can only come back by pairing again.

## ⚙️ Configuration & Advanced Features

All options live in the plugin's settings tab (`Settings` → `Obsidian Decentralized`). The **Mode** dropdown at the top controls how much is shown: `Auto` keeps things minimal with safe defaults, `Manual` exposes the common settings, and `Advanced` adds tuning and security options.

### Selective Sync

-   **Included folders:** Only sync folders that are in this list (one path per line). If this is empty, all folders are synced by default.
-   **Excluded folders:** Never sync folders in this list. This takes priority over the included list.

Rules match whole folders: `Work` covers `Work/` and everything inside it, but not `Workshop/` or a note named `Work notes.md`. Hidden folders (names starting with `.`) and Obsidian's config folder never sync as notes. Another device cannot move, create or delete anything outside what *this* device syncs.

### Conflict Resolution

When a note is changed on two devices before they have a chance to sync, the **more recent change is kept on every device** — the same rule however many devices you have.

The plugin first checks whether it is really a conflict: if one device already had the other's change when it edited the note, that edit is simply newer and wins, whatever the clocks say. Only when both devices changed the note independently does the time decide. Exact ties go to the device with the lower ID, so every device picks the same version.

What happens to the other version is up to you (Manual mode):

-   **Keep it as a conflict copy (default and safest):** the device whose edit lost saves it as a new file, e.g. `My Note (conflict on 2026-09-25).md`. The copy syncs like any note, so you can compare and resolve it on any device.
-   **Discard it:** the older version is dropped.

Deletions follow the same rule. A note deleted on one device and edited later on another comes back; a note deleted after its last edit stays deleted everywhere (other devices move their copy to the trash).

The rule relies on your devices' clocks being roughly right. If a clock is far off, the "wrong" edit can win — but it is still kept as a conflict copy, so nothing is lost.

### Syncing Attachments and Config Files

-   **Sync all file types:** By default, the plugin focuses on text files. Enable this to sync images, PDFs, audio, and other attachments.
-   **Obsidian settings (the `.obsidian` folder):**
    -   In **Auto** mode your theme, CSS snippets and appearance settings sync.
    -   In **Manual/Advanced** mode, **Also sync Obsidian settings** adds Obsidian's settings, hotkeys, core plugin settings and your community plugins (their code and settings). With it off, nothing in the config folder is shared.
    -   The window layout (`workspace.json`) stays per device, and this plugin's own settings — which hold your device ID and pairing keys — are never shared.
    -   Plugins and settings only travel between devices paired with a pairing code, or joined in Offline Mode: they can run code, or hold other plugins' passwords and API keys. Theme and snippets are shared with any connected device.
    -   The newer change wins, deletions included (deleted files go to the trash). **Restart Obsidian, or run "Reload app without saving", after settings arrive** — Obsidian only reads them at startup.
    -   Use the same Obsidian version on every device, and keep a backup.
-   **Live typing (experimental, Advanced):** streams keystrokes to the other device as you type. It is off by default; it only works with exactly two devices on a steady connection, and text can be lost if both sides type in the same note at once.

### Offline Mode (no signaling server)

<a id="offline-mode-no-signaling-server"></a>

For LAN-only environments with no internet, or where you don't want a signaling server involved at all. One device (usually a desktop) hosts and the others connect to it.

**On the host (desktop only):**
1.  Open the connection helper → **Advanced** tab → **Switch to Offline Mode**.
2.  Press **Start Hosting**. The screen shows this computer's IP address and a security token, with buttons to copy them. If you have several adapters (VPN, WSL, virtual machines), every address is listed — start with the one marked “try this first,” usually a `192.168…` Wi-Fi address. If the other device cannot reach the host, try the next address. While Offline Mode is on, Connect devices opens this screen directly (Quick Pair codes do not work here). Reopen it — or Settings → Your devices — anytime to see the same IP and token again; starting host a second time does not issue a new token.

**On each other device:**
1.  Open the connection helper → **Advanced** tab → **Switch to Offline Mode**. After that, Connect devices opens Offline Mode directly.
2.  Under **Join a Network**, enter the host's IP address and token, then connect. Hosts found on your Wi-Fi are also listed and can be selected directly. You can paste the host's **Copy IP and token** text straight into the IP box — it fills in both fields. `host:port` and IPv6 addresses (`[fe80::1]:41235`) work too.

Offline Mode is authenticated and encrypted. The token itself never crosses the network: the host and each joining device prove to each other that they know it, and every message after that is encrypted with keys derived from it (AES-256-GCM, separate keys per direction). A device answering at the host's address without the token is rejected, and so is a device running an older version of the plugin — update both.

### Using a Custom Signaling Server

For maximum privacy, you can run your own [PeerServer](https://github.com/peers/peerjs-server). In the plugin's "Advanced Settings," enable "Use custom signaling server" and enter your server's details.

## ⚔️ Conflict Center

If a conflict occurs and a `(conflict on DATE)` file is created, a new icon (`swords`) will appear in the left ribbon. This is the Conflict Center. It also finds leftover conflict copies when you reopen Obsidian, and from the **Resolve sync conflicts** command.

-   The icon shows a badge with the number of unresolved conflicts.
-   Clicking it opens a modal listing all conflicts.
-   Click `Resolve` on any conflict to compare the **current version** (the newer one, which every device has) with the **conflict copy** (the edit that lost). Keep the current version, or use the conflict copy instead — either way the choice syncs to your other devices and the copy moves to the trash everywhere. **Decide later** (or closing the diff) returns you to the list. After one is resolved, the list reopens if others remain.

## 🛡️ Security and Privacy

-   **No cloud storage.** Your notes are never stored on a third-party server. They exist only on your devices.
-   **Transport encryption, always.** Every WebRTC connection is encrypted in transit with DTLS. This protects the data on the wire but says nothing about *who* is on the other end.
-   **Application-layer encryption, always on for paired devices.** The pairing code (or QR) exchanges a 256-bit AES-GCM key, and every message on that link — heartbeats and acknowledgements included — is encrypted with it on top of DTLS. There is no switch to turn it off. Settings → Your devices shows **Encrypted** on each device that has a key. A bare device ID is no longer accepted as a pairing code.
-   **Offline Mode is authenticated and encrypted** with keys derived from its token; the token is never sent. See [Offline Mode](#offline-mode-no-signaling-server).
-   **Recoverable deletions.** Files and folders another device deletes go to your trash (Obsidian's "Deleted files" setting decides which one), never straight to permanent deletion.
-   **Plugins and settings only from paired devices.** Obsidian settings that can run code or hold secrets are only exchanged with devices that share a pairing key, or over Offline Mode.
-   **The signaling server sees metadata, not notes.** In the default mode your devices register a stable ID with a public PeerJS server so they can find each other. It never handles note content, but it does see your device ID and IP address each session. Run your own PeerServer, or use Offline Mode, to avoid it entirely.
-   **Know the limits.** By default, a device that knows your device ID can open a connection to you. The "strict security" setting under Advanced hardens this by refusing unrecognised and unencrypted peers; it is off by default because turning it on requires re-pairing existing devices. Offline Mode is token-authenticated regardless.

## ⚠️ Troubleshooting

-   **Plugin doesn't appear in Obsidian:** Check the folder structure is `<YourVault>/.obsidian/plugins/obsidian-decentralized/` and that this folder directly contains `main.js`, `manifest.json`, and `styles.css`.
-   **Connection Fails:**
    -   Ensure both devices are connected to the internet (for the default PeerJS mode).
    -   Check for firewalls or aggressive ad-blockers (like Pi-hole) that might be blocking the connection to the PeerJS signaling server or the P2P connection itself.
    -   Double-check that you pasted the full pairing code from the other device (Copy pairing code), not a short ID.
-   **Status is "Can't reach the sync network":** The plugin couldn't connect to the signaling server (this is not Offline Mode). It will automatically keep retrying with an increasing backoff delay. Check your internet connection, or switch to Offline Mode if you have no internet at all.
-   **A third device won't connect ("unable to reach the host"):** Extra IDs in the Your devices list are fine — unreachable ones are skipped without affecting the working links. If a row says **Not encrypted**, tap **Pair** (not Reconnect) and exchange the full code with *that* device. Under "strict security" an unpaired link is refused. See [Syncing three or more devices](#syncing-three-or-more-devices).
-   **"… runs a different version of Obsidian Decentralized":** both devices must run the same version of the plugin. Update the one the notice names; they reconnect on their own afterwards.
-   **Nearby devices don't appear:** Nearby discovery needs UDP multicast, which some VPNs, corporate networks, and firewalls block. Paste the pairing code or scan the QR instead. The other device must also have Connect devices open before a nearby tap will pair.

## 🤝 Contributing

Contributions, bug reports, and feature requests are welcome! Please feel free to open an issue or submit a pull request.

## 📜 License

This plugin is licensed under the **GNU General Public License v3.0**. For the full license text, please see the `LICENSE` file included in the repository.

Special thanks to [Ray Vermey](https://github.com/rayvermey) for their guidance, encouragement and feedback.
