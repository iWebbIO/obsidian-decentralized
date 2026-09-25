import { App, PluginSettingTab, Setting, setIcon, Notice } from 'obsidian';
import type ObsidianDecentralizedPlugin from './main';
import { PeerInfo, DEFAULT_SETTINGS, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE } from './types';
import { ConnectionModal, ConfirmModal, renderHostAddresses } from './ui';
import { persistablePeerInfo } from './utils/pairing';

export class ObsidianDecentralizedSettingTab extends PluginSettingTab {
    plugin: ObsidianDecentralizedPlugin;
    private clusterStatusEl: HTMLDivElement | null = null;
    private statusInterval: number | null = null;
    private statusTextEl: HTMLDivElement | null = null;
    private isEditingName = false;
    /** Fingerprint of the last rendered status, so the 3 s poll can no-op. */
    private lastStatusSignature: string | null = null;

    constructor(app: App, plugin: ObsidianDecentralizedPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        this.isEditingName = false;
        // The DOM below is rebuilt from scratch, so the previous render's fingerprint
        // must not suppress the first repaint into the new elements.
        this.lastStatusSignature = null;
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Obsidian Decentralized' });

        const statusContainer = containerEl.createDiv();
        statusContainer.createEl('h3', { text: 'Status' });
        this.statusTextEl = statusContainer.createDiv({ cls: 'obsidian-decentralized-status-text' });
        this.statusTextEl.style.marginBottom = '1em';

        new Setting(containerEl)
            .setName('This device')
            .setDesc('Shown on your other devices when pairing. Use something you will recognize (Phone, Desktop).')
            .addText(text => text
                .setPlaceholder('Phone, Desktop…')
                .setValue(this.plugin.settings.friendlyName)
                .onChange(async (value) => {
                    const ok = await this.plugin.setFriendlyName(value);
                    if (!ok && value.trim()) new Notice('Name must be 1–64 characters.');
                }));

        if (this.plugin.settings.syncMode === 'advanced') {
            const idLine = containerEl.createDiv({ cls: 'od-device-id-support' });
            idLine.setText(`${this.plugin.settings.deviceId} · not the pairing code`);
            idLine.setAttr('title', 'Click to copy. This is not the pairing code.');
            idLine.onclick = async () => {
                try {
                    await navigator.clipboard.writeText(this.plugin.settings.deviceId);
                    new Notice('Device ID copied. This is not the pairing code.');
                } catch {
                    new Notice('Select the ID and copy it.');
                }
            };
        }

        new Setting(containerEl)
            .setName('How much to show')
            .setDesc('Auto just works — everything syncs the safe way. Manual lets you pick folders and extras. Advanced adds extra technical options.')
            .addDropdown(dd => dd
                .addOption('auto', 'Auto (recommended)')
                .addOption('manual', 'Manual')
                .addOption('advanced', 'Advanced')
                .setValue(this.plugin.settings.syncMode)
                .onChange(async (value: 'auto' | 'manual' | 'advanced') => {
                    this.plugin.settings.syncMode = value;
                    await this.plugin.saveSettings();
                    this.display(); 
                }));

        new Setting(containerEl)
            .setName('Connect devices')
            .setDesc('Pair another phone or computer. The code on that screen is the whole pairing code — copy it, don’t retype the short ID.')
            .addButton(btn => btn.setButtonText("Connect").setCta().onClick(() => new ConnectionModal(this.app, this.plugin).open()));

        containerEl.createEl('h3', { text: 'Your devices' });
        this.clusterStatusEl = containerEl.createDiv();
        this.updateStatus();

        // Shared Settings (Visible in both modes)
        containerEl.createEl('h3', { text: 'Settings' });
        new Setting(containerEl)
            .setName("Don't sync these folders")
            .setDesc("Anything listed here stays on this device only. One folder per line, like Attachments/Large Files.")
            .addTextArea(text => text.setPlaceholder("Attachments/Large Files\nArchive").setValue(this.plugin.settings.excludedFolders).onChange(async (value) => { this.plugin.settings.excludedFolders = value; await this.plugin.saveSettings(); }));

        if (this.plugin.settings.syncMode === 'manual' || this.plugin.settings.syncMode === 'advanced') {
            this.displayManualSettings(containerEl);
        } else {
             new Setting(containerEl)
                .setName('Notify me when files sync')
                .setDesc('Pops up while files are copying. Problems and conflicts always show. Connection drops stay in the status bar — they never pop up.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.showToasts)
                    .onChange(async (value) => {
                        this.plugin.settings.showToasts = value;
                        await this.plugin.saveSettings();
                    }));
        }
        
        if (this.plugin.settings.syncMode === 'advanced') {
            this.displayAdvancedSettings(containerEl);
        }

        if (this.statusInterval) clearInterval(this.statusInterval);
        this.statusInterval = window.setInterval(() => this.updateStatus(), 3000);
    }

