/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import test from "node:test";

import { loadModule } from "./tests/harness";

class Element {
    constructor(public tagName = "DIV", public isContentEditable = false) { }
}

async function fixture() {
    const keyboard = new Set<(event: KeyboardEvent) => void>();
    const devices = new Set<() => void>();
    const modals = new Map<string, () => void>();
    const calls = { closed: 0, opened: 0, reactAccess: 0, storageReads: 0 };
    const neverRender = new Proxy({}, {
        get(_target, property) {
            calls.reactAccess++;
            throw new Error(`Discord React.${String(property)} was accessed before rendering`);
        }
    });
    const settingsStore: Record<string, unknown> = {};
    const module = await loadModule<typeof import("./index")>("index.tsx", {
        "./style.css": {},
        "@api/ChatButtons": {},
        "@components/Button": {},
        "@utils/discord": {},
        "@api/DataStore": {
            get: async () => { calls.storageReads++; return undefined; },
            set: async () => { },
            del: async () => { }
        },
        "@api/Settings": {
            definePluginSettings: (definitions: Record<string, {
                default?: unknown;
                options?: { default?: boolean; value: unknown; }[];
            }>) => {
                for (const [name, definition] of Object.entries(definitions))
                    settingsStore[name] = definition.default ?? definition.options?.find(option => option.default)?.value;
                return { store: settingsStore };
            }
        },
        "@utils/Logger": { Logger: class { error() { } } },
        "@utils/types": {
            __esModule: true,
            default: (plugin: unknown) => plugin,
            makeRange: (start: number, end: number, step: number) => Array.from({ length: (end - start) / step + 1 }, (_, index) => start + index * step),
            OptionType: { BOOLEAN: 3, COMPONENT: 6, NUMBER: 1, SELECT: 4, SLIDER: 5 }
        },
        "@webpack": {},
        "@webpack/common": {
            React: neverRender,
            closeModal: (key: string) => {
                calls.closed++;
                modals.get(key)?.();
                modals.delete(key);
            },
            openModal: (_render: unknown, { onCloseCallback }: { onCloseCallback: () => void; }) => {
                const key = String(++calls.opened);
                modals.set(key, onCloseCallback);
                return key;
            }
        }
    }, {
        document: {
            addEventListener: (_type: string, listener: (event: KeyboardEvent) => void) => keyboard.add(listener),
            removeEventListener: (_type: string, listener: (event: KeyboardEvent) => void) => keyboard.delete(listener)
        },
        HTMLElement: Element,
        HTMLAudioElement: class { setSinkId() { } },
        navigator: {
            mediaDevices: {
                addEventListener: (_type: string, listener: () => void) => devices.add(listener),
                enumerateDevices: async () => [{ deviceId: "default", kind: "audiooutput", label: "Default" }],
                removeEventListener: (_type: string, listener: () => void) => devices.delete(listener)
            }
        },
        window: { clearTimeout, setTimeout }
    });
    const press = (overrides: Record<string, unknown> = {}) => {
        let prevented = false;
        const event = {
            altKey: false,
            code: "KeyB",
            ctrlKey: true,
            defaultPrevented: false,
            metaKey: false,
            preventDefault: () => prevented = true,
            repeat: false,
            shiftKey: true,
            target: new Element(),
            ...overrides
        } as unknown as KeyboardEvent;
        keyboard.forEach(listener => listener(event));
        return prevented;
    };
    return { calls, devices, keyboard, modals, module, press, settingsStore };
}

test("the real plugin and child modules import without accessing Discord React or starting services", async () => {
    const { calls, devices, keyboard, module } = await fixture();
    assert.equal(module.default.name, "GlobalSoundboard");
    assert.equal(calls.reactAccess, 0);
    assert.equal(calls.storageReads, 0);
    assert.equal(devices.size, 0);
    assert.equal(keyboard.size, 0);
});

test("start and stop clean up keyboard, modal and audio-device listeners across re-enabling", async () => {
    const { calls, devices, keyboard, modals, module, press, settingsStore } = await fixture();
    module.default.start!();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(keyboard.size, 1);
    assert.equal(devices.size, 1);
    assert.equal(calls.storageReads, 1);
    assert.equal(press({ target: new Element("INPUT") }), false);
    assert.equal(press({ target: new Element("DIV", true) }), false);
    assert.equal(press({ repeat: true }), false);
    assert.equal(press({ ctrlKey: false }), false);
    settingsStore.keyboardShortcut = false;
    assert.equal(press(), false);
    settingsStore.keyboardShortcut = true;
    assert.equal(press(), true);
    assert.equal(press(), true);
    assert.equal(calls.opened, 1);

    module.default.stop!();
    assert.equal(keyboard.size, 0);
    assert.equal(devices.size, 0);
    assert.equal(modals.size, 0);
    assert.equal(calls.closed, 1);
    module.default.start!();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(keyboard.size, 1);
    assert.equal(devices.size, 1);
    assert.equal(calls.storageReads, 2);
    assert.equal(press(), true);
    assert.equal(calls.opened, 2);
    module.default.stop!();
    assert.equal(keyboard.size, 0);
    assert.equal(devices.size, 0);
    assert.equal(modals.size, 0);
    assert.equal(calls.reactAccess, 0);
});
