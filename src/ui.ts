import { App, Modal, Platform, Setting, TFile, Notice, setIcon } from 'obsidian';
import DiffMatchPatch from 'diff-match-patch';
import type * as QRCodeType from 'qrcode';
import type { Html5Qrcode as Html5QrcodeType } from 'html5-qrcode';
import type ObsidianDecentralizedPlugin from './main';
import { PeerInfo, describeSyncPhase } from './types';
import { originalPathFromConflictCopy } from './utils';
import { buildPairingPayload, parsePairingInput, persistablePeerInfo } from './utils/pairing';
import { isGenericDeviceName } from './utils/device-name';
import { formatHostForUrl, parseHostInput, type LocalIpv4 } from './utils/net';

// The QR generator and scanner together account for over half the bundle, yet they
// are only reachable from the pairing modal. Importing them dynamically keeps their
// module-level initialisation (notably html5-qrcode's ZXing tables) off the plugin
// startup path — it now runs the first time a user actually opens pairing.
let qrCodeModule: typeof QRCodeType | null = null;
async function loadQRCode(): Promise<typeof QRCodeType> {
    if (!qrCodeModule) qrCodeModule = await import('qrcode');
    return qrCodeModule;
}

let html5QrcodeCtor: typeof Html5QrcodeType | null = null;
async function loadHtml5Qrcode(): Promise<typeof Html5QrcodeType> {
    if (!html5QrcodeCtor) html5QrcodeCtor = (await import('html5-qrcode')).Html5Qrcode;
    return html5QrcodeCtor;
}

/** Offline host: show every local IPv4 so a Hyper-V/VPN adapter is not the only choice. */
export function renderHostAddresses(parent: HTMLElement, addrs: LocalIpv4[], port: number) {
    if (addrs.length === 0) {
        parent.createDiv({
            text: 'No network address found — check that you are connected to Wi-Fi or Ethernet.',
            cls: 'mod-warning'
        });
        return;
    }
    const preferred = addrs[0];
    parent.createDiv({
        text: addrs.length > 1 ? `IP: ${preferred.address} (try this first)` : `IP: ${preferred.address}`,
        cls: 'od-ip-display'
    });
    parent.createDiv({ text: `Port: ${port}`, cls: 'od-text-muted' });
    if (addrs.length > 1) {
        const extras = addrs.slice(1).map(a => a.address).join(', ');
        parent.createDiv({
            text: `Also on this computer: ${extras}. If the other device cannot reach the host, try one of those — pick the address that looks like your Wi-Fi (usually 192.168…).`,
            cls: 'od-instruction-text'
        });
    }
}

