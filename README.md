# Obsidian Decentralized

![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)

Sync your Obsidian notes across devices **without a central server**. This plugin uses peer-to-peer technologies (WebRTC via PeerJS) to transfer your files directly between your devices, offering a free, private, and local-first alternative to cloud-based sync services.

Your notes are your own. This plugin ensures they stay that way.

---

## 📋 Table of Contents

- [Core Features](#-core-features)
- [How It Works](#-how-it-works)
- [Manual Installation](#-manual-installation)
- [🚀 Getting Started: Connecting Your First Devices](#-getting-started-connecting-your-first-devices)
  - [Method A: LAN Discovery (Easiest, LAN Only)](#method-a-lan-discovery-easiest-lan-only)
  - [Method B: By ID / QR Code (Works over Internet)](#method-b-by-id--qr-code-works-over-internet)
  - [Method C: Companion Mode (For Convenience)](#method-c-companion-mode-for-convenience)
- [⚙️ Configuration & Advanced Features](#️-configuration--advanced-features)
  - [Selective Sync](#selective-sync)
  - [Conflict Resolution](#conflict-resolution)
  - [Syncing Attachments and Config Files](#syncing-attachments-and-config-files)
  - [Experimental: Direct IP Mode](#experimental-direct-ip-mode)
  - [Using a Custom Signaling Server](#using-a-custom-signaling-server)
- [Conflict Center](#-conflict-center)
- [Security and Privacy](#-security-and-privacy)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✨ Core Features

-   **🌐 True Peer-to-Peer Sync:** Files are sent directly from one device to another. No cloud storage, no middleman.
-   **🕵️‍♂️ LAN Discovery:** Automatically find other devices on your local network without needing to copy/paste IDs.
-   **🤝 Multiple Connection Methods:** Connect via auto-discovery with a PIN, a unique device ID, a QR code, or (experimentally) a direct IP address.
-   **⚙️ Powerful Sync Engine:**
    -   Handles file/folder creation, deletion, and renaming.
    -   Efficiently syncs only the changes.
    -   Intelligently chunks large files to handle attachments and media.
-   **⚔️ Conflict Management:**
    -   Choose your preferred conflict resolution strategy: create a duplicate file (safest), last-write-wins, or attempt to auto-merge changes in Markdown files.
    -   A dedicated "Conflict Center" in the ribbon helps you review and resolve conflicts.
-   **🎛️ Granular Control:**
    -   Selectively include or exclude folders from sync.
    -   Optionally sync all file types (images, PDFs, etc.).
    -   Optionally sync your `.obsidian` config folder (use with caution!).
-   **🏡 Fully Self-Hostable:** For ultimate privacy, you can run your own PeerJS signaling server.
-   **📱 Cross-Platform:** Works on Desktop (Windows, macOS, Linux) and Mobile (via PeerJS). LAN Discovery is desktop-only.

## 🤔 How It Works

This plugin uses **PeerJS**, which leverages **WebRTC** technology. Think of it like this:

1.  **The Matchmaker (Signaling Server):** When you want to connect two devices, they both check in with a public "signaling server." This server is like a switchboard operator; it introduces your devices to each other and helps them establish a direct communication channel.
2.  **The Direct Line (P2P Connection):** Once the introduction is made, the signaling server steps away. Your devices then communicate **directly** with each other.
3.  **Data Transfer:** All your files, changes, and deletions are sent over this secure, direct, end-to-end encrypted channel. **Your notes are never stored on any third-party server.**

For LAN connections, the plugin can also use multicast UDP packets to broadcast its presence, allowing for automatic discovery without relying on an internet-based signaling server.

## 📥 Manual Installation

This plugin must be installed manually.

1.  Go to the [**Releases**](https://github.com/iWebbIO/obsidian-decentralized/releases) page on GitHub.
2.  Download the `main.js`, `manifest.json`, and `styles.css` files from the latest release.
3.  Navigate to your Obsidian vault's plugins folder. This is typically located at `<YourVault>/.obsidian/plugins/`.
    -   If you don't see a `.obsidian` folder, you may need to enable "Show hidden files" in your file explorer.
4.  Create a new folder inside the `plugins` directory. Name it `obsidian-decentralized`.
5.  Copy the `main.js`, `manifest.json`, and `styles.css` files you downloaded into this new folder.
6.  Restart Obsidian or reload the plugins by going to `Settings` -> `Community Plugins` and toggling a different plugin off and on.
7.  Go to `Settings` -> `Community Plugins`. You should now see "Obsidian Decentralized" in the list.
8.  Click the toggle to **enable** the plugin.

## 🚀 Getting Started: Connecting Your First Devices

First, give your device a memorable name in the plugin settings (e.g., "My Desktop," "My Phone"). This makes it easier to identify.

Then, open the connection helper by clicking the **Connect Devices** button in settings, or the **`users`** icon in the ribbon.

### Method A: LAN Discovery (Easiest, LAN Only)

Use this when both devices are on the same Wi-Fi network. This method does not require an internet connection.

**On Device A (e.g., your Desktop):**
1.  Open the Connection Modal.
2.  Go to `PeerJS Connection` -> `One-Time Connection`.
3.  Click `Invite with PIN`.
4.  The modal will display a 4-digit PIN.

**On Device B (e.g., your Phone):**
1.  Open the Connection Modal.
2.  Go to `PeerJS Connection` -> `One-Time Connection`.
3.  Click `Join a Network`.
4.  You should see "Device A" appear in the "Discovered on LAN" list.
5.  Tap on it and enter the 4-digit PIN from Device A.

You're connected!

### Method B: By ID / QR Code (Works over Internet)

Use this if your devices are on different networks, or if LAN discovery fails.

**On Device A:**
1.  Open the Connection Modal -> `PeerJS Connection` -> `One-Time Connection`.
2.  Click `Show ID`. A unique ID and a QR code for your device will be displayed.
3.  Click `Copy ID`.

**On Device B:**
1.  Open the Connection Modal -> `PeerJS Connection` -> `One-Time Connection`.
2.  Click `Join a Network`.
3.  Paste the ID from Device A into the "Peer ID" field and click `Connect with ID`. (Alternatively, if you're on mobile, you could scan the QR code).

### Method C: Companion Mode (For Convenience)

Set a primary device (like your desktop) as a "companion" for your other devices (like your phone) for automatic reconnection.

1.  **On your main device (e.g., Desktop):** Get its ID using Method B (`Show ID`).
2.  **On your secondary device (e.g., Phone):**
    -   Open the Connection Modal -> `PeerJS Connection` -> `Companion Mode`.
    -   Paste the ID of your main device into the "Companion's ID" field.
    -   Click `Pair`.

Now, your phone will automatically try to reconnect to your desktop whenever the plugin is active.

> **💡 Pro Tip:** After connecting for the first time, it's a good idea to run a **Force Full Sync**. Click the `refresh-cw` ribbon icon and select the peer you want to sync with. This ensures both vaults are perfectly aligned.

## ⚙️ Configuration & Advanced Features

All options are available in the plugin's settings tab (`Settings` -> `Obsidian Decentralized`). You may need to enable "Experimental Features" to see all options.

### Selective Sync

-   **Included folders:** Only sync folders that are in this list (one path per line). If this is empty, all folders are synced by default.
-   **Excluded folders:** Never sync folders in this list. This takes priority over the included list.

### Conflict Resolution

When a file is changed on two devices before they have a chance to sync, a conflict occurs. Choose how you want to handle this:

-   **Create Conflict File (Default & Safest):** The incoming change is saved as a new file, e.g., `My Note (conflict on 2023-10-27).md`. You can then manually compare and merge them.
-   **Last Write Wins:** The version with the newest modification timestamp is kept, and the other is discarded.
-   **Attempt Auto-Merge:** For Markdown files, the plugin will try to merge the changes automatically. If it can't merge cleanly, it will fall back to creating a conflict file.

### Syncing Attachments and Config Files

-   **Sync all file types:** By default, the plugin focuses on text files. Enable this to sync images, PDFs, audio, and other attachments.
-   **Sync '.obsidian' configuration folder:** **(DANGEROUS)** Syncs your Obsidian settings, themes, and snippets. This can cause problems if your devices have different plugins, themes, or operating systems. **Always make a backup before enabling this.**

### Experimental: Direct IP Mode

For completely offline, LAN-only environments where even a signaling server is not desired.

1.  One device (usually a desktop) acts as the **Host**.
2.  Other devices connect as **Clients**.
3.  Use the `Connect` modal -> `Direct IP` to configure. The Host will display its IP address and a PIN for clients to use.

### Using a Custom Signaling Server

For maximum privacy, you can run your own [PeerServer](https://github.com/peers/peerjs-server). In the plugin's "Advanced Settings," enable "Use custom signaling server" and enter your server's details.

## ⚔️ Conflict Center

If a conflict occurs and a `(conflict)` file is created, a new icon (`swords`) will appear in the left ribbon. This is the Conflict Center.

-   The icon shows a badge with the number of unresolved conflicts.
-   Clicking it opens a modal listing all conflicts.
-   Click `Resolve` on any conflict to open a diff view, allowing you to compare your local version with the remote version and choose which one to keep.

## 🛡️ Security and Privacy

-   **End-to-End Encryption:** All data transferred between your devices is encrypted in-transit using DTLS (part of the WebRTC standard).
-   **No Cloud Storage:** Your notes are never stored on any third-party server. They are only ever on your devices.
-   **Signaling Server:** The only third-party interaction is with the signaling server, which is used solely to establish the initial P2P connection. It does not see or handle any of your note data. If you use the self-hosted option, you control this component as well.

## ⚠️ Troubleshooting

-   **Plugin doesn't appear in Obsidian:** After manual installation, if the plugin doesn't show up under Community Plugins, double-check that the folder structure is correct: `<YourVault>/.obsidian/plugins/obsidian-decentralized/` and ensure this folder directly contains `main.js` and `manifest.json`.
-   **Connection Fails:**
    -   Ensure both devices are connected to the internet (for the default PeerJS mode).
    -   Check for firewalls or aggressive ad-blockers (like Pi-hole) that might be blocking the connection to the PeerJS signaling server or the P2P connection itself.
    -   Double-check that you have copied/pasted the Peer ID correctly.
-   **Status is "❌ Sync Offline":** The plugin couldn't connect to the signaling server. It will automatically keep retrying with an increasing backoff delay. Check your internet connection.
-   **LAN Discovery Doesn't Work:** This feature requires UDP multicast, which is sometimes blocked by corporate networks, VPNs, or strict firewall rules. In this case, fall back to connecting via ID/QR Code.

## 🤝 Contributing

Contributions, bug reports, and feature requests are welcome! Please feel free to open an issue or submit a pull request on the [GitHub repository](https://github.com/iWebbIO/obsidian-decentralized).

## 📜 License

This plugin is licensed under the **GNU General Public License v3.0**. For the full license text, please see the `LICENSE` file included in the repository.
