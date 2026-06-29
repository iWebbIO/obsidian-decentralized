const fs = require('fs');
const Module = require('module');
const path = require('path');

// Mock 'obsidian' module
let obsidianMock = null;
const originalRequire = Module.prototype.require;
Module.prototype.require = function(request) {
    if (request === 'obsidian') {
        if (!obsidianMock) {
            obsidianMock = {
                Plugin: class Plugin {},
                Notice: class Notice {
                    constructor(message, duration) {
                        this.message = message;
                        Notice.lastMessage = message;
                    }
                },
                SettingTab: class SettingTab {
                    constructor(app, plugin) {
                        this.app = app;
                        this.plugin = plugin;
                    }
                },
                PluginSettingTab: class PluginSettingTab {
                    constructor(app, plugin) {
                        this.app = app;
                        this.plugin = plugin;
                    }
                },
                Modal: class Modal {
                    constructor(app) {
                        this.contentEl = {
                            addClass: () => {},
                            empty: () => {},
                            createDiv: (options) => {
                                const div = {
                                    addClass: () => {},
                                    removeClass: () => {},
                                    createSpan: (opts) => ({ addClass: () => {}, createSpan: () => ({}) }),
                                    createEl: (tag, opts) => ({ onclick: null, value: '' }),
                                    createDiv: (opts) => ({ createSpan: () => ({}) }),
                                    empty: () => {}
                                };
                                return div;
                            },
                            createEl: (tag, options) => {
                                return {
                                    onclick: null,
                                    value: '',
                                    style: {},
                                    appendChild: () => {},
                                    setText: () => {},
                                    focus: () => {}
                                };
                            }
                        };
                    }
                },
                App: class App {},
                Setting: class Setting {
                    constructor(containerEl) {
                        this.nameEl = { empty: () => {}, createDiv: () => ({ createSpan: () => ({}) }) };
                        this.descEl = { textContent: '' };
                    }
                    setName(name) {
                        this.currentSettingName = name;
                        return this;
                    }
                    setDesc() { return this; }
                    addButton(callback) {
                        const btn = { setButtonText: () => btn, setCta: () => btn, setWarning: () => btn, onClick: (cb) => { btn.click = cb; return btn; } };
                        callback(btn);
                        return this;
                    }
                    addToggle(callback) {
                        const toggle = { setValue: () => toggle, onChange: (cb) => { toggle.change = cb; return toggle; } };
                        callback(toggle);
                        return this;
                    }
                    addDropdown(callback) {
                        const dd = { addOption: () => dd, setValue: () => dd, onChange: (cb) => { dd.change = cb; return dd; } };
                        callback(dd);
                        return this;
                    }
                    addText(callback) {
                        const text = {
                            setValue: () => text,
                            setPlaceholder: () => text,
                            onChange: (cb) => {
                                Setting.capturedCallbacks[this.currentSettingName] = cb;
                                return text;
                            }
                        };
                        callback(text);
                        return this;
                    }
                    addTextArea(callback) {
                        const ta = { setValue: () => ta, setPlaceholder: () => ta, onChange: (cb) => { Setting.capturedCallbacks[this.currentSettingName] = cb; return ta; } };
                        callback(ta);
                        return this;
                    }
                    addExtraButton(callback) {
                        const btn = { setIcon: () => btn, setTooltip: () => btn, onClick: (cb) => { btn.click = cb; return btn; } };
                        callback(btn);
                        return this;
                    }
                },
                TFile: class TFile {},
                setIcon: () => {},
                debounce: () => {},
                Platform: { isMobile: false }
            };
            obsidianMock.Setting.capturedCallbacks = {};
        }
        return obsidianMock;
    }
    return originalRequire.apply(this, arguments);
};

// Global window mock
global.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn, delay) => setTimeout(fn, delay),
    clearTimeout: (id) => clearTimeout(id),
    btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
    atob: (b64) => {
        const cleaned = b64.replace(/\s/g, '');
        if (/[^A-Za-z0-9\+\/\=]/.test(cleaned)) {
            throw new Error("Invalid base64 characters");
        }
        return Buffer.from(cleaned, 'base64').toString('binary');
    }
};