export function formatBytes(bytes: number, decimals = 2) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.max(0, Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k))));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export class ConnectionModal extends Modal {
    private discoveredPeers: Map<string, PeerInfo> = new Map();
    private discoverListener: ((p: PeerInfo) => void) | null = null;
    private loseListener: ((p: PeerInfo) => void) | null = null;
    
    private activeTab: 'quick-pair' | 'advanced' = 'quick-pair';
    private statusState: 'idle' | 'connecting' | 'reconnecting' | 'connected' | 'error' = 'idle';
    private statusMessage: string = 'Ready to pair';
    private activePsk: string | null = null;
    private lastPairedId: string | null = null;
    private lastPairedName: string | null = null;
    private pairingRefreshTimer: number | null = null;
    private pairingValidityTimer: number | null = null;
    private handshakeTimer: number | null = null;
    private connectTimeout: number | null = null;

    constructor(app: App, private plugin: ObsidianDecentralizedPlugin) { super(app); }

    async onOpen() {
        this.contentEl.addClass(Platform.isMobile ? 'od-mobile' : 'od-desktop');

        // Offline Mode has no PeerJS pairing code. Opening on Quick Pair hid the IP/token
        // and offered a flow that cannot work ("wait until the status bar no longer says
        // Offline" while the bar reads "Offline Mode").
        if (this.plugin.getConnectionMode() === 'direct-ip') {
            this.activeTab = 'advanced';
        }
        
        if (this.plugin.getConnectionMode() === 'direct-ip' && this.plugin.directIpServer) {
            const n = this.plugin.directIpServer.getClients().length;
            this.statusState = 'connected';
            this.statusMessage = n > 0
                ? `Hosting — ${n} device${n === 1 ? '' : 's'} connected`
                : 'Hosting — waiting for devices';
        } else if (this.plugin.connections && this.plugin.connections.size > 0) {
            // Direct IP: reflect liveness/reconnect state precisely
            const client = this.plugin.directIpClient;
            if (client) {
                if (client.isFatalError) {
                    this.statusState = 'error';
                    this.statusMessage = 'Host rejected the token — copy a fresh one from the host Connect screen.';
                } else if (!client.isOpen) {
                    this.statusState = 'reconnecting';
                    this.statusMessage = 'Reconnecting to the offline host…';
                } else if (!client.isLive) {
                    this.statusState = 'connecting';
                    this.statusMessage = 'Verifying the link to the offline host…';
                } else {
                    this.statusState = 'connected';
                    this.statusMessage = `Connected to ${this.plugin.connections.size} device${this.plugin.connections.size === 1 ? '' : 's'}`;
                }
            } else {
                this.statusState = 'connected';
                this.statusMessage = `Connected to ${this.plugin.connections.size} device${this.plugin.connections.size === 1 ? '' : 's'}`;
            }
        }
        
        // Opening this modal is what puts the device into pairing mode, so (re)start the
        // window here rather than leaving auto-enrolment armed for the whole session.
        this.activePsk = await this.plugin.beginPairingWindow();
        this.pairingRefreshTimer = window.setInterval(async () => {
            if (!this.plugin.getActivePsk()) {
                this.activePsk = await this.plugin.beginPairingWindow();
                if (this.statusState === 'idle') this.render();
            }
        }, 30000);
        
        this.render();
    }

    onClose() {
        if (this.pairingRefreshTimer) window.clearInterval(this.pairingRefreshTimer);
        if (this.pairingValidityTimer) window.clearInterval(this.pairingValidityTimer);
        if (this.handshakeTimer) window.clearTimeout(this.handshakeTimer);
        if (this.connectTimeout) window.clearTimeout(this.connectTimeout);
        if (this.plugin.lanDiscovery) {
            if (this.discoverListener) this.plugin.lanDiscovery.off('discover', this.discoverListener);
            if (this.loseListener) this.plugin.lanDiscovery.off('lose', this.loseListener);
            // Do NOT stopBroadcasting() here: the beacon is global (started at plugin
            // load) — stopping it on modal close made this device undiscoverable on
            // the LAN until the plugin was reloaded.
        }
        this.contentEl.empty();
    }

    render() {
        this.contentEl.empty();
        this.renderStatusBanner();
        this.renderTabNavigation();
        
        if (this.activeTab === 'quick-pair') {
            this.renderQuickPairTab();
        } else {
            this.renderAdvancedTab();
        }
    }

    renderStatusBanner() {
        const banner = this.contentEl.createDiv({ cls: `od-status-banner ${this.statusState}` });
        
        if (this.statusState === 'connecting') {
            const spinner = banner.createSpan();
            setIcon(spinner, 'loader');
            spinner.addClass('lucide-spin');
        } else if (this.statusState === 'reconnecting') {
            // Amber spinning indicator — connection was previously established but lost
            const spinner = banner.createSpan();
            setIcon(spinner, 'refresh-cw');
            spinner.addClass('lucide-spin');
        } else if (this.statusState === 'connected') {
            // Only shown after liveness is confirmed (Phase 4)
            const check = banner.createSpan();
            setIcon(check, 'check-circle');
        } else if (this.statusState === 'error') {
            // Only shown for non-recoverable failures (e.g. PIN rejection)
            const alert = banner.createSpan();
            setIcon(alert, 'alert-triangle');
        } else {
            const ready = banner.createSpan();
            setIcon(ready, 'radio');
        }
        
        banner.createSpan({ text: this.statusMessage });
    }

    renderTabNavigation() {
        const tabsContainer = this.contentEl.createDiv({ cls: 'od-connection-tabs' });
        
        const quickPairBtn = tabsContainer.createEl('button', {
            text: 'Quick Pair',
            cls: `od-tab-btn ${this.activeTab === 'quick-pair' ? 'active' : ''}`,
            attr: {
                'aria-label': 'Quick Pair tab',
                title: 'Pair by code, QR, or a nearby device',
                'aria-selected': this.activeTab === 'quick-pair' ? 'true' : 'false',
            },
        });
        quickPairBtn.onclick = () => { this.activeTab = 'quick-pair'; this.render(); };
        
        const advancedLabel = this.plugin.getConnectionMode() === 'direct-ip' ? 'Offline Mode' : 'Advanced';
        const advancedBtn = tabsContainer.createEl('button', {
            text: advancedLabel,
            cls: `od-tab-btn ${this.activeTab === 'advanced' ? 'active' : ''}`,
            attr: {
                'aria-label': `${advancedLabel} tab`,
                title: this.plugin.getConnectionMode() === 'direct-ip'
                    ? 'Host or join on the local network'
                    : 'Offline Mode and other options',
                'aria-selected': this.activeTab === 'advanced' ? 'true' : 'false',
            },
        });
        advancedBtn.onclick = () => { this.activeTab = 'advanced'; this.render(); };
    }

    private fail(message: string) {
        this.statusState = 'error';
        this.statusMessage = message;
        this.render();
    }

    private markPaired(peerId: string) {
        const name = this.plugin.clusterPeers.get(peerId)?.friendlyName || peerId;
        this.lastPairedId = peerId;
        this.lastPairedName = name;
        this.statusState = 'connected';
        this.statusMessage = `Paired with ${name}`;
        this.render();
    }

    private waitForHandshake(peerId: string): Promise<boolean> {
        return new Promise(resolve => {
            const started = Date.now();
            const tick = () => {
                if (this.plugin.connections.has(peerId)) {
                    resolve(true);
                    return;
                }
                if (Date.now() - started > 15000) {
                    resolve(false);
                    return;
                }
                this.handshakeTimer = window.setTimeout(tick, 200);
            };
            tick();
        });
    }

    async attemptConnection(raw: string, source: 'paste' | 'scan' | 'nearby' = 'paste') {
        const parsed = parsePairingInput(raw);
        if (parsed.kind === 'empty') return;

        if (parsed.kind === 'invalid') {
            this.fail(parsed.reason);
            return;
        }

        if (parsed.kind === 'device-id') {
            if (source === 'nearby') {
                this.fail('Open Connect devices on that device first, then tap it again. Nearby pairing needs both sides on this screen.');
            } else {
                this.fail('That is only a device ID, not the pairing code. On the other device press Copy, then paste the whole code here.');
            }
            return;
        }

        if (this.plugin.getConnectionMode() === 'direct-ip') {
            this.fail('This vault is in Offline Mode. Open the Offline Mode tab to host or join with an IP and token.');
            return;
        }

        const { deviceId: peerId, psk } = parsed;
        if (peerId === this.plugin.settings.deviceId || peerId === this.plugin.peer?.id) {
            this.fail('That is this device\'s own code. Paste the code from the other device.');
            return;
        }

        this.plugin.settings.peerKeys[peerId] = psk;
        this.plugin.unblockPeer(peerId);
        await this.plugin.saveSettings();

        if (!this.plugin.peer || this.plugin.peer.disconnected || !this.plugin.peer.id) {
            this.fail('This device cannot reach the sync network yet. Wait until the status bar changes, then try again. If you have no internet, use the Offline Mode tab instead.');
            return;
        }

        this.statusState = 'connecting';
        this.statusMessage = 'Connecting… keep Connect devices open on both sides.';
        this.render();

        // dialPeer registers the plugin's handlers BEFORE 'open' fires. setupConnection
        // attaches its own 'open' listener (which sends the handshake); registering it lazily
        // inside our own open handler missed the event, so the handshake was never sent and
        // pairing produced a half-open one-way connection.
        const conn = this.plugin.dialPeer(peerId);
        if (!conn) {
            this.fail('Could not start the connection. Check that both devices are online and try again.');
            return;
        }

        if (this.connectTimeout) window.clearTimeout(this.connectTimeout);
        this.connectTimeout = window.setTimeout(() => {
            if (this.statusState === 'connecting') {
                this.fail('Timed out. Check the code, keep this screen open on both devices, and try again.');
            }
        }, 20000);

        conn.on('open', async () => {
            if (this.connectTimeout) window.clearTimeout(this.connectTimeout);
            this.statusState = 'connecting';
            this.statusMessage = 'Confirming the pairing…';
            this.render();
            const ok = await this.waitForHandshake(peerId);
            if (ok) this.markPaired(peerId);
            else if (this.statusState === 'connecting') {
                this.fail('The other device did not finish pairing. Keep Connect devices open on both sides and try again.');
            }
        });

        conn.on('error', () => {
            if (this.connectTimeout) window.clearTimeout(this.connectTimeout);
            this.fail('Connection failed. Check the code and that the other device is online.');
        });
    }

    renderQuickPairTab() {
        const { contentEl } = this;
        if (this.plugin.getConnectionMode() === 'direct-ip') {
            this.renderOfflineInsteadOfPairing(contentEl);
            return;
        }

        contentEl.createEl('h2', { text: 'Connect devices', cls: 'od-dashboard-header' });
        contentEl.createDiv({
            text: 'One device shows this screen. On the other, paste the code or scan the QR.',
            cls: 'od-dashboard-subtitle'
        });

        if (this.statusState === 'connected' && this.lastPairedId) {
            this.renderPairSuccess(contentEl);
            return;
        }

        this.renderDeviceNameField(contentEl);

        const myInfo = this.plugin.getMyPeerInfo();
        if (!myInfo || !myInfo.deviceId) {
            contentEl.createDiv({ text: 'This device does not have an ID yet. Wait a moment and open this screen again.', cls: 'mod-warning' });
            return;
        }

        if (!this.activePsk) {
            contentEl.createDiv({ text: 'Could not create a pairing key. Close this window and open it again.', cls: 'mod-warning' });
            return;
        }

        const qrPayload = buildPairingPayload(myInfo.deviceId, this.activePsk);

        contentEl.createDiv({ text: 'Your pairing code', cls: 'od-step-header' });
        const codeContainer = contentEl.createDiv({ cls: 'od-pairing-code-container' });
        codeContainer.createDiv({ text: qrPayload, cls: 'od-pairing-code-text' });

        const copyBtn = codeContainer.createEl('button', {
            text: 'Copy pairing code',
            cls: 'mod-cta',
            attr: {
                'aria-label': 'Copy pairing code',
                title: 'Copy the full pairing code to the clipboard',
            },
        });
        copyBtn.onclick = async () => {
            try {
                await navigator.clipboard.writeText(qrPayload);
                copyBtn.setText('Copied');
                window.setTimeout(() => copyBtn.setText('Copy pairing code'), 2000);
            } catch {
                const range = document.createRange();
                range.selectNodeContents(codeContainer.querySelector('.od-pairing-code-text')!);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
                new Notice('Select the code and copy it (Ctrl+C / Cmd+C).');
            }
        };

        contentEl.createDiv({
            text: 'This is the whole code — including the encryption key. Treat it like a password.',
            cls: 'od-instruction-text'
        });
        this.renderPairingValidity(contentEl);

        const qrSection = contentEl.createDiv({ cls: 'od-qr-section' });
        qrSection.createDiv({ text: 'Or scan this QR on the other device', cls: 'od-qr-label' });

        const imgEl = qrSection.createEl('img');
        imgEl.setAttr('alt', 'Pairing QR code');
        loadQRCode()
            .then(QRCode => QRCode.toDataURL(qrPayload, { width: 180, margin: 2 }))
            .then(url => { imgEl.src = url; })
            .catch(() => {
                imgEl.remove();
                qrSection.createEl('p', { text: 'Could not draw the QR code. Use Copy pairing code instead.', cls: 'od-text-muted' });
            });

        const scanBtn = qrSection.createEl('button', {
            text: 'Scan their QR code',
            cls: 'od-full-width',
            attr: {
                'aria-label': 'Scan their QR code',
                title: 'Open the camera to scan the other device pairing QR code',
            },
        });
        scanBtn.onclick = () => {
            new QRScannerModal(this.app, (scannedId) => {
                this.attemptConnection(scannedId, 'scan');
            }).open();
        };

        contentEl.createDiv({ cls: 'od-section-divider' });
        contentEl.createDiv({ text: 'Have their code?', cls: 'od-step-header' });

        const inputRow = contentEl.createDiv({ cls: 'od-input-row' });
        const input = inputRow.createEl('input', {
            type: 'text',
            placeholder: 'Paste the pairing code from the other device',
            attr: { autocomplete: 'off', spellcheck: 'false' },
        });
        const connectBtn = inputRow.createEl('button', {
            text: 'Connect',
            cls: 'mod-cta',
            attr: {
                'aria-label': 'Connect with pairing code',
                title: 'Connect using the pasted pairing code',
            },
        });
        const submitPaste = () => this.attemptConnection(input.value, 'paste');
        connectBtn.onclick = submitPaste;
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitPaste();
            }
        });
        input.addEventListener('paste', () => {
            window.setTimeout(() => {
                if (parsePairingInput(input.value).kind === 'full') submitPaste();
            }, 0);
        });

        this.renderNearbyList(contentEl);
    }

    private pairingValidityLabel(): string {
        const remaining = this.plugin.activePskExpiresAt - Date.now();
        if (remaining <= 0) return 'This pairing code has expired.';
        const minutes = Math.max(1, Math.ceil(remaining / 60_000));
        return minutes === 1 ? 'Code valid for 1 minute' : `Code valid for ${minutes} minutes`;
    }

    private renderPairingValidity(parent: HTMLElement) {
        if (this.pairingValidityTimer) window.clearInterval(this.pairingValidityTimer);
        const el = parent.createDiv({ text: this.pairingValidityLabel(), cls: 'od-instruction-text' });
        this.pairingValidityTimer = window.setInterval(() => {
            if (!el.isConnected) {
                if (this.pairingValidityTimer) {
                    window.clearInterval(this.pairingValidityTimer);
                    this.pairingValidityTimer = null;
                }
                return;
            }
            el.setText(this.pairingValidityLabel());
        }, 15000);
    }

    private renderDeviceNameField(parent: HTMLElement) {
        const wrap = parent.createDiv({ cls: 'od-device-name-block' });
        if (isGenericDeviceName(this.plugin.settings.friendlyName)) {
            wrap.createDiv({
                text: 'Name this device first — both sides default to the same label, so you cannot tell them apart.',
                cls: 'mod-warning'
            });
        }
        wrap.createDiv({ text: 'This device', cls: 'od-step-header' });
        const row = wrap.createDiv({ cls: 'od-input-row' });
        const input = row.createEl('input', {
            type: 'text',
            placeholder: 'Phone, Desktop…',
            value: this.plugin.settings.friendlyName,
            attr: { maxlength: '64', autocomplete: 'off' },
        });
        const save = async () => {
            const ok = await this.plugin.setFriendlyName(input.value);
            if (!ok) {
                new Notice('Name must be 1–64 characters.');
                input.value = this.plugin.settings.friendlyName;
                return;
            }
            input.value = this.plugin.settings.friendlyName;
        };
        input.addEventListener('change', () => { void save(); });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                void save();
            }
        });
    }

    private renderOfflineInsteadOfPairing(contentEl: HTMLElement) {
        contentEl.createEl('h2', { text: 'Connect devices', cls: 'od-dashboard-header' });
        contentEl.createDiv({
            text: 'This vault is in Offline Mode. Pairing codes and QR need the standard connection and do not work here.',
            cls: 'od-dashboard-subtitle'
        });
        contentEl.createDiv({
            text: 'Host or join with an IP and token on the Offline Mode tab — that is also where this screen opens while Offline Mode is on.',
            cls: 'od-instruction-text'
        });
        const go = contentEl.createEl('button', { text: 'Open Offline Mode', cls: 'mod-cta od-full-width' });
        go.onclick = () => { this.activeTab = 'advanced'; this.render(); };
        const back = contentEl.createEl('button', { text: 'Switch to Standard Mode', cls: 'od-full-width' });
        back.onclick = async () => {
            this.plugin.settings.connectionMode = 'peerjs';
            await this.plugin.saveSettings();
            this.plugin.reinitializeConnectionManager();
            this.statusState = 'idle';
            this.statusMessage = 'Ready to pair';
            this.render();
        };
    }

    private renderPairSuccess(contentEl: HTMLElement) {
        const card = contentEl.createDiv({ cls: 'od-pair-success' });
        card.createDiv({ text: `Paired with ${this.lastPairedName}.`, cls: 'od-pair-success-title' });
        card.createDiv({
            text: this.plugin.settings.peerKeys[this.lastPairedId!]
                ? 'This link is encrypted. Both devices will try to reconnect automatically if you set a primary partner.'
                : 'Paired, but this link is not encrypted.',
            cls: 'od-instruction-text'
        });

        const otherDevices = Array.from(this.plugin.clusterPeers.values())
            .filter(p => p.deviceId !== this.lastPairedId);
        if (otherDevices.length > 0) {
            const names = otherDevices.map(p => p.friendlyName).join(', ');
            card.createDiv({
                text: otherDevices.length === 1
                    ? `${names} and ${this.lastPairedName} still need to pair with each other. Open Connect devices on those two and exchange the full code.`
                    : `Your other devices (${names}) still need to pair with ${this.lastPairedName} directly. Pairing is one-to-one.`,
                cls: 'od-instruction-text'
            });
        }

        if (this.lastPairedId && this.plugin.settings.companionPeerId !== this.lastPairedId) {
            const pairedId = this.lastPairedId;
            const primaryBtn = card.createEl('button', { text: 'Keep us connected automatically', cls: 'mod-cta od-full-width' });
            primaryBtn.onclick = async () => {
                this.plugin.settings.companionPeerId = pairedId;
                await this.plugin.saveSettings();
                this.plugin.sendData(pairedId, { type: 'companion-pair', peerInfo: persistablePeerInfo(this.plugin.getMyPeerInfo()) });
                this.plugin.tryToConnectToClusterPeers();
                primaryBtn.setText('Saved as primary partner');
                primaryBtn.disabled = true;
            };
        } else {
            card.createDiv({ text: 'This is already your primary sync partner.', cls: 'od-text-muted' });
        }

        const done = card.createEl('button', { text: 'Done', cls: 'od-full-width od-spaced-top' });
        done.onclick = () => this.close();

        const another = card.createEl('button', { text: 'Pair another device', cls: 'od-full-width' });
        another.onclick = () => {
            this.lastPairedId = null;
            this.lastPairedName = null;
            this.statusState = 'idle';
            this.statusMessage = 'Ready to pair';
            this.render();
        };
    }

    private renderNearbyList(contentEl: HTMLElement) {
        contentEl.createDiv({ cls: 'od-section-divider' });
        contentEl.createDiv({ text: 'Nearby on this Wi-Fi', cls: 'od-step-header' });

        if (Platform.isMobile) {
            contentEl.createDiv({
                text: 'Nearby discovery is desktop-only. On this phone, paste the desktop pairing code or scan its QR.',
                cls: 'od-instruction-text'
            });
            return;
        }

        const lanList = contentEl.createDiv({ cls: 'od-peer-list' });

        const renderLanList = () => {
            lanList.empty();
            if (this.discoveredPeers.size === 0) {
                const emptyState = lanList.createDiv({ cls: 'od-scanning' });
                emptyState.createSpan({ cls: 'od-pulsing-indicator' });
                emptyState.createSpan({ text: 'Looking for devices on this network…' });
                return;
            }
            this.discoveredPeers.forEach((peer) => {
                const alreadyPaired = this.plugin.connections.has(peer.deviceId)
                    || !!this.plugin.settings.peerKeys[peer.deviceId];
                const ready = !alreadyPaired && !!peer.pairingKey;
                const card = lanList.createDiv({
                    cls: `od-lan-card ${ready ? 'mod-clickable' : 'od-lan-card-wait'}`,
                    attr: {
                        'aria-label': alreadyPaired
                            ? `${peer.friendlyName} is already paired`
                            : ready
                                ? `Pair with ${peer.friendlyName}`
                                : `${peer.friendlyName} is not ready. Open Connect devices on that device first`,
                        title: alreadyPaired
                            ? 'Already paired'
                            : ready
                                ? `Tap to pair with ${peer.friendlyName}`
                                : 'Open Connect devices on that device first',
                    },
                });
                const title = card.createDiv({ cls: 'od-peer-name' });
                title.setText(peer.friendlyName);
                card.createDiv({
                    text: alreadyPaired
                        ? 'Already paired'
                        : ready
                            ? 'Ready to pair — tap to connect'
                            : 'Open Connect devices on that device first',
                    cls: 'od-text-muted'
                });
                if (ready) {
                    card.onclick = () => this.attemptConnection(buildPairingPayload(peer.deviceId, peer.pairingKey!), 'nearby');
                }
            });
        };

        if (this.discoverListener && this.plugin.lanDiscovery) this.plugin.lanDiscovery.off('discover', this.discoverListener);
        if (this.loseListener && this.plugin.lanDiscovery) this.plugin.lanDiscovery.off('lose', this.loseListener);

        this.discoverListener = (p: PeerInfo) => { this.discoveredPeers.set(p.deviceId, p); renderLanList(); };
        this.loseListener = (p: PeerInfo) => { this.discoveredPeers.delete(p.deviceId); renderLanList(); };

        if (this.plugin.lanDiscovery) {
            this.plugin.lanDiscovery.on('discover', this.discoverListener);
            this.plugin.lanDiscovery.on('lose', this.loseListener);
            this.plugin.lanDiscovery.startBroadcasting(this.plugin.getMyPeerInfo());
            this.plugin.lanDiscovery.startListening();
            for (const p of this.plugin.lanDiscovery.getDiscoveredPeers()) {
                this.discoveredPeers.set(p.deviceId, p);
            }
        }
        renderLanList();
    }

    renderAdvancedTab() {
        const { contentEl } = this;

        if (this.plugin.settings.connectionMode === 'direct-ip') {
            this.renderDirectIpDashboard();
            return;
        }

        contentEl.createEl('h2', { text: 'Advanced', cls: 'od-dashboard-header' });
        contentEl.createDiv({ text: 'Use this only when Quick Pair cannot reach the other device.', cls: 'od-dashboard-subtitle' });

        contentEl.createDiv({ cls: 'od-section-title', text: 'Offline Mode (same Wi-Fi, no internet)' });
        contentEl.createEl('p', {
            text: 'One desktop hosts. Other devices join with that desktop’s IP and token. Nothing goes through a signaling server.',
            cls: 'od-text-muted',
            attr: { style: 'font-size: 0.85em;' }
        });
        
        const footer = contentEl.createDiv({ cls: 'od-mode-switch', attr: { style: 'margin-top: 10px;' } });
        footer.setText("Switch to Offline Mode");
        footer.onclick = async () => {
            this.plugin.settings.connectionMode = 'direct-ip';
            await this.plugin.saveSettings();
            this.plugin.reinitializeConnectionManager();
            this.render();
        };
    }

    renderDirectIpDashboard() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Offline Mode', cls: 'od-dashboard-header' });
        contentEl.createDiv({ text: 'Connect directly over your local network', cls: 'od-dashboard-subtitle' });
        
        const container = contentEl.createDiv({ cls: 'od-direct-ip-wrapper' });

        if (this.plugin.directIpServer) {
            this.renderHostingCredentials(container, this.plugin.directIpServer.getPin());
            this.renderStandardModeSwitch(contentEl);
            return;
        }

        const client = this.plugin.directIpClient;
        if (client && !client.isFatalError) {
            this.renderOfflineClientStatus(container, client);
            this.renderStandardModeSwitch(contentEl);
            return;
        }

        container.createDiv({ cls: 'od-section-title', text: 'Step 1: Host a Network (Main device)' });
        if (!Platform.isMobile) {
            const hostBtn = container.createEl('button', { text: 'Start Hosting', cls: 'mod-cta od-full-width' });
            hostBtn.onclick = async () => {
                hostBtn.disabled = true;
                hostBtn.setText('Starting…');
                let pin: string | null = null;
                try {
                    pin = await this.plugin.startDirectIpHost();
                } finally {
                    hostBtn.disabled = false;
                    hostBtn.setText('Start Hosting');
                }
                // A null token means the socket never bound; startDirectIpHost has already
                // explained why, so don't paint a "Hosting Active" screen over the failure.
                if (!pin) return;
                this.statusState = 'connected';
                this.statusMessage = 'Hosting — waiting for devices';
                this.render();
            };
        } else {
            container.createDiv({ text: 'Hosting is not available on mobile. Join from here using the desktop’s IP and token.', cls: 'od-text-muted' });
        }

        if (!Platform.isMobile) {
            container.createDiv({ cls: 'od-section-title', text: 'Discovered Hosts' });
            const lanList = container.createDiv({ cls: 'od-peer-list' });
            const renderLanList = () => {
                lanList.empty();
                if (this.discoveredPeers.size === 0) {
                    const emptyState = lanList.createDiv({ cls: 'od-scanning' });
                    emptyState.createSpan({ cls: 'od-pulsing-indicator' });
                    emptyState.createSpan({ text: 'Scanning for hosts...' });
                } else {
                    this.discoveredPeers.forEach((peer) => {
                        const item = lanList.createDiv({ cls: 'od-peer-item' });
                        const info = item.createDiv({ cls: 'info' });
                        info.createDiv({ text: peer.friendlyName, cls: 'od-peer-name' });
                        info.createDiv({ text: `${peer.ip || 'Unknown IP'}:${peer.port || '???'}`, cls: 'sub-text' });
                        const btn = item.createEl('button', { text: 'Select' });
                        btn.onclick = async () => {
                            ipInput.value = peer.ip || '';
                            if (peer.port) { this.plugin.settings.directIpHostPort = peer.port; await this.plugin.saveSettings(); }
                            new Notice(`Selected ${peer.friendlyName}`);
                        };
                    });
                }
            };
            
            if (this.discoverListener && this.plugin.lanDiscovery) this.plugin.lanDiscovery.off('discover', this.discoverListener);
            if (this.loseListener && this.plugin.lanDiscovery) this.plugin.lanDiscovery.off('lose', this.loseListener);

            this.discoverListener = (p: PeerInfo) => { this.discoveredPeers.set(p.deviceId, p); renderLanList(); };
            this.loseListener = (p: PeerInfo) => { this.discoveredPeers.delete(p.deviceId); renderLanList(); };

            if (this.plugin.lanDiscovery) {
                this.plugin.lanDiscovery.on('discover', this.discoverListener);
                this.plugin.lanDiscovery.on('lose', this.loseListener);
                this.plugin.lanDiscovery.startBroadcasting(this.plugin.getMyPeerInfo());
                this.plugin.lanDiscovery.startListening();
                // Seed with peers discovered BEFORE this view opened
                for (const p of this.plugin.lanDiscovery.getDiscoveredPeers()) {
                    this.discoveredPeers.set(p.deviceId, p);
                }
            }
            renderLanList();
        }

        container.createDiv({ cls: 'od-section-divider' });

        if (client?.isFatalError) {
            container.createDiv({
                text: client.fatalReason || 'The host rejected this token. Check the IP and token from the hosting device and try again.',
                cls: 'mod-warning'
            });
        }

        container.createDiv({ cls: 'od-section-title', text: 'Step 2: Join a Network (Other devices)' });
        const ipInput = container.createEl('input', { type: 'text', placeholder: 'Host IP Address' });
        ipInput.value = this.plugin.settings.directIpHostAddress || '';
        if (Platform.isMobile) { ipInput.style.width = '100%'; ipInput.style.marginBottom = '10px'; }
        
        const pinInput = container.createEl('input', { type: 'text', placeholder: 'Security Token' });
        if (Platform.isMobile) { pinInput.style.width = '100%'; pinInput.style.marginBottom = '10px'; }

        // A one-line input drops the line break from the host's "Copy IP and token" text,
        // so split it here and fill both boxes.
        ipInput.addEventListener('paste', (event: ClipboardEvent) => {
            const parsed = parseHostInput(event.clipboardData?.getData('text') ?? '');
            if (!parsed?.token) return;
            event.preventDefault();
            ipInput.value = parsed.port ? `${formatHostForUrl(parsed.host)}:${parsed.port}` : parsed.host;
            pinInput.value = parsed.token;
        });

        const connectBtn = container.createEl('button', { text: 'Connect', cls: 'mod-cta od-full-width' });
        connectBtn.onclick = async () => {
            // Accepts "IP", "IP:port", "[IPv6]:port", or the host's "Copy IP and token" text.
            const parsed = parseHostInput(ipInput.value);
            const token = pinInput.value.trim() || parsed?.token || '';
            if (!ipInput.value.trim() || !token) {
                new Notice('Enter both the host IP and the token.');
                return;
            }
            if (!parsed) {
                new Notice('That does not look like an IP address. Enter the address shown on the hosting computer, like 192.168.1.20.');
                return;
            }
            this.plugin.settings.directIpHostAddress = parsed.host;
            if (parsed.port) this.plugin.settings.directIpHostPort = parsed.port;
            await this.plugin.saveSettings();
            this.statusState = 'connecting';
            this.statusMessage = 'Connecting to the offline host… keep this screen open.';
            try {
                await this.plugin.connectToDirectIpHost({ host: parsed.host, port: this.plugin.settings.directIpHostPort, pin: token });
            } catch (e: any) {
                this.fail(`Could not connect: ${e?.message || e}`);
                return;
            }
            this.render();
            this.watchDirectIpClient();
        };

        this.renderStandardModeSwitch(contentEl);
    }

    private renderHostingCredentials(container: HTMLElement, pin: string) {
        const addrs = this.plugin.getLocalIps();
        const ip = addrs[0]?.address ?? null;
        const port = this.plugin.settings.directIpHostPort;
        container.createDiv({ cls: 'od-section-title', text: 'Hosting on this network' });
        renderHostAddresses(container, addrs, port);
        container.createDiv({ text: `Token: ${pin}`, cls: 'od-pin-display od-token' });
        container.createDiv({
            text: 'On the other device open Connect devices → Offline Mode, then enter this IP and token. Reopen this screen anytime to see them again.',
            cls: 'od-instruction-text'
        });

        const copyToken = container.createEl('button', { text: 'Copy token', cls: 'mod-cta od-full-width od-spaced-top' });
        copyToken.onclick = async () => {
            try {
                await navigator.clipboard.writeText(pin);
                copyToken.setText('Copied');
                window.setTimeout(() => copyToken.setText('Copy token'), 1500);
            } catch {
                new Notice('Select the token and copy it (Ctrl+C / Cmd+C).');
            }
        };

        if (ip) {
            // With the port, so pasting this into the other device works on any port.
            const share = `${ip}:${port}\n${pin}`;
            const copyBoth = container.createEl('button', { text: 'Copy IP and token', cls: 'od-full-width' });
            copyBoth.onclick = async () => {
                try {
                    await navigator.clipboard.writeText(share);
                    copyBoth.setText('Copied');
                    window.setTimeout(() => copyBoth.setText('Copy IP and token'), 1500);
                } catch {
                    new Notice('Select the IP and token and copy them (Ctrl+C / Cmd+C).');
                }
            };
        }
    }

    private renderOfflineClientStatus(container: HTMLElement, client: { isOpen: boolean; isLive: boolean }) {
        const host = this.plugin.settings.directIpHostAddress || 'the host';
        const live = client.isOpen && client.isLive;
        if (!client.isOpen) {
            container.createDiv({ text: `Reconnecting to ${host}…`, cls: 'od-instruction-text' });
        } else if (!client.isLive) {
            container.createDiv({ text: `Verifying the link to ${host}…`, cls: 'od-instruction-text' });
        } else {
            container.createDiv({ text: `Connected to the offline host at ${host}.`, cls: 'od-instruction-text' });
        }
        container.createDiv({
            text: live
                ? 'Leave this vault open to stay connected. Disconnect to join a different host or start hosting on this device.'
                : 'If the IP or token is wrong, cancel and try again — you do not need to leave Offline Mode.',
            cls: 'od-text-muted'
        });
        const leave = container.createEl('button', {
            text: live ? 'Disconnect' : 'Try a different host',
            cls: live ? 'od-full-width od-spaced-top' : 'mod-cta od-full-width od-spaced-top',
        });
        leave.onclick = () => {
            if (this.handshakeTimer) window.clearTimeout(this.handshakeTimer);
            this.plugin.reinitializeConnectionManager();
            this.statusState = 'idle';
            this.statusMessage = 'Ready to pair';
            this.render();
        };
    }

    private watchDirectIpClient() {
        if (this.handshakeTimer) window.clearTimeout(this.handshakeTimer);
        const started = Date.now();
        const tick = () => {
            const client = this.plugin.directIpClient;
            if (!client) return;
            if (client.isFatalError) {
                this.fail(client.fatalReason || 'The host rejected this token. Check it and try again.');
                return;
            }
            if (client.isLive) {
                this.statusState = 'connected';
                this.statusMessage = `Connected to ${this.plugin.settings.directIpHostAddress}`;
                this.render();
                return;
            }
            if (Date.now() - started > 20000) {
                this.statusState = 'reconnecting';
                this.statusMessage = 'Still trying to reach the host. Check the IP and that the other device is hosting.';
                this.render();
                return;
            }
            this.handshakeTimer = window.setTimeout(tick, 200);
        };
        tick();
    }

    private renderStandardModeSwitch(parent: HTMLElement) {
        const footer = parent.createDiv({ cls: 'od-mode-switch' });
        footer.setText("Switch to Standard Mode");
        footer.onclick = async () => {
            this.plugin.settings.connectionMode = 'peerjs';
            await this.plugin.saveSettings();
            this.plugin.reinitializeConnectionManager();
            this.render();
        };
    }
}

