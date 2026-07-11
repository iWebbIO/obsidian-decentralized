export class Notice {
    constructor(message: string, timeout?: number) {
        // mock
    }
}

export class Platform {
    static isMobile = false;
    static isDesktop = true;
}

export class TFile {
    name: string;
    path: string;
    extension: string;
    stat: { mtime: number; ctime: number; size: number };
    vault: any;
    parent: any;
    constructor(path: string) {
        this.path = path;
        this.name = path.split('/').pop() || path;
        this.extension = path.split('.').pop() || '';
        this.stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };
    }
}

export class Modal {
    app: any;
    contentEl: any;
    constructor(app: any) {
        this.app = app;
        this.contentEl = {
            empty: jest.fn(),
            addClass: jest.fn(),
            createDiv: jest.fn().mockReturnValue({
                createSpan: jest.fn().mockReturnValue({ addClass: jest.fn() }),
                createEl: jest.fn(),
                createDiv: jest.fn().mockReturnThis(),
                addClass: jest.fn(),
                removeClass: jest.fn(),
                empty: jest.fn(),
                setText: jest.fn()
            }),
            createEl: jest.fn().mockReturnValue({ style: {} })
        };
    }
    open() {}
    close() {}
}

export class Setting {
    constructor(containerEl: any) {}
    setName() { return this; }
    setDesc() { return this; }
    addText() { return this; }
    addToggle() { return this; }
    addDropdown() { return this; }
    addButton() { return this; }
}

export function setIcon(el: any, icon: string) {}
