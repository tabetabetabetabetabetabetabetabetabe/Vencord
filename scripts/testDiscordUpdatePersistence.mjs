/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { win32 as path } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const { transform } = createRequire(import.meta.url)("esbuild");
const source = await readFile(new URL("../src/main/persistAfterDiscordUpdates.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "cjs" });
const discordPath = "C:\\Discord";
const resource = (version, file = "app.asar") => path.join(discordPath, version, "resources", file);
const shutdownEvent = { preventDefault() { assert.fail("Shutdown must not be cancelled"); } };

function load({ platform = "win32", env = {}, versions = ["app-1.0.9", "app-1.0.10"], backup = false, scanError = false, copyFailures = 0, restoreError = false } = {}) {
    const app = new EventEmitter();
    const files = new Map(versions.map(version => [resource(version), `original:${version}`]));
    files.set(resource("app-1.0.9"), "custom-patcher");
    if (backup) files.set(resource("app-1.0.10", "_app.asar"), "existing-backup");
    const writes = [];
    const errors = [];
    const mocks = {
        electron: { app },
        path,
        "original-fs": {
            readdirSync(directory) {
                assert.equal(directory, discordPath);
                if (scanError) throw new Error("Access denied");
                return versions;
            },
            existsSync: file => files.has(file),
            renameSync(from, to) {
                assert.ok(files.has(from));
                if (path.basename(to) === "_app.asar") {
                    assert.ok(!files.has(to), "Existing backup must not be overwritten");
                } else if (restoreError) {
                    throw new Error("Restore denied");
                }
                writes.push(["rename", from, to]);
                files.set(to, files.get(from));
                files.delete(from);
            },
            copyFileSync(from, to) {
                assert.ok(files.has(from));
                writes.push(["copy", from, to]);
                if (copyFailures-- > 0) {
                    files.set(to, "partial-copy");
                    throw new Error("Copy failed");
                }
                files.set(to, files.get(from));
            }
        }
    };
    runInNewContext(code, {
        require(name) {
            assert.ok(Object.hasOwn(mocks, name), `Unexpected import: ${name}`);
            return mocks[name];
        },
        process: { platform, execPath: path.join(discordPath, "app-1.0.9", "Discord.exe"), env },
        console: { info() { }, error(...args) { errors.push(args); } }
    });
    return {
        app, files, writes, errors,
        createWindow() {
            const window = new EventEmitter();
            app.emit("browser-window-created", {}, window);
            return window;
        }
    };
}

test("no update leaves all files unchanged during quit and Windows session end", () => {
    const state = load({ versions: ["app-1.0.8", "app-1.0.9", "packages"] });
    const before = [...state.files];
    const window = state.createWindow();
    window.emit("query-session-end", shutdownEvent);
    window.emit("session-end", shutdownEvent);
    state.app.emit("before-quit", shutdownEvent);
    assert.deepEqual([...state.files], before);
    assert.deepEqual(state.writes, []);
});

for (const event of ["before-quit", "query-session-end", "session-end"]) {
    test(`${event} patches only the latest numeric version and keeps Discord's original`, () => {
        const state = load({ versions: ["app-1.0.11", "app-1.0.9", "packages", "app-1.0.10"] });
        const emitter = event === "before-quit" ? state.app : state.createWindow();
        emitter.emit(event, shutdownEvent);
        assert.equal(state.files.get(resource("app-1.0.11")), "custom-patcher");
        assert.equal(state.files.get(resource("app-1.0.11", "_app.asar")), "original:app-1.0.11");
        assert.equal(state.files.get(resource("app-1.0.10")), "original:app-1.0.10");
        assert.equal(state.writes.length, 2);
        assert.deepEqual(state.errors, []);
    });
}

test("multiple windows and repeated end events patch once without cancelling shutdown", () => {
    const state = load();
    for (const window of [state.createWindow(), state.createWindow()]) {
        assert.equal(window.listenerCount("query-session-end"), 1);
        assert.equal(window.listenerCount("session-end"), 1);
        for (let i = 0; i < 2; i++) {
            window.emit("query-session-end", shutdownEvent);
            window.emit("session-end", shutdownEvent);
            state.app.emit("before-quit", shutdownEvent);
        }
    }
    assert.equal(state.writes.length, 2);
    assert.equal(state.files.get(resource("app-1.0.10", "_app.asar")), "original:app-1.0.10");
});

test("an existing backup is never overwritten", () => {
    const state = load({ backup: true });
    const before = [...state.files];
    state.createWindow().emit("query-session-end", shutdownEvent);
    state.app.emit("before-quit", shutdownEvent);
    assert.deepEqual([...state.files], before);
    assert.deepEqual(state.writes, []);
});

test("Windows hooks are absent on other platforms; before-quit remains available", () => {
    for (const platform of ["linux", "darwin"]) {
        const state = load({ platform });
        assert.equal(state.app.listenerCount("browser-window-created"), 0);
        assert.equal(state.createWindow().listenerCount("session-end"), 0);
        state.app.emit("before-quit", shutdownEvent);
        assert.equal(state.writes.length, 2);
    }
});

test("the environment opt-out is respected by every lifecycle event", () => {
    const state = load({ env: { DISABLE_UPDATER_AUTO_PATCHING: "1" } });
    const window = state.createWindow();
    window.emit("query-session-end", shutdownEvent);
    window.emit("session-end", shutdownEvent);
    state.app.emit("before-quit", shutdownEvent);
    assert.deepEqual(state.writes, []);
});

test("missing patcher or new archive does not mutate files", () => {
    for (const version of ["app-1.0.9", "app-1.0.10"]) {
        const state = load();
        state.files.delete(resource(version));
        state.createWindow().emit("session-end", shutdownEvent);
        assert.deepEqual(state.writes, []);
    }
});

test("filesystem errors stay contained and do not interrupt Windows session end", () => {
    const state = load({ scanError: true });
    assert.doesNotThrow(() => state.createWindow().emit("session-end", shutdownEvent));
    assert.equal(state.errors.length, 1);
    assert.deepEqual(state.writes, []);
});

test("a failed copy restores Discord's original and a later event can retry", () => {
    const state = load({ copyFailures: 1 });
    const window = state.createWindow();
    assert.doesNotThrow(() => window.emit("query-session-end", shutdownEvent));
    assert.equal(state.files.get(resource("app-1.0.10")), "original:app-1.0.10");
    assert.ok(!state.files.has(resource("app-1.0.10", "_app.asar")));
    assert.equal(state.errors.length, 1);
    assert.match(String(state.errors[0][1]), /Copy failed/);

    window.emit("session-end", shutdownEvent);
    assert.equal(state.files.get(resource("app-1.0.10")), "custom-patcher");
    assert.equal(state.files.get(resource("app-1.0.10", "_app.asar")), "original:app-1.0.10");
    assert.equal(state.errors.length, 1);
});

test("failed rollback preserves the original backup and reports both errors", () => {
    const state = load({ copyFailures: 1, restoreError: true });
    const window = state.createWindow();
    assert.doesNotThrow(() => window.emit("query-session-end", shutdownEvent));
    assert.equal(state.files.get(resource("app-1.0.10", "_app.asar")), "original:app-1.0.10");
    assert.equal(state.errors.length, 2);
    assert.match(String(state.errors[0][2]), /Restore denied/);
    assert.match(String(state.errors[1][1]), /Copy failed/);
    const before = [...state.files];
    window.emit("session-end", shutdownEvent);
    state.app.emit("before-quit", shutdownEvent);
    assert.deepEqual([...state.files], before);
});