export class QRScannerModal extends Modal {
    private html5QrCode: Html5QrcodeType | null = null;
    private startPromise: Promise<any> | null = null;
    constructor(app: App, private onScan: (text: string) => void) { super(app); }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Scan QR Code' });
        const readerId = 'od-qr-reader';
        contentEl.createDiv({
            attr: {
                id: readerId,
                'aria-label': 'Camera viewfinder for scanning a pairing QR code',
                title: 'Point the camera at the other device pairing QR code',
            },
        });

        // The scanner library is loaded on demand; onClose may run before it resolves,
        // so startPromise gates cleanup on the whole load-and-start sequence.
        this.startPromise = loadHtml5Qrcode().then(Html5Qrcode => {
            this.html5QrCode = new Html5Qrcode(readerId);
            return this.html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 250, height: 250 } }, (decodedText) => {
                this.onScan(decodedText);
                this.close();
            }, () => {});
        }).catch(err => {
            const raw = err instanceof Error ? err.message : String(err);
            const hint = /permission|notallowed|denied/i.test(raw)
                ? 'Camera permission was denied. Allow the camera, or paste the pairing code instead.'
                : /notfound|requested device not found|overconstrained/i.test(raw)
                    ? 'No camera found. Paste the pairing code instead.'
                    : 'Could not start the camera. Paste the pairing code instead.';
            contentEl.createEl('p', { text: hint, cls: 'mod-warning' });
            new Setting(contentEl).addButton(btn => {
                btn.setButtonText('Paste the pairing code instead')
                    .setCta()
                    .setTooltip('Close and paste the pairing code instead')
                    .onClick(() => this.close());
                btn.buttonEl?.setAttribute('aria-label', 'Close scanner and paste the pairing code instead');
            });
        });
    }
    
    onClose() {
        const cleanup = () => {
            if (this.html5QrCode && this.html5QrCode.isScanning) {
                this.html5QrCode.stop().then(() => {
                    this.html5QrCode?.clear();
                    this.contentEl.empty();
                }).catch((err) => {
                    console.error(err);
                    this.contentEl.empty();
                });
            } else {
                this.contentEl.empty();
            }
        };
        if (this.startPromise) {
            this.startPromise.then(cleanup).catch(console.error);
        } else {
            cleanup();
        }
    }
}

