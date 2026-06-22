const fs = require('fs');
const Module = require('module');

const originalRequire = Module.prototype.require;
Module.prototype.require = function(request) {
    if (request === 'obsidian') {
        return {
            Plugin: class Plugin {},
            Notice: class Notice {},
            SettingTab: class SettingTab {},
            PluginSettingTab: class PluginSettingTab {},
            debounce: () => {},
            Platform: { isMobile: false }
        };
    }
    return originalRequire.apply(this, arguments);
};

try {
    const p = require('./dist/main.js');
    console.log('Plugin loaded successfully in Node.js mock');
} catch(e) {
    console.error('Error loading plugin:', e);
}
