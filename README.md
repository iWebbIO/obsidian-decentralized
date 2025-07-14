# Obsidian Decentralized
![GitHub license](https://img.shields.io/github/license/iWebbIO/obsidian-decentralized)

A free, private, and local-first sync solution for Obsidian.md. Your notes travel directly between your devices, with no central server involved.

Tired of paying for sync or trusting a third-party service with your private notes? Obsidian Decentralized offers a fast and secure way to synchronize your vaults across multiple devices on the same local network (e.g., your home Wi-Fi). It uses peer-to-peer technology to send changes directly from one device to another, ensuring your data never leaves your control.

---

## Key Features
*   **💻 True Peer-to-Peer Sync:** Your data is never stored on an intermediary server. It travels directly between your devices.
*   **🏠 Local-First:** Designed to be exceptionally fast and reliable on your local network.
*   **🤖 Companion Mode:** "Set it and forget it." Permanently pair two devices (like your desktop and phone) for automatic, resilient connections whenever they're on the same network.
*   **🕸️ Self-Healing Mesh Network:** Connect multiple devices, and they will automatically discover each other and form a resilient sync cluster. If one device goes offline, the others remain in sync.
*   **⚔️ Built-in Conflict Resolution:** If a note is modified on two devices simultaneously, the plugin will detect the conflict, save the remote version as a separate file, and provide a visual diff tool to help you merge the changes.
*   **📱 Cross-Platform:** Works on Desktop (Windows, macOS, Linux) and Mobile (Android, iOS).
*   **💸 Free & Open Source:** No fees, no subscriptions. Ever.

---

## How It Works
Obsidian Decentralized uses **WebRTC** (the technology behind most modern video-conferencing apps) via the **PeerJS** library to establish direct, encrypted data channels between your devices.

When you connect to one peer, a smart **"gossip" protocol** kicks in. Your devices exchange information about other known peers in the network, allowing them to quickly form a fully-connected mesh. This means that even if the initial device you connected to goes offline, sync continues seamlessly between the remaining devices.

**Companion Mode** adds an extra layer of resilience by making your device periodically attempt to reconnect to its designated companion, ensuring your primary devices find each other without any manual intervention.

---

## Installation
### From Obsidian's Community Plugin Browser (Coming soon ...)

1.  Open Obsidian's `Settings`.
2.  Go to `Community plugins` and ensure "Restricted mode" is turned **off**.
3.  Click `Browse` and search for "Obsidian Decentralized".
4.  Click `Install`, and then once it's finished, click `Enable`.

### Manual Installation

1.  Download the latest release ZIP file from the [Releases](https://github.com/iWebbIO/obsidian-decentralized/releases) page.
2.  Unzip the contents into your vault's plugin folder: `<YourVault>/.obsidian/plugins/`.
3.  Reload Obsidian (or disable and re-enable the plugin in settings).

---

### Getting Started: A Step-by-Step Guide
The best way to use this plugin is with Companion Mode between your main computer and your phone.

#### Setting up Companion Mode (Desktop + Phone)

**On Device 1 (e.g., your Desktop):**

1.  Click the "Connect to a Peer" ribbon icon (looks like two people) in the left sidebar.
2.  Select `Setup` under **Companion Mode**.
3.  Click `Show My ID`. A QR code and your unique Device ID will be displayed. Keep this screen open.

**On Device 2 (e.g., your Phone):**

1.  Open the same vault in Obsidian. Make sure you're on the same Wi-Fi network.
2.  Click the "Connect to a Peer" ribbon icon.
3.  Select `Setup` under **Companion Mode**.
4.  In the "Companion's ID" text box, you can either:
    *   Manually type the ID from your Desktop's screen.
    *   (Easier) If your phone can't scan the QR code, use the "Paste" button after copying the ID.
5.  Click `Pair`.

**That's it!** The two devices are now permanently paired. They will automatically find and connect to each other whenever they are on the same network with Obsidian open. You will see a `🤝 Connected to...` notice.

#### Using a One-Time Connection
This is useful for temporarily syncing with a friend's vault or a device you don't use often.

1.  **On the "Inviting" Device:**
    *   Click the "Connect to a Peer" ribbon icon.
    *   Select `Connect` under **One-Time Connection**.
    *   Choose your method:
        *   **Invite with ID:** Shows a QR code and ID for the other device to use.
        *   **Get PIN:** Shows your local IP address and a temporary 4-digit PIN. This is often the easiest method for mobile-to-mobile connections.

2.  **On the "Joining" Device:**
    *   Click the "Connect to a Peer" ribbon icon.
    *   Select `Connect` -> `Join`.
    *   Choose the corresponding method (ID or IP + PIN) and enter the information from the inviting device.
    *   Click `Connect`.

---

### Resolving Conflicts
Conflicts are rare but can happen if you modify the same note on two offline devices and then bring them online.

1.  You will see a notice: `Conflict detected for: Your Note.md`.
2.  The plugin saves the incoming version of the file with a `(conflict on YYYY-MM-DD)` suffix. Your local version remains untouched.
3.  A "Swords" icon will appear in the left ribbon, showing the number of active conflicts.
4.  Click the swords icon to see a list of all conflicts.
5.  Click `Resolve` next to a conflict to open a diff view. You can see the differences side-by-side.
6.  Choose to `Keep My Version` or `Use Their Version`. The plugin will handle renaming/deleting the files automatically.

---

### License
This plugin is released under the [GPL 3.0 License](LICENSE).
### Acknowledgements
* [Obsidian Team](https://obsidian.md)
* [PeerJS](https://peerjs.com/)
* [QRCode.js](https://github.com/davidshimjs/qrcodejs)

made with ❤️ by moreweb