export class SelectPeerModal extends Modal {
    constructor(app: App, private plugin: ObsidianDecentralizedPlugin, private onSubmit: (peerId: string) => void) { super(app); }
    
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Force full sync' });
        contentEl.createEl('p', { text: 'Compares both vaults and exchanges whichever copy of each file is newer. Use this if the two devices look out of step.' });
        let selectedPeer = '';
        const peerList = Array.from(this.plugin.connections.keys());
        if (peerList.length === 0) {
            contentEl.createEl('p', { text: 'No device is connected right now. Pair one first, then run a full sync.' });
            new Setting(contentEl).addButton(btn => btn.setButtonText('Connect devices').setCta().onClick(() => {
                this.close();
                new ConnectionModal(this.app, this.plugin).open();
            }));
            return;
        }
        if (peerList.length > 0) {
            selectedPeer = peerList[0];
        }
        new Setting(contentEl).setName('Sync with Device').addDropdown(dropdown => {
            peerList.forEach(peerId => {
                const peerInfo = this.plugin.clusterPeers.get(peerId);
                dropdown.addOption(peerId, peerInfo?.friendlyName || peerId);
            });
            dropdown.setValue(selectedPeer);
            dropdown.onChange(value => selectedPeer = value);
        });
        new Setting(contentEl)
            .addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
            .addButton(btn => btn.setButtonText('Start full sync').setWarning().onClick(() => {
                if (selectedPeer) this.onSubmit(selectedPeer);
                this.close();
            }));
    }
    
    onClose() {
        this.contentEl.empty();
    }
}

