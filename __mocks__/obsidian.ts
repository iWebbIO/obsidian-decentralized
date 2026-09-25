/**
 * Jest stand-in for the `obsidian` module, which only exists inside the Obsidian app.
 *
 * It is deliberately small but behaviour-faithful where the plugin depends on behaviour:
 * Component/Plugin lifecycles (registered events and intervals are released on unload),
 * Modal.open() running onOpen(), Setting components that keep their click handlers, and a
 * DOM-free element that supports the helpers Obsidian adds to HTMLElement (createDiv,
 * setText, addClass, ...). Tests reach these through `jest.requireMock('obsidian')` or the
 * helpers in tests/helpers, never by importing this file directly, so there is one copy of
 * each class and `instanceof TFile` keeps working inside the plugin.
 */

type ElementOptions = {
    cls?: string | string[];
    text?: string;
    attr?: Record<string, string | number | boolean | null>;
    type?: string;
    placeholder?: string;
    value?: string;
    title?: string;
    href?: string;
};

type Listener = (...args: any[]) => any;

/** Minimal element with Obsidian's HTMLElement helpers. */
export class FakeElement {
    tagName: string;
    children: FakeElement[] = [];
    parentElement: FakeElement | null = null;
    style: Record<string, string> = {};
    attrs: Record<string, string> = {};
    value = '';
    disabled = false;
    src = '';
    onclick: Listener | null = null;
    onkeydown: Listener | null = null;
    private ownText = '';
    private classes = new Set<string>();
    private listeners = new Map<string, Listener[]>();
    private detached = false;

    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
    }

    // --- tree ---------------------------------------------------------------

    createEl(tag: string, opts?: ElementOptions | string, callback?: (el: FakeElement) => void): FakeElement {
        const el = new FakeElement(tag);
        el.applyOptions(typeof opts === 'string' ? { cls: opts } : opts);
        this.appendChild(el);
        callback?.(el);
        return el;
    }
    createDiv(opts?: ElementOptions | string, callback?: (el: FakeElement) => void): FakeElement {
        return this.createEl('div', opts, callback);
    }
    createSpan(opts?: ElementOptions | string, callback?: (el: FakeElement) => void): FakeElement {
        return this.createEl('span', opts, callback);
    }
    appendChild<T extends FakeElement>(child: T): T {
        child.remove();
        child.parentElement = this;
        child.detached = false;
        this.children.push(child);
        return child;
    }
    remove() {
        if (!this.parentElement) return;
        const siblings = this.parentElement.children;
        const i = siblings.indexOf(this);
        if (i >= 0) siblings.splice(i, 1);
        this.parentElement = null;
        this.detached = true;
    }
    empty() {
        for (const child of [...this.children]) child.remove();
        this.ownText = '';
    }
    get isConnected(): boolean {
        let el: FakeElement | null = this;
        while (el) {
            if (el.detached) return false;
            el = el.parentElement;
        }
        return true;
    }

    // --- text ---------------------------------------------------------------

    setText(text: string) {
        this.empty();
        this.ownText = String(text);
    }
    get textContent(): string {
        return this.ownText + this.children.map(c => c.textContent).join('');
    }
    set textContent(text: string) { this.setText(text); }
    get innerText(): string { return this.textContent; }
    set innerText(text: string) { this.setText(text); }

    // --- classes & attributes -----------------------------------------------

    get className(): string { return [...this.classes].join(' '); }
    set className(value: string) {
        this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
    }
    readonly classList = {
        add: (...cls: string[]) => this.addClass(...cls),
        remove: (...cls: string[]) => this.removeClass(...cls),
        contains: (cls: string) => this.classes.has(cls),
        toggle: (cls: string, force?: boolean) => this.toggleClass(cls, force ?? !this.classes.has(cls)),
    };
    addClass(...cls: string[]) {
        for (const c of cls.flatMap(x => String(x).split(/\s+/)).filter(Boolean)) this.classes.add(c);
    }
    removeClass(...cls: string[]) {
        for (const c of cls) this.classes.delete(c);
    }
    toggleClass(cls: string, value: boolean) {
        if (value) this.classes.add(cls);
        else this.classes.delete(cls);
    }
    hasClass(cls: string) { return this.classes.has(cls); }
    setAttr(name: string, value: string | number | boolean | null) {
        if (value === null) delete this.attrs[name];
        else this.attrs[name] = String(value);
    }
    setAttribute(name: string, value: string) { this.setAttr(name, value); }
    getAttr(name: string): string | null { return this.attrs[name] ?? null; }
    getAttribute(name: string): string | null { return this.getAttr(name); }
    removeAttribute(name: string) { delete this.attrs[name]; }
    show() { delete this.style.display; }
    hide() { this.style.display = 'none'; }

    // --- events -------------------------------------------------------------

    addEventListener(type: string, listener: Listener) {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
    }
    removeEventListener(type: string, listener: Listener) {
        const list = this.listeners.get(type);
        if (list) this.listeners.set(type, list.filter(l => l !== listener));
    }
    /** Fire `type` at this element (tests only). */
    trigger(type: string, event: any = {}) {
        if (type === 'click') this.onclick?.(event);
        if (type === 'keydown') this.onkeydown?.(event);
        for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    click() { this.trigger('click', { preventDefault() { }, stopPropagation() { } }); }
    focus() { }
    blur() { }

    // --- queries ------------------------------------------------------------

    private matches(selector: string): boolean {
        if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
        if (selector.startsWith('#')) return this.attrs.id === selector.slice(1);
        return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector: string): FakeElement[] {
        const out: FakeElement[] = [];
        const walk = (el: FakeElement) => {
            for (const child of el.children) {
                if (child.matches(selector)) out.push(child);
                walk(child);
            }
        };
        walk(this);
        return out;
    }
    querySelector(selector: string): FakeElement | null {
        return this.querySelectorAll(selector)[0] ?? null;
    }
    /** First descendant (or self) whose own text equals `text` (tests only). */
    findByText(text: string): FakeElement | null {
        if (this.ownText === text) return this;
        for (const child of this.children) {
            const hit = child.findByText(text);
            if (hit) return hit;
        }
        return null;
    }

    private applyOptions(opts?: ElementOptions) {
        if (!opts) return;
        if (opts.cls) this.addClass(...(Array.isArray(opts.cls) ? opts.cls : [opts.cls]));
        if (opts.text !== undefined) this.ownText = String(opts.text);
        if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) this.setAttr(k, v);
        if (opts.type) this.setAttr('type', opts.type);
        if (opts.placeholder) this.setAttr('placeholder', opts.placeholder);
        if (opts.title) this.setAttr('title', opts.title);
        if (opts.href) this.setAttr('href', opts.href);
        if (opts.value !== undefined) this.value = opts.value;
    }
}