    displayManualSettings(containerEl: HTMLElement): void {
        containerEl.createEl('h4', { text: 'More options' });

        new Setting(containerEl)
            .setName('Notify me when files sync')
            .setDesc('Pops up while files are copying. Problems and conflicts always show. Connection drops stay in the status bar — they never pop up.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showToasts)
                .onChange(async (value) => {
                    this.plugin.settings.showToasts = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("When both devices change the same note")
            .setDesc("If you edit a file here and on another device before they sync, choose what happens.")
            .addDropdown(dd => dd
                .addOption('create-conflict-file', 'Keep both copies (safest)')
                .addOption('last-write-wins', 'Keep the newest, drop the other')
                .setValue(this.plugin.settings.conflictResolutionStrategy)
                .onChange(async (value: 'create-conflict-file' | 'last-write-wins') => {
                    this.plugin.settings.conflictResolutionStrategy = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Also sync pictures, PDFs, and other files")
            .setDesc("Off: only notes and other text. On: images, PDFs, and the rest — uses more data and can take longer.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncAllFileTypes)
                .onChange(async (value) => {
                    this.plugin.settings.syncAllFileTypes = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Also sync Obsidian settings (.obsidian)")
            .setDesc("Risky. Copies themes, snippets, and plugin settings to your other devices. Only turn this on if they use the same plugins and Obsidian version — and make a backup first.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncObsidianConfig)
                .onChange(async (value) => {
                    this.plugin.settings.syncObsidianConfig = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Hide Obsidian’s own Sync button")
            .setDesc("Hides the built-in Obsidian Sync icon in the status bar so it doesn’t sit next to this plugin.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.hideNativeSyncStatus)
                .onChange(async (value) => {
                    this.plugin.settings.hideNativeSyncStatus = value;
                    this.plugin.applyHideNativeSync();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Write extra details to the console")
            .setDesc("Adds more sync information to the developer console. Turn this on if something is going wrong.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.verboseLogging)
                .onChange(async (value) => {
                    this.plugin.settings.verboseLogging = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Use custom signaling server")
            .setDesc("For advanced users. Use your own self-hosted PeerJS server for a fully private syncing experience, even over the internet.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useCustomPeerServer)
                .onChange(async (value) => {
                    this.plugin.settings.useCustomPeerServer = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        if (this.plugin.settings.useCustomPeerServer) {
            const config = this.plugin.settings.customPeerServerConfig;
            new Setting(containerEl).setName("Host").addText(text => text.setValue(config.host).onChange(async (value) => { config.host = value; await this.plugin.saveSettings(); }));
            new Setting(containerEl).setName("Port").addText(text => text.setValue(config.port.toString()).onChange(async (value) => {
                const parsed = parseInt(value, 10);
                config.port = isNaN(parsed) ? DEFAULT_SETTINGS.customPeerServerConfig.port : Math.max(1, Math.min(parsed, 65535));
                await this.plugin.saveSettings();
            }));
            new Setting(containerEl).setName("Path").addText(text => text.setValue(config.path).onChange(async (value) => { config.path = value; await this.plugin.saveSettings(); }));
            new Setting(containerEl).setName("Secure (SSL)").addToggle(toggle => toggle.setValue(config.secure).onChange(async (value) => { config.secure = value; await this.plugin.saveSettings(); }));

            new Setting(containerEl)
                .setName("Apply signaling server changes")
                .setDesc("Reconnects using the values above. Current connections drop while it reconnects.")
                .addButton(btn => btn.setButtonText("Apply and reconnect").setWarning()
                    .onClick(() => {
                        this.plugin.showNotice("Reconnecting to the new signaling server…", 'important');
                        this.plugin.reinitializeConnectionManager();
                    }));
        }

        containerEl.createEl('h4', { text: "Only these folders" });
        new Setting(containerEl)
            .setName("Only sync these folders")
            .setDesc("If you add folders here, only they sync. Leave this empty to sync everything except the folders you skipped above. One folder per line, like Journal/Daily.")
            .addTextArea(text => text.setPlaceholder("Journal/Daily\nWork").setValue(this.plugin.settings.includedFolders).onChange(async (value) => { this.plugin.settings.includedFolders = value; await this.plugin.saveSettings(); }));
    }

    displayAdvancedSettings(containerEl: HTMLElement): void {
        containerEl.createEl('h4', { text: 'Two-Device Enhancements' });
        
        new Setting(containerEl)
            .setName("Enable Two-Device Optimizations")
            .setDesc("If exactly one device is connected, enables Version Vectors, Merkle Tree syncing, and Role-based conflict resolution.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableTwoDeviceOptimizations)
                .onChange(async (value) => {
                    this.plugin.settings.enableTwoDeviceOptimizations = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h4', { text: 'Advanced Settings' });

        new Setting(containerEl)
            .setName("Turbo Real-time")
            .setDesc("WARNING: Streams live keystrokes instantly to avoid conflicts. Requires a flawless connection and a strict 2-device setup. Can be destructive if misused.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableRealtimeSync)
                .onChange(async (value) => {
                    this.plugin.settings.enableRealtimeSync = value;
                    await this.plugin.saveSettings();
                }));
        
        new Setting(containerEl)
            .setName("Enable Text Compression")
            .setDesc("Compress text files (markdown, css, etc.) before sending. Significantly reduces bandwidth usage.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableCompression)
                .onChange(async (value) => {
                    this.plugin.settings.enableCompression = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Enable Delta Sync")
            .setDesc("Only send changes (deltas) instead of the whole file when a text file is modified. Speeds up syncing for large notes.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableDeltaSync)
                .onChange(async (value) => {
                    this.plugin.settings.enableDeltaSync = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Delta Sync Threshold (%)")
            .setDesc("Only use delta sync if the patch is smaller than this percentage of the total file size.")
            .addText(text => text
                .setValue(this.plugin.settings.deltaSyncThreshold.toString())
                .onChange(async (value) => {
                    const num = parseInt(value);
                    this.plugin.settings.deltaSyncThreshold = isNaN(num) ? DEFAULT_SETTINGS.deltaSyncThreshold : Math.max(0, Math.min(num, 100));
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Strict security")
            .setDesc("Only accept devices this vault has an encryption key for, and reject unencrypted messages from them. Devices that were never paired with the full pairing code will need to pair again.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.strictSecurity)
                .onChange(async (value) => {
                    this.plugin.settings.strictSecurity = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Idle Timeout (ms)")
            .setDesc("Maximum time to wait for a sync operation without progress before aborting.")
            .addText(text => text
                .setValue(this.plugin.settings.idleTimeoutMs?.toString() || "30000")
                .onChange(async (value) => {
                    const num = parseInt(value);
                    this.plugin.settings.idleTimeoutMs = isNaN(num) ? DEFAULT_SETTINGS.idleTimeoutMs : Math.max(5000, Math.min(num, 600000));
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Tombstone Retention (Days)")
            .setDesc("How long to remember deleted files. Peers offline longer than this might resurrect deleted files.")
            .addText(text => text
                .setValue(this.plugin.settings.tombstoneRetentionDays?.toString() || "30")
                .onChange(async (value) => {
                    const num = parseInt(value);
                    this.plugin.settings.tombstoneRetentionDays = isNaN(num) ? DEFAULT_SETTINGS.tombstoneRetentionDays : Math.max(0, Math.min(num, 3650));
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Max Concurrent Transfers")
            .setDesc("Maximum number of files to transfer at once. Leave empty for dynamic (auto-tuning).")
            .addText(text => text
                .setPlaceholder("Auto")
                .setValue(this.plugin.settings.maximumConcurrentTransfers?.toString() || "")
                .onChange(async (value) => {
                    const num = parseInt(value);
                    this.plugin.settings.maximumConcurrentTransfers = isNaN(num) ? null : Math.max(1, Math.min(num, 100));
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Chunk Size (Bytes)")
            .setDesc("Size of file chunks in bytes. Default is dynamic (starts at 64KB).")
            .addText(text => text
                .setPlaceholder("Auto")
                .setValue(this.plugin.settings.chunkSize?.toString() || "")
                .onChange(async (value) => {
                    const num = parseInt(value);
                    this.plugin.settings.chunkSize = isNaN(num) ? null : Math.max(MIN_CHUNK_SIZE, Math.min(num, MAX_CHUNK_SIZE));
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Debounce Delay (ms)")
            .setDesc("Time to wait after a file change before syncing. Higher values reduce sync frequency.")
            .addText(text => text
                .setValue(this.plugin.settings.debounceDelay.toString())
                .onChange(async (value) => {
                    const num = parseInt(value);
                    this.plugin.settings.debounceDelay = isNaN(num) ? DEFAULT_SETTINGS.debounceDelay : Math.max(250, num);
                    this.plugin.updateDebounceDelay();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Modification Time Tolerance (ms)")
            .setDesc("Time difference to consider files 'the same' to account for clock skew.")
            .addText(text => text
                .setValue(this.plugin.settings.mtimeTolerance.toString())
                .onChange(async (value) => {
                    const num = parseInt(value);
                    this.plugin.settings.mtimeTolerance = isNaN(num) ? DEFAULT_SETTINGS.mtimeTolerance : Math.max(0, num);
                    await this.plugin.saveSettings();
                }));
    }

    hide(): void {
        if (this.statusInterval) {
            clearInterval(this.statusInterval);
            this.statusInterval = null;
        }
    }

    private createEditableName(container: HTMLElement, displayName: string, editValue: string, onSave: (newName: string) => void) {
        container.empty();
        const wrapper = container.createDiv({ cls: 'od-editable-name-container' });
        
        wrapper.createSpan({ text: displayName, cls: 'od-editable-name-text' });
        const iconEl = wrapper.createSpan({ cls: 'od-editable-name-icon' });
        setIcon(iconEl, 'pencil');

        const switchToEdit = () => {
            this.isEditingName = true;
            wrapper.empty();
            wrapper.removeClass('od-editable-name-container'); 
            wrapper.addClass('od-setting-item-name-wrapper');

            const inputEl = wrapper.createEl('input', { type: 'text', value: editValue });
            inputEl.addClass('od-editable-name-input');
            
            const save = () => {
                this.isEditingName = false;
                const newName = inputEl.value.trim();
                if (newName && newName.length <= 64) {
                    if (newName !== editValue) {
                        onSave(newName);
                    } else {
                        this.createEditableName(container, displayName, editValue, onSave);
                    }
                } else {
                    new Notice(newName === "" ? "Name cannot be empty." : "Name cannot exceed 64 characters.", 5000);
                    this.createEditableName(container, displayName, editValue, onSave);
                }
            };

            const submitBtn = wrapper.createSpan({ cls: 'od-editable-name-submit' });
            setIcon(submitBtn, 'check');
            submitBtn.onclick = (e) => { e.stopPropagation(); save(); };

            inputEl.onkeydown = (e) => { 
                if (e.key === 'Enter') save(); 
                if (e.key === 'Escape') { this.isEditingName = false; this.createEditableName(container, displayName, editValue, onSave); }
            };
            inputEl.onclick = (e) => e.stopPropagation();
            
            setTimeout(() => inputEl.focus(), 0);
        };
        wrapper.onclick = (e) => { e.preventDefault(); switchToEdit(); };
    }

    updateStatus() {
        // Polled every 3 s while the tab is open. Both sections below are full DOM
        // rebuilds (setIcon parses an SVG; the cluster list constructs a Setting per
        // peer), so skip the work entirely when nothing on screen would change.
        const status = this.plugin.calculateStatus();
        const peers = Array.from(this.plugin.clusterPeers.values());
        const signature = [
            status.text, status.icon, status.state, status.spin ? '1' : '0',
            peers.map(p => `${p.deviceId}:${p.friendlyName}:${this.plugin.connections.has(p.deviceId) ? 1 : 0}:${this.plugin.settings.peerKeys[p.deviceId] ? 1 : 0}`).join(','),
            this.plugin.settings.companionPeerId ?? '',
            this.plugin.directIpServer?.getPin() ?? '',
            this.plugin.getLocalIps().map(a => a.address).join(','),
        ].join('|');

        if (signature === this.lastStatusSignature) return;
        this.lastStatusSignature = signature;

        if (this.statusTextEl) {
            this.statusTextEl.empty();
            const iconSpan = this.statusTextEl.createSpan({ cls: 'od-status-icon' });
            setIcon(iconSpan, status.icon);
            if (status.spin) iconSpan.addClass('lucide-spin');
            this.statusTextEl.createSpan({ text: status.text });
        }

        if (!this.clusterStatusEl || !this.clusterStatusEl.isConnected) {
            return;
        }
        if (this.isEditingName) {
            // Nothing was rendered, so don't let the signature suppress the next pass.
            this.lastStatusSignature = null;
            return;
        }
        this.clusterStatusEl.empty();

        const createEntry = (peer: PeerInfo, type: 'self' | 'companion' | 'peer' | 'host' | 'disconnected') => {
            const hasKey = type === 'self' || !!this.plugin.settings.peerKeys[peer.deviceId];
            const connected = type === 'self' || (this.plugin.connections.has(peer.deviceId) && this.plugin.connections.get(peer.deviceId)?.open);
            const desc = type === 'self'
                ? 'This device'
                : type === 'host'
                    ? 'Offline host'
                    : `${connected ? 'Connected' : 'Saved'} · ${hasKey ? 'Encrypted' : 'Not encrypted — pair again with the full code'}`;
            const settingItem = new Setting(this.clusterStatusEl!)
                .setDesc(desc);

            if (type === 'self') {
                this.createEditableName(settingItem.nameEl, peer.friendlyName + ' (this device)', peer.friendlyName, async (newName) => {
                    await this.plugin.setFriendlyName(newName);
                });
                settingItem.addButton(btn => btn.setButtonText('New ID').onClick(() => {
                    new ConfirmModal(this.app, {
                        title: 'Give this device a new ID?',
                        body: 'Use this if you copied the vault from another computer and both cannot stay online. You will need to pair again from Connect devices.',
                        confirmText: 'Create new ID',
                        onConfirm: async () => {
                            await this.plugin.resetDeviceIdentity();
                            this.updateStatus();
                        },
                    }).open();
                }));
            } else if (type === 'peer' || type === 'disconnected') {
                this.createEditableName(settingItem.nameEl, peer.friendlyName, peer.friendlyName, (newName) => {
                    this.plugin.broadcastData({ type: 'cluster-rename', targetDeviceId: peer.deviceId, newName });
                    peer.friendlyName = newName;
                    this.plugin.saveKnownPeers();
                    this.updateStatus();
                });
            } else {
                settingItem.setName(peer.friendlyName);
            }

            if (type === 'companion') {
                settingItem.nameEl.createSpan({ text: ' Primary', cls: 'od-primary-label' });
            }

            if (type === 'companion') {
                settingItem.addButton(btn => btn.setButtonText('Unpair').setWarning().onClick(() => {
                    new ConfirmModal(this.app, {
                        title: 'Unpair this device?',
                        body: `${peer.friendlyName} will no longer be your primary sync partner. You can pair again later.`,
                        confirmText: 'Unpair',
                        onConfirm: async () => {
                            await this.plugin.forgetCompanion();
                            this.updateStatus();
                        },
                    }).open();
                }));
            }
            if (type === 'peer' || type === 'disconnected') {
                settingItem.addExtraButton(btn => btn
                    .setIcon('star')
                    .setTooltip('Set as Primary Sync Partner — reconnects automatically')
                    .onClick(async () => {
                        this.plugin.settings.companionPeerId = peer.deviceId;
                        await this.plugin.saveSettings();
                        // Tell the other device it is now paired with us — without this
                        // message the pairing was one-sided and the peer never knew.
                        this.plugin.sendData(peer.deviceId, { type: 'companion-pair', peerInfo: persistablePeerInfo(this.plugin.getMyPeerInfo()) });
                        this.plugin.tryToConnectToClusterPeers();
                        this.updateStatus();
                    })
                );
            }
            if (type === 'peer' || type === 'companion' || type === 'disconnected') {
                const conn = this.plugin.connections.get(peer.deviceId);
                const openPairing = () => new ConnectionModal(this.app, this.plugin).open();
                if (conn && conn.open) {
                    if (!hasKey) {
                        // Gossip can list a device you never paired with. Reconnect/Disconnect
                        // cannot create the key — only exchanging the full pairing code can.
                        settingItem.addButton(btn => btn.setButtonText('Pair').setCta().onClick(openPairing));
                    }
                    settingItem.addButton(btn => btn.setButtonText('Disconnect').onClick(() => {
                        conn.close();
                        this.plugin.showNotice(`Disconnecting from ${peer.friendlyName}`, 'important');
                        setTimeout(() => this.updateStatus(), 100);
                    }));
                    settingItem.addExtraButton(btn => btn.setIcon('trash').setTooltip('Remove from group').onClick(() => {
                        new ConfirmModal(this.app, {
                            title: `Remove ${peer.friendlyName} from the group?`,
                            body: `${peer.friendlyName} is forgotten on every device in the group and will not reconnect on its own. Pair again to add it back.`,
                            confirmText: 'Remove device',
                            onConfirm: () => {
                                void this.plugin.forgetDevice(peer.deviceId, { broadcast: true, kick: true });
                            },
                        }).open();
                    }));
                    if (this.plugin.settings.syncMode === 'advanced') {
                        settingItem.addExtraButton(btn => btn.setIcon('activity').setTooltip('Ping').onClick(() => {
                            this.plugin.manualPingStart.set(peer.deviceId, Date.now());
                            this.plugin.sendDirect(conn, { type: 'ping' });
                        }));
                    }
                } else {
                    settingItem.nameEl.style.color = 'var(--text-muted)';

                    if (!hasKey) {
                        settingItem.addButton(btn => btn.setButtonText('Pair').setCta().onClick(openPairing));
                    } else {
                        settingItem.addButton(btn => btn.setButtonText('Reconnect').setCta().onClick(() => {
                            if (this.plugin.peer && !this.plugin.peer.disconnected) {
                                this.plugin.showNotice(`Reconnecting to ${peer.friendlyName}...`, 'important');
                                this.plugin.dialPeer(peer.deviceId);
                            } else {
                                this.plugin.showNotice("Cannot reconnect: this device cannot reach the sync network yet.", 'error');
                            }
                        }));
                    }
                    if (type !== 'companion') {
                        settingItem.addButton(btn => btn.setButtonText('Forget').setWarning().onClick(() => {
                            new ConfirmModal(this.app, {
                                title: `Forget ${peer.friendlyName}?`,
                                body: 'This device is removed from your saved devices and its encryption key is deleted. You will need to pair again to sync with it.',
                                confirmText: 'Forget device',
                                onConfirm: () => {
                                    void this.plugin.forgetDevice(peer.deviceId, { broadcast: true });
                                },
                            }).open();
                        }));
                    }
                }
            } else if (type === 'host') {
                settingItem.addButton(btn => btn.setButtonText('Disconnect').onClick(() => {
                    this.plugin.reinitializeConnectionManager();
                    setTimeout(() => this.updateStatus(), 100);
                }));
            }
        };
        createEntry(this.plugin.getMyPeerInfo(), 'self');

        if (this.plugin.getConnectionMode() === 'direct-ip') {
            const list = this.clusterStatusEl;
            if (this.plugin.directIpServer) {
                const addrs = this.plugin.getLocalIps();
                const ip = addrs[0]?.address ?? null;
                const pin = this.plugin.directIpServer.getPin();
                list.createEl('p', { text: 'This computer is hosting Offline Mode. Other devices join with the IP and token below.' });
                renderHostAddresses(list, addrs, this.plugin.settings.directIpHostPort);
                list.createEl('p', { text: `Token: ${pin}`, cls: 'od-pin-display od-token' });
                new Setting(list)
                    .addButton(btn => btn.setButtonText('Copy token').setCta().onClick(async () => {
                        try {
                            await navigator.clipboard.writeText(pin);
                            new Notice('Token copied.');
                        } catch {
                            new Notice('Select the token and copy it (Ctrl+C / Cmd+C).');
                        }
                    }))
                    .addButton(btn => btn.setButtonText('Copy IP and token').onClick(async () => {
                        if (!ip) {
                            new Notice('No network address to copy.');
                            return;
                        }
                        try {
                            await navigator.clipboard.writeText(`${ip}:${this.plugin.settings.directIpHostPort}\n${pin}`);
                            new Notice('IP and token copied.');
                        } catch {
                            new Notice('Select the IP and token and copy them (Ctrl+C / Cmd+C).');
                        }
                    }));
            } else if (this.plugin.directIpClient) {
                // Look up the actual host entry — taking the FIRST clusterPeers value
                // showed a stale, unrelated known peer as the connected host.
                const hostInfo = this.plugin.clusterPeers.get('direct-ip-host');
                if (hostInfo) createEntry(hostInfo, 'host');
            } else {
                list.createEl('p', { text: 'Offline Mode is idle. Open Connect devices to start hosting, or join with an IP and token.' });
                new Setting(list).addButton(btn => btn.setButtonText('Connect devices').setCta()
                    .onClick(() => new ConnectionModal(this.app, this.plugin).open()));
            }
            return;
        }

        const unpaired = Array.from(this.plugin.clusterPeers.values())
            .filter(p => !this.plugin.settings.peerKeys[p.deviceId]);
        if (unpaired.length > 0) {
            const names = unpaired.map(p => p.friendlyName).join(', ');
            this.clusterStatusEl.createEl('p', {
                text: unpaired.length === 1
                    ? `${names} showed up in this list after you paired with someone else. That does not pair it with this device — tap Pair and use the full code from ${names}.`
                    : `These devices are listed here but are not paired with this device: ${names}. Pairing is one-to-one — tap Pair on each row and use that device’s full code.`,
                cls: 'od-text-muted'
            });
        }

        const companionId = this.plugin.settings.companionPeerId;
        if (companionId && this.plugin.clusterPeers.has(companionId)) {
            createEntry(this.plugin.clusterPeers.get(companionId)!, 'companion');
        }
        this.plugin.clusterPeers.forEach(peer => {
            if (peer.deviceId !== companionId) {
                const isConnected = this.plugin.connections.has(peer.deviceId) && this.plugin.connections.get(peer.deviceId)?.open;
                createEntry(peer, isConnected ? 'peer' : 'disconnected');
            }
        });

        if (this.plugin.clusterPeers.size === 0) {
            const list = this.clusterStatusEl;
            if (!this.plugin.peer || this.plugin.peer.disconnected) {
                list.createEl('p', { text: "Can't reach the sync network. Retrying…" });
            } else if (!this.plugin.peer.id) {
                list.createEl('p', { text: 'Connecting to the sync network…' });
            } else {
                list.createEl('p', { text: 'No other devices yet. Open Connect devices on this computer and on the phone or laptop you want to pair.' });
                new Setting(list).addButton(btn => btn.setButtonText('Connect devices').setCta()
                    .onClick(() => new ConnectionModal(this.app, this.plugin).open()));
            }
        }
    }
}
