/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import type { LocalPlayback } from "./audio";
import type { GlobalSound } from "./model";
import { deferred, loadModule } from "./tests/harness";

const sound: GlobalSound = {
    available: true,
    emojiId: null,
    emojiName: null,
    guildId: "guild",
    guildName: "Server",
    key: "guild:sound",
    name: "Sound",
    soundId: "sound",
    volume: 0.5
};
const url = "https://cdn.discordapp.com/soundboard-sounds/sound";
const output = (deviceId: string) => ({ deviceId, kind: "audiooutput", label: deviceId });

async function fixture() {
    const elements: MockAudio[] = [];
    const states: (LocalPlayback | null)[] = [];
    const writes: string[] = [];
    const failures: string[] = [];
    const deviceListeners = new Set<() => void>();
    const behavior = {
        saved: "cable-A",
        outputs: [output("cable-A"), output("cable-B")],
        sink: async (_deviceId: string) => { },
        play: async () => { },
        enumerate: async () => behavior.outputs
    };
    const dataStore = {
        get: async () => behavior.saved,
        set: async (_key: string, value: string) => {
            writes.push(value);
            behavior.saved = value;
        }
    };

    class MockAudio {
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onpause: (() => void) | null = null;
        src = "";
        preload = "";
        sinkId = "";
        sinkCalls: string[] = [];
        playCalls = 0;
        pauseCalls = 0;
        loadCalls = 0;
        private currentVolume = 1;

        constructor() {
            elements.push(this);
        }

        get volume() { return this.currentVolume; }
        set volume(value: number) {
            assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, "HTMLAudioElement volume must be finite and within [0, 1]");
            this.currentVolume = value;
        }

        async setSinkId(deviceId: string) {
            this.sinkCalls.push(deviceId);
            await behavior.sink(deviceId);
            this.sinkId = deviceId;
        }

        async play() {
            this.playCalls++;
            await behavior.play();
        }

        pause() { this.pauseCalls++; }
        load() { this.loadCalls++; }
        removeAttribute(name: string) {
            if (name === "src") this.src = "";
        }
    }

    const api = await loadModule<typeof import("./audio")>("audio.ts", {
        "@api/DataStore": dataStore,
        "./soundboard": { showFailure: (key: string) => failures.push(key) }
    }, {
        Audio: MockAudio,
        HTMLAudioElement: MockAudio,
        navigator: {
            mediaDevices: {
                enumerateDevices: () => behavior.enumerate(),
                addEventListener: (_event: string, listener: () => void) => deviceListeners.add(listener),
                removeEventListener: (_event: string, listener: () => void) => deviceListeners.delete(listener)
            }
        }
    });
    api.subscribeLocalPlayback(state => states.push(state));
    return { api, behavior, dataStore, deviceListeners, elements, failures, states, writes };
}

test("preview uses the local default, applies live bounded volume, and releases media on stop", async () => {
    const f = await fixture();
    await f.api.selectOutputDevice("cable-B");
    assert.equal(await f.api.playLocalSound(sound, url, "preview", 150), true);
    const audio = f.elements[0];
    assert.equal(audio.sinkId, "");
    assert.equal(audio.volume, 0.75);
    assert.equal(f.states.at(-1)?.status, "playing");
    f.api.setCurrentMasterVolume(NaN);
    assert.equal(audio.volume, 0.5);
    f.api.setCurrentMasterVolume(300);
    assert.equal(audio.volume, 1);
    f.api.setCurrentMasterVolume(-1);
    assert.equal(audio.volume, 0);
    f.api.stopCurrentSound();
    assert.equal(f.states.at(-1), null);
    assert.equal(audio.src, "");
    assert.equal(audio.onended, null);
    assert.equal(audio.onerror, null);
    assert.equal(audio.onpause, null);
    assert.ok(audio.pauseCalls > 0 && audio.loadCalls > 0);
});

test("loading is observable and stop prevents delayed output initialization from starting playback", async () => {
    const f = await fixture();
    const sink = deferred<void>();
    f.behavior.sink = () => sink.promise;
    const pending = f.api.playLocalSound(sound, url, "output", 100);
    assert.equal(f.states.at(-1)?.status, "loading");
    await setImmediate();
    f.api.stopCurrentSound();
    sink.resolve();
    assert.equal(await pending, false);
    assert.equal(f.elements[0].playCalls, 0);
    assert.equal(f.states.at(-1), null);
});

test("a cancelled NotFoundError cannot overwrite a newly selected output", async () => {
    const f = await fixture();
    const sink = deferred<void>();
    f.behavior.sink = () => sink.promise;
    const pending = f.api.playLocalSound(sound, url, "output", 100);
    await setImmediate();
    assert.deepEqual(f.elements[0].sinkCalls, ["cable-A"]);
    await f.api.selectOutputDevice("cable-B");
    sink.reject(new DOMException("Device removed", "NotFoundError"));
    assert.equal(await pending, false);
    assert.equal(f.api.getSelectedOutputDevice(), "cable-B");
    assert.deepEqual(f.writes, ["cable-B"]);
});