// --- Notices ----------------------------------------------------------------

export class Notice {
    /** Every notice shown, in order (tests only). */
    static messages: string[] = [];
    static clear() { Notice.messages = []; }
    noticeEl = new FakeElement('div');
    constructor(message: string | any, _timeout?: number) {
        Notice.messages.push(String(message));
    }
    setMessage(message: string) {
        Notice.messages.push(String(message));
        return this;
    }
    hide() { }
}

export class Platform {
    static isMobile = false;
    static isDesktop = true;
    static isDesktopApp = true;
    static isMobileApp = false;
    static isIosApp = false;
    static isAndroidApp = false;
}

export function setIcon(el: any, icon: string) {
    el?.setAttr?.('data-icon', icon);
}

export function normalizePath(path: string): string {
    const cleaned = String(path).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    return cleaned === '' ? '/' : cleaned;
}

/** Obsidian's debounce: fires `timeout` ms after the first call; later calls only update args. */
export function debounce<T extends unknown[]>(cb: (...args: T) => any, timeout = 0, resetTimer = false) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastArgs: T;
    const fire = () => {
        timer = null;
        cb(...lastArgs);
    };
    const debounced: any = (...args: T) => {
        lastArgs = args;
        if (timer !== null) {
            if (!resetTimer) return debounced;
            clearTimeout(timer);
        }
        timer = setTimeout(fire, timeout);
        return debounced;
    };
    debounced.cancel = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        return debounced;
    };
    debounced.run = () => {
        if (timer === null) return;
        clearTimeout(timer);
        fire();
    };
    return debounced;
}

// --- Files --------------------------------------------------------------------

