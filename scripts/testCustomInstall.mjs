/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { constants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const { transformSync } = require("esbuild");
const repo = String.raw`C:\Build`;
const script = join(repo, "scripts", "installCustom.mjs");
const dist = join(repo, "dist");
const localData = String.raw`C:\TestUser\AppData\Local`;
const discord = join(localData, "Discord");
const installer = join(dist, "Installer", "VencordInstallerCli.exe");
const resources = join(discord, "app-1.0.9256", "resources");
const injection = join(resources, "app.asar");
const original = join(resources, "_app.asar");
const { code } = transformSync(readFileSync(new URL("./installCustom.mjs", import.meta.url), "utf8"), {
    define: { "import.meta.url": JSON.stringify(pathToFileURL(script).href) },
    format: "cjs",
    sourcefile: "installCustom.mjs"
});

function fixture(args = []) {
    const files = new Map([
        [installer, Buffer.from("fake official CLI")],
        [join(dist, "patcher.js"), Buffer.from("/* Updater Disabled: true */")],
        [join(dist, "renderer.js"), Buffer.from('name:"ExternalEmojiCombiner";name:"GlobalSoundboard";')],
        [join(dist, "preload.js"), Buffer.from("fake preload")],
        [join(dist, "renderer.css"), Buffer.from("body {}")],
        [join(dist, "package.json"), Buffer.from('{"name":"vencord"}')],
        [join(discord, "app-1.0.9256", "Discord.exe"), Buffer.from("fake Discord")],
        [injection, Buffer.from("previous injection bytes")],
        [original, Buffer.from("original Discord bytes")]
    ]);
    const directories = new Set([discord, resources, dist]);
    const writes = [];
    const spawns = [];
    const messages = [];
    const state = {
        files,
        writes,
        spawns,
        messages,
        versions: ["app-1.0.9256", "packages"],
        running: [false, false],
        taskFailure: false,
        installerStatus: 0,
        installerError: undefined,
        validInjection: true,
        process: {
            platform: "win32",
            argv: ["node", script, ...args],
            env: {
                LOCALAPPDATA: localData,
                VENCORD_DEV_INSTALL: "0",
                VENCORD_USER_DATA_DIR: String.raw`C:\WrongBuild`,
                KEEP_ENVIRONMENT: "preserved"
            },
            exitCode: undefined
        }
    };
    let taskChecks = 0;
    const getFile = path => {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
        return files.get(path);
    };
    const mocks = {
        "node:fs": {
            constants,
            existsSync: path => files.has(path) || directories.has(path),
            statSync: path => ({ isFile: () => files.has(path), size: getFile(path).length }),
            readFileSync: (path, encoding) => encoding ? getFile(path).toString(encoding) : getFile(path),
            readdirSync: (path, options) => {
                assert.equal(path, discord);
                assert.equal(options.withFileTypes, true);
                return state.versions.map(name => ({ name, isDirectory: () => true }));
            },
            mkdirSync: (path, options) => {
                assert.equal(options.recursive, true);
                assert.ok(path.startsWith(join(dist, "custom-install-backups") + sep));
                directories.add(path);
                writes.push({ type: "mkdir", path });
            },
            copyFileSync: (source, destination, flags) => {
                assert.equal(flags, constants.COPYFILE_EXCL);
                assert.equal(files.has(destination), false);
                files.set(destination, Buffer.from(getFile(source)));
                writes.push({ type: "copy", source, destination });
            }
        },
        "node:child_process": {
            spawnSync: (command, commandArgs, options) => {
                spawns.push({ command, args: Array.from(commandArgs), options });
                assert.equal(options.windowsHide, true);
                if (command === "tasklist.exe") {
                    assert.deepEqual(Array.from(commandArgs), ["/FI", "IMAGENAME eq Discord.exe", "/FO", "CSV", "/NH"]);
                    if (state.taskFailure) return { status: 1, stdout: "Cannot inspect processes" };
                    const running = state.running[Math.min(taskChecks++, state.running.length - 1)];
                    return { status: 0, stdout: running ? '"Discord.exe","1234","Console","1","100 K"' : "INFO: No tasks are running." };
                }
                // No real subprocess can be reached: every other command is rejected.
                assert.equal(command, installer);
                if (!state.installerError && state.installerStatus === 0) {
                    files.set(injection, Buffer.from(state.validInjection
                        ? `require(${JSON.stringify(join(dist, "patcher.js"))})`
                        : "unexpected injection bytes"));
                }
                return { status: state.installerStatus, error: state.installerError };
            }
        }
    };
    state.run = () => {
        runInNewContext(code, {
            process: state.process,
            console: {
                log: (...parts) => messages.push(parts.join(" ")),
                error: (...parts) => messages.push(parts.join(" "))
            },
            require: name => {
                if (Object.hasOwn(mocks, name)) return mocks[name];
                assert.ok(name === "node:path" || name === "node:url", `Unexpected module: ${name}`);
                return require(name);
            }
        }, { filename: "isolated-installCustom.mjs" });
        return state;
    };
    return state;
}

function assertNoInstaller(state) {
    assert.equal(state.spawns.some(call => call.command === installer), false);
}

function assertBackupsRetained(state) {
    const backups = state.writes.filter(write => write.type === "copy");
    assert.equal(backups.length, 2);
    assert.equal(state.files.get(backups.find(write => write.source === injection).destination).toString(), "previous injection bytes");
    assert.equal(state.files.get(backups.find(write => write.source === original).destination).toString(), "original Discord bytes");
}

describe("isolated Windows custom installer", { skip: process.platform !== "win32" }, () => {
    for (const running of [false, true]) {
        test(`--check performs no writes or installation when Discord running=${running}`, () => {
            const state = fixture(["--check"]);
            state.running = [running];
            state.run();
            assert.equal(state.process.exitCode ?? 0, 0);
            assert.deepEqual(state.writes, []);
            assertNoInstaller(state);
            assert.equal(state.spawns.length, 1);
            assert.ok(state.messages.some(message => message.includes("確認のみ")));
        });
    }

    test("running Discord prevents both backups and installation", () => {
        const state = fixture();
        state.running = [true];
        state.run();
        assert.equal(state.process.exitCode, 1);
        assert.deepEqual(state.writes, []);
        assertNoInstaller(state);
    });

    test("Discord starting during backup prevents the official CLI from running", () => {
        const state = fixture();
        state.running = [false, true];
        state.run();
        assert.equal(state.process.exitCode, 1);
        assertNoInstaller(state);
        assertBackupsRetained(state);
        assert.equal(state.files.get(injection).toString(), "previous injection bytes");
        assert.ok(state.messages.some(message => message.includes("準備中にDiscordが起動")));
    });

    test("unknown Discord process state fails closed", () => {
        const state = fixture();
        state.taskFailure = true;
        state.run();
        assert.equal(state.process.exitCode, 1);
        assert.deepEqual(state.writes, []);
        assertNoInstaller(state);
    });

    test("missing preload prevents an incomplete build from being injected", () => {
        const state = fixture();
        state.files.delete(join(dist, "preload.js"));
        state.run();
        assert.equal(state.process.exitCode, 1);
        assert.deepEqual(state.writes, []);
        assertNoInstaller(state);
    });

    test("a build with the updater enabled is rejected before mutation", () => {
        const state = fixture();
        state.files.set(join(dist, "patcher.js"), Buffer.from("/* Updater Disabled: false */"));
        state.run();
        assert.equal(state.process.exitCode, 1);
        assert.deepEqual(state.writes, []);
        assertNoInstaller(state);
    });

    test("different numeric and official CLI version selections are rejected", () => {
        const state = fixture();
        state.versions = ["app-1.0.9999", "app-1.0.10000"];
        state.run();
        assert.equal(state.process.exitCode, 1);
        assert.deepEqual(state.writes, []);
        assertNoInstaller(state);
        assert.ok(state.messages.some(message => message.includes("版選択がInstallerと一致しません")));
    });

    test("success backs up both archives and verifies the fixed development build injection", () => {
        const state = fixture().run();
        assert.equal(state.process.exitCode ?? 0, 0);
        assertBackupsRetained(state);
        const calls = state.spawns.filter(call => call.command === installer);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].args, ["-install", "-location", discord]);
        assert.equal(calls[0].options.cwd, repo);
        assert.equal(calls[0].options.env.VENCORD_USER_DATA_DIR, repo);
        assert.equal(calls[0].options.env.VENCORD_DEV_INSTALL, "1");
        assert.equal(calls[0].options.env.KEEP_ENVIRONMENT, "preserved");
        assert.equal(state.spawns.filter(call => call.command === "tasklist.exe").length, 2);
        assert.ok(state.messages.some(message => message.includes("固定ビルドへの導入を確認しました")));
    });

    test("a failed installer exits nonzero and retains recoverable backup contents", () => {
        const state = fixture();
        state.installerStatus = 1;
        state.run();
        assert.equal(state.process.exitCode, 1);
        assertBackupsRetained(state);
        assert.equal(state.files.get(injection).toString(), "previous injection bytes");
        assert.equal(state.messages.some(message => message.includes("固定ビルドへの導入を確認しました")), false);
    });

    test("a CLI launch error exits nonzero without discarding backups", () => {
        const state = fixture();
        state.installerError = new Error("Cannot launch the cached installer");
        state.run();
        assert.equal(state.process.exitCode, 1);
        assertBackupsRetained(state);
    });

    test("unexpected injection output is rejected even when the CLI exits zero", () => {
        const state = fixture();
        state.validInjection = false;
        state.run();
        assert.equal(state.process.exitCode, 1);
        assertBackupsRetained(state);
        assert.ok(state.messages.some(message => message.includes("注入先の検証に失敗")));
        assert.equal(state.messages.some(message => message.includes("固定ビルドへの導入を確認しました")), false);
    });
});