export class ConflictCenter {
    private conflicts: Map<string, string> = new Map();
    private ribbonEl: HTMLElement | null = null;
    
    constructor(private app: App, private plugin: ObsidianDecentralizedPlugin) { }
    
    registerRibbon() {
        this.ribbonEl = this.plugin.addRibbonIcon('swords', 'Resolve Sync Conflicts', () => this.showConflictList());
        this.ribbonEl.style.display = 'none';
    }

    /** Rebuild from leftover ` (conflict on DATE)` copies so the ribbon survives a restart. */
    scanVault() {
        const found = new Map<string, string>();
        for (const file of this.app.vault.getFiles()) {
            const original = originalPathFromConflictCopy(file.path);
            if (!original) continue;
            if (!this.app.vault.getAbstractFileByPath(original)) continue;
            if (!found.has(original)) found.set(original, file.path);
        }
        this.conflicts = found;
        this.updateRibbon();
    }

    count(): number {
        return this.conflicts.size;
    }

    entries(): IterableIterator<[string, string]> {
        return this.conflicts.entries();
    }
    
    addConflict(originalPath: string, conflictPath: string) {
        this.conflicts.set(originalPath, conflictPath);
        this.updateRibbon();
    }
    
    resolveConflict(originalPath: string) {
        this.conflicts.delete(originalPath);
        this.updateRibbon();
    }
    