function splitName(path: string) {
    const name = path.split('/').pop() || path;
    const dot = name.lastIndexOf('.');
    return {
        name,
        basename: dot > 0 ? name.slice(0, dot) : name,
        extension: dot > 0 ? name.slice(dot + 1) : '',
    };
}

export abstract class TAbstractFile {
    vault: any;
    path = '';
    name = '';
    parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
    basename = '';
    extension = '';
    stat: { ctime: number; mtime: number; size: number };
    constructor(path?: string) {
        super();
        const now = Date.now();
        this.stat = { ctime: now, mtime: now, size: 0 };
        if (path !== undefined) this.setPath(path);
    }
    /** Re-derive name/basename/extension after a move (tests and FakeVault only). */
    setPath(path: string) {
        this.path = path;
        const parts = splitName(path);
        this.name = parts.name;
        this.basename = parts.basename;
        this.extension = parts.extension;
    }
}

export class TFolder extends TAbstractFile {
    children: TAbstractFile[] = [];
    constructor(path?: string) {
        super();
        if (path !== undefined) this.setPath(path);
    }
    setPath(path: string) {
        this.path = path;
        this.name = path === '/' ? '' : (path.split('/').pop() || path);
    }
    isRoot(): boolean {
        return this.path === '/';
    }
}

// --- Components & plugins -------------------------------------------------------

export class Component {
    _loaded = false;
    private _cleanups: Array<() => void> = [];
    private _intervals: number[] = [];

    load() {
        this._loaded = true;
        return this.onload();
    }
    onload(): any { }
    unload() {
        this._loaded = false;
        this.onunload();
        for (const id of this._intervals) clearInterval(id as any);
        this._intervals = [];
        const cleanups = this._cleanups;
        this._cleanups = [];
        for (const cleanup of cleanups) cleanup();
    }
    onunload(): any { }
    register(cb: () => any) {
        this._cleanups.push(cb);
    }
    registerEvent(ref: { off?: () => void } | any) {
        this._cleanups.push(() => ref?.off?.());
    }
    registerInterval(id: number): number {
        this._intervals.push(id);
        return id;
    }
    registerDomEvent(el: any, type: string, cb: Listener) {
        el.addEventListener(type, cb);
        this._cleanups.push(() => el.removeEventListener(type, cb));
    }
    /** Intervals still registered (tests only). */
    get registeredIntervalCount(): number {
        return this._intervals.length;
    }
}

export class Plugin extends Component {
    app: any;
    manifest: any;
    /** Backing store for loadData/saveData (tests only). */
    _data: any = null;
    _statusBarItems: FakeElement[] = [];
    _ribbonIcons: Array<{ icon: string; title: string; callback: Listener; el: FakeElement }> = [];
    _commands: any[] = [];
    _settingTabs: any[] = [];

    constructor(app: any, manifest: any) {
        super();
        this.app = app;
        this.manifest = manifest;
    }
    addStatusBarItem(): FakeElement {
        const el = new FakeElement('div');
        this._statusBarItems.push(el);
        return el;
    }
    addRibbonIcon(icon: string, title: string, callback: Listener): FakeElement {
        const el = new FakeElement('div');
        el.onclick = callback;
        this._ribbonIcons.push({ icon, title, callback, el });
        return el;
    }
    addCommand(command: any) {
        this._commands.push(command);
        return command;
    }
    addSettingTab(tab: any) {
        this._settingTabs.push(tab);
    }
    async loadData(): Promise<any> {
        return this._data == null ? null : structuredClone(this._data);
    }
    async saveData(data: any): Promise<void> {
        this._data = structuredClone(data);
    }
}

// --- Views, modals, settings ------------------------------------------------------

export class MarkdownView { }

export class Modal {
    /** Modals currently open, oldest first (tests only). */
    static openModals: Modal[] = [];
    app: any;
    containerEl = new FakeElement('div');
    modalEl = new FakeElement('div');
    titleEl = new FakeElement('div');
    contentEl = new FakeElement('div');
    isOpen = false;
    constructor(app: any) {
        this.app = app;
    }
    open() {
        this.isOpen = true;
        Modal.openModals.push(this);
        return this.onOpen();
    }
    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        Modal.openModals = Modal.openModals.filter(m => m !== this);
        this.onClose();
    }
    onOpen(): any { }
    onClose(): any { }
    setTitle(title: string) {
        this.titleEl.setText(title);
        return this;
    }
}