test("output selection stops the former route but leaves local preview alone", async () => {
    const f = await fixture();
    await f.api.playLocalSound(sound, url, "output", 100);
    assert.equal(f.elements[0].sinkId, "cable-A");
    await f.api.selectOutputDevice("cable-B");
    assert.ok(f.elements[0].pauseCalls > 0);
    assert.equal(f.states.at(-1), null);
    await f.api.playLocalSound(sound, url, "preview", 100);
    await f.api.selectOutputDevice("cable-A");
    assert.equal(f.elements[1].pauseCalls, 0);
    assert.equal(f.states.at(-1)?.mode, "preview");
});

test("failed saved-device reads block output and can be retried", async () => {
    const f = await fixture();
    let attempts = 0;
    f.dataStore.get = async () => {
        if (++attempts === 1) throw new Error("Database temporarily unavailable");
        return "cable-B";
    };
    await assert.rejects(f.api.playLocalSound(sound, url, "output", 100), /Database temporarily unavailable/);
    assert.equal(f.elements[0].playCalls, 0);
    assert.equal(f.states.at(-1), null);
    assert.equal(await f.api.playLocalSound(sound, url, "output", 100), true);
    assert.equal(f.elements[1].sinkId, "cable-B");
    assert.equal(attempts, 2);
});

test("a genuinely missing output resets to Default without starting on another device", async () => {
    const f = await fixture();
    f.behavior.sink = async () => { throw new DOMException("Device removed", "NotFoundError"); };
    await assert.rejects(f.api.playLocalSound(sound, url, "output", 100), { name: "OutputDeviceMissingError" });
    assert.equal(f.api.getSelectedOutputDevice(), "default");
    assert.equal(f.elements[0].playCalls, 0);
    assert.equal(f.states.at(-1), null);
});

for (const event of ["onended", "onpause", "onerror"] as const) {
    test(`${event} before play resolves cannot resurrect the completed playback`, async () => {
        const f = await fixture();
        const played = deferred<void>();
        f.behavior.play = () => played.promise;
        const pending = f.api.playLocalSound(sound, url, "preview", 100);
        await setImmediate();
        f.elements[0][event]?.();
        played.resolve();
        assert.equal(await pending, false);
        assert.equal(f.states.at(-1), null);
        assert.equal(f.states.some(state => state?.status === "playing"), false);
        assert.equal(f.failures.length, event === "onerror" ? 1 : 0);
    });
}

test("device removal stops active output without a mounted settings page and dispose removes monitoring", async () => {
    const f = await fixture();
    f.api.initializeAudio();
    f.api.initializeAudio();
    await setImmediate();
    assert.equal(f.deviceListeners.size, 1);
    await f.api.playLocalSound(sound, url, "output", 100);
    f.behavior.outputs = [output("cable-B")];
    f.deviceListeners.forEach(listener => listener());
    await setImmediate();
    assert.equal(f.api.getSelectedOutputDevice(), "default");
    assert.equal(f.states.at(-1), null);
    assert.ok(f.elements[0].pauseCalls > 0);
    assert.deepEqual(f.failures, ["device-missing"]);
    f.api.disposeAudio();
    assert.equal(f.deviceListeners.size, 0);
});

test("stale device enumeration cannot reset a more recent output choice", async () => {
    const f = await fixture();
    const devices = deferred<ReturnType<typeof output>[]>();
    f.behavior.enumerate = () => devices.promise;
    const pending = f.api.refreshAudioOutputs();
    await setImmediate();
    await f.api.selectOutputDevice("cable-B");
    devices.resolve([]);
    await pending;
    assert.equal(f.api.getSelectedOutputDevice(), "cable-B");
    assert.deepEqual(f.writes, ["cable-B"]);
});

test("a delayed saved-device read cannot overwrite an explicit selection", async () => {
    const f = await fixture();
    const saved = deferred<string>();
    f.dataStore.get = () => saved.promise;
    const pending = f.api.loadSelectedOutputDevice();
    await setImmediate();
    await f.api.selectOutputDevice("cable-B");
    saved.resolve("cable-A");
    await pending;
    assert.equal(f.api.getSelectedOutputDevice(), "cable-B");
});

test("dispose prevents an in-flight enumeration from rewriting the selected device", async () => {
    const f = await fixture();
    const devices = deferred<ReturnType<typeof output>[]>();
    f.behavior.enumerate = () => devices.promise;
    const pending = f.api.refreshAudioOutputs();
    await setImmediate();
    f.api.disposeAudio();
    devices.resolve([]);
    await pending;
    assert.equal(f.api.getSelectedOutputDevice(), "cable-A");
    assert.deepEqual(f.writes, []);
});

test("output persistence remains ordered and recovers after a failed write", async () => {
    const f = await fixture();
    const firstWrite = deferred<void>();
    const writes: string[] = [];
    f.dataStore.set = async (_key: string, value: string) => {
        writes.push(value);
        if (value === "cable-A") await firstWrite.promise;
    };
    const first = f.api.selectOutputDevice("cable-A");
    const failed = assert.rejects(first, /Database temporarily unavailable/);
    const second = f.api.selectOutputDevice("cable-B");
    await setImmediate();
    assert.deepEqual(writes, ["cable-A"]);
    firstWrite.reject(new Error("Database temporarily unavailable"));
    await failed;
    await second;
    assert.deepEqual(writes, ["cable-A", "cable-B"]);
    assert.equal(f.api.getSelectedOutputDevice(), "cable-B");
});