    updateRibbon() {
        if (!this.ribbonEl) return;
        if (this.conflicts.size > 0) {
            this.ribbonEl.show();
            this.ribbonEl.setAttribute('aria-label', `Resolve ${this.conflicts.size} sync conflicts`);
            let badge = this.ribbonEl.querySelector('.od-conflict-badge') as HTMLElement;
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'od-conflict-badge';
                this.ribbonEl.style.position = 'relative';
                this.ribbonEl.appendChild(badge);
            }
            badge.innerText = this.conflicts.size.toString();
        } else {
            this.ribbonEl.hide();
        }
    }
    
    showConflictList() {
        this.scanVault();
        new ConflictListModal(this.app, this, this.plugin).open();
    }
}

export class ConflictListModal extends Modal {
    constructor(app: App, private conflictCenter: ConflictCenter, private plugin: ObsidianDecentralizedPlugin) { super(app); }
    
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Sync Conflicts' });
        if (this.conflictCenter.count() === 0) {
            contentEl.createEl('p', { text: 'No leftover conflict copies in this vault.' });
            contentEl.createEl('p', {
                text: 'When two devices edit the same note, a second file named “Note (conflict on DATE)” is created and listed here — including after you restart Obsidian.',
                cls: 'od-text-muted'
            });
            return;
        }
        for (const [originalPath, conflictPath] of this.conflictCenter.entries()) {
            new Setting(contentEl).setName(originalPath).setDesc(`Other version: ${conflictPath}`)
                .addButton(btn => btn.setButtonText('Resolve').setCta().onClick(async () => {
                    this.close();
                    await this.showResolutionModal(originalPath, conflictPath);
                }));
        }
    }
    
    async showResolutionModal(originalPath: string, conflictPath: string) {
        const originalFile = this.app.vault.getAbstractFileByPath(originalPath) as TFile;
        const conflictFile = this.app.vault.getAbstractFileByPath(conflictPath) as TFile;
        if (!originalFile || !conflictFile) {
            this.plugin.showNotice("One of the conflict files is missing.", 'error');
            this.conflictCenter.resolveConflict(originalPath);
            this.reopenIfMoreRemain();
            return;
        }
        try {
            const backToList = () => this.reopenIfMoreRemain();
            // The choice is an ordinary edit here, and the copy's removal an ordinary deletion:
            // both sync. They used to be written with sync suppressed, so a device that picked
            // the conflict copy kept it to itself, and a copy that had reached other devices
            // was handed straight back by the next reconciliation.
            const finish = async () => {
                await this.app.fileManager.trashFile(conflictFile);
                this.conflictCenter.resolveConflict(originalPath);
                this.plugin.showNotice(`${originalPath} has been resolved.`, 'info');
                this.reopenIfMoreRemain();
            };
            if (this.plugin.isBinary(originalFile.extension)) {
                new BinaryConflictResolutionModal(this.app, originalFile.name, async (choice) => {
                    if (choice === 'copy') {
                        await this.app.vault.modifyBinary(originalFile, await this.app.vault.readBinary(conflictFile));
                    }
                    await finish();
                }, backToList).open();
            } else {
                const currentContent = await this.app.vault.read(originalFile);
                const copyContent = await this.app.vault.read(conflictFile);
                new ConflictResolutionModal(this.app, currentContent, copyContent, async (chosenContent) => {
                    // Keeping the current version changes nothing, so there is nothing to send.
                    if (chosenContent !== currentContent) await this.app.vault.modify(originalFile, chosenContent);
                    await finish();
                }, backToList).open();
            }
        } catch (e) {
            new Notice('Failed to read conflict files: ' + (e instanceof Error ? e.message : String(e)));
            this.conflictCenter.resolveConflict(originalPath);
            this.reopenIfMoreRemain();
        }
    }

    private reopenIfMoreRemain() {
        this.conflictCenter.scanVault();
        if (this.conflictCenter.count() > 0) this.conflictCenter.showConflictList();
    }
    
    onClose() {
        this.contentEl.empty();
    }
}