export class PluginSettingTab {
    app: any;
    plugin: any;
    containerEl = new FakeElement('div');
    constructor(app: any, plugin: any) {
        this.app = app;
        this.plugin = plugin;
    }
    display(): any { }
    hide(): any { }
}

abstract class ValueComponent<T> {
    protected value: T;
    protected changeHandler: ((value: T) => any) | null = null;
    constructor(initial: T) {
        this.value = initial;
    }
    getValue(): T { return this.value; }
    setValue(value: T) {
        this.value = value;
        return this;
    }
    onChange(handler: (value: T) => any) {
        this.changeHandler = handler;
        return this;
    }
    /** Simulate the user changing the value (tests only). */
    async change(value: T) {
        this.value = value;
        await this.changeHandler?.(value);
    }
    setDisabled(_disabled: boolean) { return this; }
    setPlaceholder(_text: string) { return this; }
    setTooltip(_text: string) { return this; }
}

export class ButtonComponent {
    buttonEl: FakeElement;
    constructor(containerEl: FakeElement) {
        this.buttonEl = containerEl.createEl('button');
    }
    setButtonText(text: string) {
        this.buttonEl.setText(text);
        return this;
    }
    setCta() { this.buttonEl.addClass('mod-cta'); return this; }
    setWarning() { this.buttonEl.addClass('mod-warning'); return this; }
    setTooltip(tooltip: string) { this.buttonEl.setAttr('aria-label', tooltip); return this; }
    setIcon(icon: string) { this.buttonEl.setAttr('data-icon', icon); return this; }
    setDisabled(disabled: boolean) { this.buttonEl.disabled = disabled; return this; }
    setClass(cls: string) { this.buttonEl.addClass(cls); return this; }
    onClick(handler: Listener) {
        this.buttonEl.onclick = handler;
        return this;
    }
}

export class ExtraButtonComponent extends ButtonComponent { }

export class ToggleComponent extends ValueComponent<boolean> {
    constructor() { super(false); }
}
export class TextComponent extends ValueComponent<string> {
    inputEl = new FakeElement('input');
    constructor() { super(''); }
}
export class TextAreaComponent extends TextComponent { }
export class DropdownComponent extends ValueComponent<string> {
    options: Record<string, string> = {};
    constructor() { super(''); }
    addOption(value: string, display: string) {
        this.options[value] = display;
        return this;
    }
    addOptions(options: Record<string, string>) {
        Object.assign(this.options, options);
        return this;
    }
}

export class Setting {
    settingEl: FakeElement;
    infoEl: FakeElement;
    nameEl: FakeElement;
    descEl: FakeElement;
    controlEl: FakeElement;
    /** Every component added, in order (tests only). */
    components: any[] = [];

    constructor(containerEl: FakeElement) {
        this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
        this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
        this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' });
        this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' });
        this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
    }
    setName(name: string) { this.nameEl.setText(name); return this; }
    setDesc(desc: string) { this.descEl.setText(desc); return this; }
    setClass(cls: string) { this.settingEl.addClass(cls); return this; }
    setHeading() { return this; }
    setDisabled(_disabled: boolean) { return this; }
    private add<C>(component: C, cb?: (c: C) => any) {
        this.components.push(component);
        cb?.(component);
        return this;
    }
    addButton(cb?: (b: ButtonComponent) => any) { return this.add(new ButtonComponent(this.controlEl), cb); }
    addExtraButton(cb?: (b: ExtraButtonComponent) => any) { return this.add(new ExtraButtonComponent(this.controlEl), cb); }
    addToggle(cb?: (t: ToggleComponent) => any) { return this.add(new ToggleComponent(), cb); }
    addText(cb?: (t: TextComponent) => any) { return this.add(new TextComponent(), cb); }
    addTextArea(cb?: (t: TextAreaComponent) => any) { return this.add(new TextAreaComponent(), cb); }
    addDropdown(cb?: (d: DropdownComponent) => any) { return this.add(new DropdownComponent(), cb); }
}