global.navigator = {
    clipboard: {
        writeText: async (text) => {
            global.navigator.clipboard.lastWritten = text;
        }
    }
};

const obsidian = require('obsidian');
obsidian.Setting.capturedCallbacks = {};

function assert(condition, message) {
    if (!condition) {
        throw new Error(message || "Assertion failed");
    }
}
function assertEquals(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message || "Assertion failed"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

// Start Running Tests
async function runTests() {
    try {
        const ui = require('./dist-test/ui.js');
        const modal = new ui.ConnectionModal(null, null);

        // 1. formatPairingCodeForDisplay
        console.log("Running formatPairingCodeForDisplay tests...");
        assertEquals(modal.formatPairingCodeForDisplay('device-abcdef12'), 'device-abcd-ef12');
        assertEquals(modal.formatPairingCodeForDisplay(''), '');
        assertEquals(modal.formatPairingCodeForDisplay('other-id'), 'other-id');

        // 2. normalizePairingCodeInput
        console.log("Running normalizePairingCodeInput tests...");
        assertEquals(modal.normalizePairingCodeInput('device-abcdef12'), 'device-abcdef12');
        assertEquals(modal.normalizePairingCodeInput('device-abcd-ef12'), 'device-abcdef12');
        assertEquals(modal.normalizePairingCodeInput('abcdef12'), 'device-abcdef12');
        assertEquals(modal.normalizePairingCodeInput('ABCDEF12'), 'device-abcdef12');
        assertEquals(modal.normalizePairingCodeInput('  device-abcd-ef12  '), 'device-abcdef12');
        assertEquals(modal.normalizePairingCodeInput('random-id'), 'random-id');

        // 3. formatBytes
        console.log("Running formatBytes tests...");
        assertEquals(ui.formatBytes(0), '0 Bytes');
        assertEquals(ui.formatBytes(-5), '0 Bytes');
        assertEquals(ui.formatBytes(1023), '1023 Bytes');
        assertEquals(ui.formatBytes(1024), '1 KB');
        assertEquals(ui.formatBytes(1048576), '1 MB');
        assertEquals(ui.formatBytes(10737418240), '10 GB');

        // 4. utils.ts structured error handling & roundtrips
        console.log("Running utils.ts error handling tests...");
        const utils = require('./dist-test/utils.js');
        const types = require('./dist-test/types.js');
        
        // Corrupt or truncated TLV input should throw a categorized SyncError (PROTOCOL_ERROR)
        try {
            const corruptBuffer = new ArrayBuffer(5);
            utils.unpackTLVToFiles(corruptBuffer);
            assert(false, "Expected unpackTLVToFiles to throw on corrupt buffer");
        } catch (err) {
            assert(err.name === 'SyncError', "Expected SyncError");
            assertEquals(err.category, types.SyncErrorCategory.PROTOCOL_ERROR, "Expected PROTOCOL_ERROR");
        }

        // Invalid base64 input should throw a categorized SyncError (INTEGRITY_ERROR)
        try {
            utils.base64ToArrayBuffer('!!!not-base64!!!');
            assert(false, "Expected base64ToArrayBuffer to throw on invalid input");
        } catch (err) {
            assert(err.name === 'SyncError', "Expected SyncError");
            assertEquals(err.category, types.SyncErrorCategory.INTEGRITY_ERROR, "Expected INTEGRITY_ERROR");
        }

        // Round-trip correctness: compress → decompress
        const originalText = "Hello, world! This is a test of compression.";
        const compressed = utils.compressText(originalText);
        const decompressed = utils.decompressText(compressed);
        assertEquals(decompressed, originalText, "Compression round-trip failed");

        // Round-trip correctness: pack → unpack
        const files = [
            {
                path: 'test.md',
                mtime: 123456789,
                isCompressed: false,
                encoding: 'utf8',
                content: new TextEncoder().encode("Hello world content")
            }
        ];
        const packed = utils.packFilesToTLV(files);
        const unpacked = utils.unpackTLVToFiles(packed);
        assertEquals(unpacked.length, 1);
        assertEquals(unpacked[0].path, 'test.md');
        assertEquals(unpacked[0].mtime, 123456789);
        assertEquals(new TextDecoder().decode(unpacked[0].content), "Hello world content");

        // 5. Settings clamping tests
        console.log("Running settings clamping tests...");
        const mockPlugin = {
            settings: Object.assign(JSON.parse(JSON.stringify(types.DEFAULT_SETTINGS)), {
                friendlyName: 'Device A'
            }),
            saveSettings: async () => {},
            updateDebounceDelay: () => {}
        };

        const settingsTabModule = require('./dist-test/settings-tab.js');
        const tab = new settingsTabModule.ObsidianDecentralizedSettingTab(null, mockPlugin);

        // Render advanced settings to register text input callbacks
        tab.displayAdvancedSettings({ createEl: () => ({}) });
        
        // Render custom server port settings (by setting useCustomPeerServer to true)
        mockPlugin.settings.useCustomPeerServer = true;
        tab.displayManualSettings({ createEl: () => ({}) });

        // Test Delta Sync Threshold clamping
        const deltaCallback = obsidian.Setting.capturedCallbacks["Delta Sync Threshold (%)"];
        assert(!!deltaCallback, "Delta Sync Threshold callback not found");
        
        await deltaCallback("150");
        assertEquals(mockPlugin.settings.deltaSyncThreshold, 100, "Delta Sync Threshold failed to clamp to max 100");
        await deltaCallback("-5");
        assertEquals(mockPlugin.settings.deltaSyncThreshold, 0, "Delta Sync Threshold failed to clamp to min 0");
        await deltaCallback("abc");
        assertEquals(mockPlugin.settings.deltaSyncThreshold, 50, "Delta Sync Threshold failed to revert to default 50 on invalid input");

        // Test Tombstone Retention clamping
        const tombstoneCallback = obsidian.Setting.capturedCallbacks["Tombstone Retention (Days)"];
        assert(!!tombstoneCallback, "Tombstone Retention callback not found");
        
        await tombstoneCallback("-10");
        assertEquals(mockPlugin.settings.tombstoneRetentionDays, 0, "Tombstone Retention failed to clamp to min 0");
        await tombstoneCallback("5000");
        assertEquals(mockPlugin.settings.tombstoneRetentionDays, 3650, "Tombstone Retention failed to clamp to max 3650");
        await tombstoneCallback("abc");
        assertEquals(mockPlugin.settings.tombstoneRetentionDays, 30, "Tombstone Retention failed to revert to default 30 on invalid input");

        // Test Debounce Delay clamping
        const debounceCallback = obsidian.Setting.capturedCallbacks["Debounce Delay (ms)"];
        assert(!!debounceCallback, "Debounce Delay callback not found");
        
        await debounceCallback("100");
        assertEquals(mockPlugin.settings.debounceDelay, 250, "Debounce Delay failed to enforce min 250");
        await debounceCallback("abc");
        assertEquals(mockPlugin.settings.debounceDelay, 2000, "Debounce Delay failed to revert to default 2000 on invalid input");

        // Test Idle Timeout clamping
        const idleCallback = obsidian.Setting.capturedCallbacks["Idle Timeout (ms)"];
        assert(!!idleCallback, "Idle Timeout callback not found");
        
        await idleCallback("1000");
        assertEquals(mockPlugin.settings.idleTimeoutMs, 5000, "Idle Timeout failed to clamp to min 5000");
        await idleCallback("900000");
        assertEquals(mockPlugin.settings.idleTimeoutMs, 600000, "Idle Timeout failed to clamp to max 600000");
        await idleCallback("abc");
        assertEquals(mockPlugin.settings.idleTimeoutMs, 30000, "Idle Timeout failed to revert to default 30000 on invalid input");

        // Test Custom Port clamping
        const portCallback = obsidian.Setting.capturedCallbacks["Port"];
        assert(!!portCallback, "Port callback not found");
        
        await portCallback("0");
        assertEquals(mockPlugin.settings.customPeerServerConfig.port, 1, "Port failed to clamp to min 1");
        await portCallback("70000");
        assertEquals(mockPlugin.settings.customPeerServerConfig.port, 65535, "Port failed to clamp to max 65535");
        await portCallback("abc");
        assertEquals(mockPlugin.settings.customPeerServerConfig.port, 9000, "Port failed to revert to default 9000 on invalid input");

        // Test Device Friendly Name validation
        console.log("Running friendly name validation tests...");
        let savedName = null;
        let clickCallback = null;
        let submitCallback = null;
        let inputElement = null;

        const mockContainer = {
            empty: () => {},
            createDiv: (opts) => {
                const wrapper = {
                    createSpan: (spanOpts) => {
                        const span = {};
                        if (spanOpts && spanOpts.cls === 'od-editable-name-submit') {
                            submitCallback = (e) => { span.onclick(e); };
                        }
                        return span;
                    },
                    removeClass: () => {},
                    addClass: () => {},
                    empty: () => {},
                    createEl: (tag, attrs) => {
                        inputElement = {
                            value: '',
                            addClass: () => {},
                            onkeydown: () => {},
                            focus: () => {}
                        };
                        return inputElement;
                    }
                };
                clickCallback = () => { wrapper.onclick({ preventDefault: () => {} }); };
                return wrapper;
            }
        };

        tab.createEditableName(mockContainer, 'Device A', 'Device A', (newName) => {
            savedName = newName;
        });

        // Enter edit mode
        clickCallback();

        // Test case 1: valid input
        inputElement.value = '   New Friendly Name   ';
        submitCallback({ stopPropagation: () => {} });
        assertEquals(savedName, 'New Friendly Name');

        // Test case 2: empty input
        savedName = null;
        obsidian.Notice.lastMessage = null;
        inputElement.value = '   ';
        submitCallback({ stopPropagation: () => {} });
        assert(savedName === null, "Empty name should not be saved");
        assertEquals(obsidian.Notice.lastMessage, "Name cannot be empty.");

        // Test case 3: too long input (> 64 chars)
        savedName = null;
        obsidian.Notice.lastMessage = null;
        inputElement.value = 'a'.repeat(65);
        submitCallback({ stopPropagation: () => {} });
        assert(savedName === null, "Too long name should not be saved");
        assertEquals(obsidian.Notice.lastMessage, "Name cannot exceed 64 characters.");

        // 6. UI guard test (activePsk absent)
        console.log("Running UI guard tests...");
        obsidian.Notice.lastMessage = null;
        
        const mockPluginForUI = {
            getMyPeerInfo: () => ({ deviceId: 'device-12345678' }),
            generatePSK: async () => null,
            settings: {
                directIpHostAddress: '192.168.1.100',
                directIpHostPort: 41235
            }
        };
        
        const uiModal = new ui.ConnectionModal(null, mockPluginForUI);
        uiModal.activePsk = null;
        
        const contentEl = {
            empty: () => {},
            createEl: () => ({}),
            createDiv: (opts) => {
                if (opts && opts.text && opts.text.includes('Pairing is blocked')) {
                    contentEl.blockedTextRendered = true;
                }
                return {
                    createDiv: () => ({}),
                    createEl: () => ({})
                };
            }
        };
        uiModal.contentEl = contentEl;
        
        uiModal.renderQuickPairTab();
        
        assert(contentEl.blockedTextRendered === true, "Expected pairing blocked message to be rendered");
        assertEquals(obsidian.Notice.lastMessage, "Pairing blocked: Encryption key (PSK) is missing or not generated.");

        console.log("ALL TESTS COMPLETED SUCCESSFULLY!");
    } catch (e) {
        console.error("Test execution failed:", e);
        process.exit(1);
    }
}

runTests();