export class ConflictResolutionModal extends Modal {
    private decided = false;
    constructor(
        app: App,
        private localContent: string,
        private remoteContent: string,
        private onResolve: (chosenContent: string) => void,
        private onDismiss?: () => void,
    ) { super(app); }
    
    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('obsidian-decentralized-diff-modal');
        contentEl.createEl('h2', { text: 'Resolve Conflict' });
        contentEl.createEl('p', {
            text: 'The current version is the newer one and is what your other devices have. The conflict copy holds the edit that lost — highlighted below as added or removed text.',
            cls: 'od-text-muted',
        });
        const dmp = new DiffMatchPatch();
        const diff = dmp.diff_main(this.localContent, this.remoteContent);
        dmp.diff_cleanupSemantic(diff);
        const diffEl = contentEl.createDiv({ cls: 'obsidian-decentralized-diff-view' });
        for (const [op, text] of diff) {
            const span = diffEl.createSpan();
            span.setText(text);
            if (op === 1) span.addClass('od-diff-insert');
            if (op === -1) span.addClass('od-diff-delete');
        }
        new Setting(contentEl)
            .addButton(btn => btn.setButtonText('Decide later').onClick(() => this.close()))
            .addButton(btn => btn.setButtonText('Keep the current version').onClick(() => {
                this.decided = true;
                this.onResolve(this.localContent);
                this.close();
            }))
            .addButton(btn => btn.setButtonText('Use the conflict copy').setWarning().onClick(() => {
                this.decided = true;
                this.onResolve(this.remoteContent);
                this.close();
            }));
    }
    
    onClose() {
        this.contentEl.empty();
        if (!this.decided) this.onDismiss?.();
    }
}

export class BinaryConflictResolutionModal extends Modal {
    private decided = false;
    constructor(
        app: App,
        private fileName: string,
        private onResolve: (choice: 'current' | 'copy') => void,
        private onDismiss?: () => void,
    ) { super(app); }
    
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Resolve Binary Conflict' });
        contentEl.createEl('p', { text: `The file "${this.fileName}" is a binary file (e.g. image, pdf, audio). Differences cannot be shown.` });
        new Setting(contentEl)
            .addButton(btn => btn.setButtonText('Decide later').onClick(() => this.close()))
            .addButton(btn => btn.setButtonText('Keep the current version').onClick(() => {
                this.decided = true;
                this.onResolve('current');
                this.close();
            }))
            .addButton(btn => btn.setButtonText('Use the conflict copy').setWarning().onClick(() => {
                this.decided = true;
                this.onResolve('copy');
                this.close();
            }));
    }
    
    onClose() {
        this.contentEl.empty();
        if (!this.decided) this.onDismiss?.();
    }
}

/**
 * Confirmation prompt for actions that cannot be undone. The settings tab puts several of
 * these behind bare icon buttons, where a single stray click used to disconnect or forget a
 * device with no way back.
 */
export class ConfirmModal extends Modal {
    constructor(
        app: App,
        private opts: { title: string; body: string; confirmText: string; onConfirm: () => void }
    ) { super(app); }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: this.opts.title });
        contentEl.createEl('p', { text: this.opts.body });
        new Setting(contentEl)
            .addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
            .addButton(btn => btn.setButtonText(this.opts.confirmText).setWarning().onClick(() => {
                this.close();
                this.opts.onConfirm();
            }));
    }

    onClose() {
        this.contentEl.empty();
    }
}

export class SyncProgressModal extends Modal {
    private container: HTMLElement;
    private refreshInterval: number | null = null;
    private lastSignature: string | null = null;

    constructor(app: App, private plugin: ObsidianDecentralizedPlugin) { super(app); }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('od-progress-modal');
        contentEl.createEl('h2', { text: 'Sync Progress' });
        this.container = contentEl.createDiv();
        this.refresh();
        this.refreshInterval = window.setInterval(() => this.refresh(), 500);
    }

    onClose() {
        if (this.refreshInterval) clearInterval(this.refreshInterval);
        this.contentEl.empty();
    }

    /**
     * Cheap fingerprint of everything this modal displays.
     *
     * refresh() tears down and rebuilds the whole subtree, and it runs twice a second
     * for as long as the modal is open — including when absolutely nothing is happening.
     * The time bucket is only mixed in while work is in flight, so the elapsed-time and
     * throughput readouts still tick, but an idle modal settles to zero DOM work.
     */
    private stateSignature(): string {
        const s = this.plugin.syncState;
        const queued = this.plugin.queueManager.getQueueSize() + this.plugin.queueManager.getActiveTransfers();
        const parts: string[] = [
            s.isSyncing ? `S${s.currentPhase}|${s.filesTransferred}/${s.filesTotal}|${s.bytesTransferred}/${s.bytesTotal}|${s.currentFile ?? ''}|${s.currentFileSize ?? ''}` : 'S-',
            `Q${queued}`,
        ];
        for (const t of this.plugin.activeTransfers.values()) {
            parts.push(`T${t.id}:${t.processedChunks}/${t.totalChunks}:${t.status}:${t.direction}`);
        }
        for (const f of this.plugin.failedSyncs) {
            parts.push(`F${f.path}:${f.type}:${f.retryCount}:${f.timestamp}`);
        }
        const busy = s.isSyncing || this.plugin.activeTransfers.size > 0 || queued > 0;
        if (busy) parts.push(`t${Math.floor(Date.now() / 1000)}`);
        return parts.join('\n');
    }

    refresh() {
        const signature = this.stateSignature();
        if (signature === this.lastSignature) return;
        this.lastSignature = signature;

        this.container.empty();
        const hasActive = this.plugin.activeTransfers.size > 0;
        const hasFailed = this.plugin.failedSyncs.length > 0;
        const isSyncing = this.plugin.syncState.isSyncing;

        if (!hasActive && !hasFailed && !isSyncing) {
            const queued = this.plugin.queueManager.getQueueSize() + this.plugin.queueManager.getActiveTransfers();
            if (queued > 0) {
                this.container.createEl('p', {
                    text: queued === 1
                        ? 'Waiting to send 1 recent change…'
                        : `Waiting to send ${queued} recent changes…`,
                });
                this.container.createEl('p', {
                    text: 'File-by-file progress appears here once a transfer starts.',
                    cls: 'od-text-muted',
                });
                return;
            }
            this.container.createEl('p', { text: 'Nothing is syncing right now.' });
            this.container.createEl('p', {
                text: 'When notes move between devices, progress shows up here. Pair a device first, or run a full sync if one is already connected.',
                cls: 'od-text-muted',
            });
            new Setting(this.container).addButton(btn => btn.setButtonText('Connect devices').setCta().onClick(() => {
                this.close();
                new ConnectionModal(this.app, this.plugin).open();
            }));
            if (this.plugin.connections.size > 0) {
                new Setting(this.container).addButton(btn => btn.setButtonText('Force full sync').onClick(() => {
                    this.close();
                    new SelectPeerModal(this.app, this.plugin, (peerId) => this.plugin.requestFullSyncFromPeer(peerId)).open();
                }));
            }
            return;
        }

        if (isSyncing) {
            this.container.createEl('h4', { text: 'Full Sync Progress', attr: { style: 'margin-top: 0;' } });
            const item = this.container.createDiv({ cls: 'od-transfer-item' });
            item.createDiv({ text: describeSyncPhase(this.plugin.syncState.currentPhase), cls: 'od-phase-label' });
            
            if (this.plugin.syncState.filesTotal > 0) {
                item.createEl('progress', { attr: { value: this.plugin.syncState.filesTransferred, max: this.plugin.syncState.filesTotal } });
                const meta = item.createDiv({ cls: 'od-transfer-meta' });
                meta.createSpan({ text: `${this.plugin.syncState.filesTransferred} / ${this.plugin.syncState.filesTotal} files` });
                meta.createSpan({ text: `${formatBytes(this.plugin.syncState.bytesTransferred)} / ${formatBytes(this.plugin.syncState.bytesTotal)}` });
                
                const elapsedSeconds = (Date.now() - (this.plugin.syncState.syncStartTime || Date.now())) / 1000;
                const speedBytesPerSec = elapsedSeconds > 0 ? this.plugin.syncState.bytesTransferred / elapsedSeconds : 0;
                meta.createSpan({ text: `${formatBytes(speedBytesPerSec)}/s` });

                if (this.plugin.syncState.currentFile) {
                    const currentFileMeta = item.createDiv({ cls: 'od-transfer-meta', attr: { style: 'margin-top: 5px; color: var(--text-muted); font-size: 0.85em;' } });
                    currentFileMeta.createSpan({ text: `Syncing: ${this.plugin.syncState.currentFile}` });
                    if (this.plugin.syncState.currentFileSize != null) {
                        currentFileMeta.createSpan({ text: ` (${formatBytes(this.plugin.syncState.currentFileSize)})` });
                    }
                }
            } else {
                item.createDiv({ text: 'Analyzing differences...', cls: 'od-transfer-meta' });
            }
        }

        if (hasActive) {
            if (hasFailed || isSyncing) this.container.createEl('h4', { text: 'Active Data Transfers', attr: { style: 'margin-top: 20px;' } });
            this.plugin.activeTransfers.forEach(transfer => {
                const item = this.container.createDiv({ cls: 'od-transfer-item' });
                const title = item.createDiv({ cls: 'od-transfer-title', attr: { style: 'display: flex; align-items: center; margin-bottom: 4px;' } });
                
                const iconSpan = title.createSpan({ cls: 'od-transfer-icon' });
                setIcon(iconSpan, transfer.direction === 'upload' ? 'arrow-up-circle' : 'arrow-down-circle');
                iconSpan.style.marginRight = '6px';
                iconSpan.style.color = transfer.direction === 'upload' ? 'var(--text-success)' : 'var(--interactive-accent)';
                
                title.createSpan({ text: transfer.path, attr: { style: 'font-weight: 600;' } });
                if (transfer.status === 'paused') title.createSpan({ text: ' (Paused)', attr: { style: 'color: var(--text-muted); font-size: 0.8em; margin-left: 6px;' } });
                
                item.createEl('progress', { attr: { value: transfer.processedChunks, max: transfer.totalChunks } });

                const now = Date.now();
                const elapsedSeconds = (now - transfer.startTime) / 1000;
                const chunkSize = transfer.chunkSize || this.plugin.getChunkSize();
                const processedBytes = transfer.processedChunks * chunkSize;
                const totalBytes = transfer.totalChunks * chunkSize;
                const speedBytesPerSec = elapsedSeconds > 0 ? processedBytes / elapsedSeconds : 0;
                const remainingBytes = totalBytes - processedBytes;
                const remainingSeconds = speedBytesPerSec > 0 && Number.isFinite(speedBytesPerSec) ? remainingBytes / speedBytesPerSec : 0;

                const meta = item.createDiv({ cls: 'od-transfer-meta' });
                meta.createSpan({ text: `${formatBytes(speedBytesPerSec)}/s` });
                
                const remText = remainingSeconds > 0 && Number.isFinite(remainingSeconds) ? `${Math.round(remainingSeconds)}s remaining` : 'Unknown time remaining';
                meta.createSpan({ text: remText });
                
                const pct = transfer.totalChunks > 0 ? (transfer.processedChunks / transfer.totalChunks) * 100 : 0;
                meta.createSpan({ text: `${Math.round(pct)}%` });
            });
        }

        if (hasFailed) {
            this.container.createEl('h4', { text: 'Pending Retries', attr: { style: hasActive ? 'margin-top: 20px;' : 'margin-top: 0;' } });
            this.plugin.failedSyncs.forEach(fail => {
                const item = this.container.createDiv({ cls: 'od-transfer-item' });
                const title = item.createDiv({ cls: 'od-transfer-title', attr: { style: 'display: flex; align-items: center; margin-bottom: 4px;' } });
                
                const iconSpan = title.createSpan({ cls: 'od-transfer-icon' });
                setIcon(iconSpan, fail.type === 'file-delete' ? 'trash-2' : 'alert-circle');
                iconSpan.style.marginRight = '6px';
                iconSpan.style.color = 'var(--text-error)';
                title.createSpan({ text: fail.path, attr: { style: 'font-weight: 600;' } });

                const meta = item.createDiv({ cls: 'od-transfer-meta' });
                const peerName = fail.peerId ? (this.plugin.clusterPeers.get(fail.peerId)?.friendlyName || fail.peerId) : 'Broadcast';
                meta.createSpan({ text: `To: ${peerName}` });
                
                const secondsAgo = Math.round((Date.now() - fail.timestamp) / 1000);
                meta.createSpan({ text: `Failed ${secondsAgo}s ago (Attempt ${fail.retryCount || 0})` });

                if (fail.reason) {
                    const reasonMeta = item.createDiv({ cls: 'od-transfer-meta' });
                    reasonMeta.createSpan({ text: `Error: ${fail.reason}`, attr: { style: 'color: var(--text-error);' } });
                }
            });
        }
    }
}
