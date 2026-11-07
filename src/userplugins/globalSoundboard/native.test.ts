/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { GlobalSound } from "./model";
import { deferred, loadModule } from "./tests/harness";

const sound: GlobalSound = {
    available: true,
    emojiId: null,
    emojiName: null,
    guildId: "123456789012345678",
    guildName: "Test server",
    key: "123456789012345678:234567890123456789",
    name: "Sound",
    soundId: "234567890123456789",
    volume: 1
};

async function setup(window = { clearTimeout, setTimeout }) {
    const state = {
        allowed: true,
        connected: true,
        currentSound: sound as GlobalSound | undefined,
        fetchLoaded: true,
        guildExists: true,
        nativeLoaded: true,
        permission: true,
        soundUrlLoaded: true,
        storeBroken: false,
        voiceState: { mute: false, selfMute: false, suppress: false }
    };
    const calls = { fetch: 0, lookups: 0, native: [] as unknown[][], toasts: [] as string[] };
    let fetchResult: Promise<unknown> = Promise.resolve();
    const channel = { guild_id: sound.guildId, id: "345678901234567890", isGuildVoiceOrThread: () => true };
    const user = { id: "456789012345678901" };
    const module = await loadModule<typeof import("./soundboard")>("soundboard.ts", {
        "@utils/Logger": { Logger: class { error() { } } },
        "@webpack": {
            filters: { byCode: () => () => true },
            findByCode: (...markers: string[]) => markers.includes("CDN_HOST")
                ? state.soundUrlLoaded ? (id: string) => `https://cdn.discordapp.com/soundboard-sounds/${id}` : undefined
                : state.fetchLoaded ? (options: unknown) => {
                    assert.equal(JSON.stringify(options), JSON.stringify({ disableAnalytics: true }));
                    calls.fetch++;
                    return fetchResult;
                } : undefined,
            mapMangledModule: () => {
                calls.lookups++;
                return state.nativeLoaded ? {
                    canPlay: (currentUser: unknown, currentSound: unknown, currentChannel: unknown, available: boolean) => {
                        assert.equal(currentUser, user);
                        assert.equal(JSON.stringify(currentSound), JSON.stringify(state.currentSound));
                        assert.equal(currentChannel, channel);
                        assert.equal(available, true);
                        return state.allowed;
                    },
                    play: (...args: unknown[]) => calls.native.push(args)
                } : {};
            }
        },
        "@webpack/common": {
            ChannelStore: { getChannel: () => channel },
            GuildStore: { getGuild: () => state.guildExists ? { id: sound.guildId } : undefined },
            IconUtils: {},
            PermissionStore: { can: () => state.permission },
            PermissionsBits: { SPEAK: 1n, USE_SOUNDBOARD: 2n },
            RTCConnectionStore: { getChannelId: () => channel.id, isConnected: () => state.connected },
            showToast: ({ text }: { text: string; }) => calls.toasts.push(text),
            SoundboardStore: {
                getSound: () => state.currentSound,
                getSounds: () => {
                    if (state.storeBroken) throw new Error("Store changed");
                    return new Map([[sound.guildId, [sound, sound]]]);
                },
                isPlayingSound: () => true
            },
            UserStore: { getCurrentUser: () => user },
            VoiceStateStore: { getVoiceStateForChannel: () => state.voiceState }
        }
    }, { window });
    return { calls, channel, module, setFetchResult: (result: Promise<unknown>) => fetchResult = result, state };
}

test("native API lookups recover after a missing Discord chunk and cache only complete actions", async () => {
    const { calls, module, state } = await setup();
    state.nativeLoaded = false;
    for (let attempt = 0; attempt < 7; attempt++) {
        const result = module.playNative(sound);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.reason, "api");
    }
    assert.equal(calls.native.length, 0);

    state.nativeLoaded = true;
    assert.equal(module.playNative(sound).ok, true);
    assert.equal(module.playNative(sound).ok, true);
    assert.equal(calls.lookups, 8);
    assert.equal(calls.native.length, 2);
});

test("native actions preserve availability, permission, mute, and entitlement checks", async () => {
    const { calls, module, state } = await setup();
    const reject = (reason: string) => {
        const result = module.playNative(sound);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.reason, reason);
        assert.equal(calls.native.length, 0);
    };

    state.connected = false;
    reject("not-connected");
    state.connected = true;
    state.permission = false;
    reject("permission");
    state.permission = true;
    state.voiceState.mute = true;
    reject("permission");
    state.voiceState.mute = false;
    state.voiceState.suppress = true;
    reject("permission");
    state.voiceState.suppress = false;
    state.allowed = false;
    reject("not-allowed");
    state.allowed = true;
    state.currentSound = { ...sound, available: false };
    reject("unavailable");
    state.currentSound = undefined;
    reject("unavailable");
    state.currentSound = sound;
    state.guildExists = false;
    reject("unavailable");
});

test("native playback uses current store data and accepts only a dispatched native request", async () => {
    const { calls, channel, module, state } = await setup();
    state.currentSound = { ...sound, name: "Updated sound", volume: 0.4 };
    // Discord allows soundboard playback while the microphone is self-muted.
    state.voiceState.selfMute = true;
    assert.equal(module.playNative(sound).ok, true);
    assert.equal(JSON.stringify(calls.native[0][0]), JSON.stringify(state.currentSound));
    assert.equal(calls.native[0][1], channel.id);
    assert.equal(JSON.stringify(calls.native[0][2]), "[]");
});

test("URL and refresh lookup failures remain retryable, and concurrent refreshes share one request", async () => {
    const { calls, module, setFetchResult, state } = await setup();
    state.soundUrlLoaded = false;
    state.fetchLoaded = false;
    for (let attempt = 0; attempt < 7; attempt++) {
        assert.throws(() => module.resolveSoundUrl(sound.soundId), /unavailable/);
        await assert.rejects(module.refreshSoundboard(), /unavailable/);
    }

    state.soundUrlLoaded = true;
    state.fetchLoaded = true;
    assert.equal(module.resolveSoundUrl(sound.soundId), `https://cdn.discordapp.com/soundboard-sounds/${sound.soundId}`);
    const fetch = deferred<unknown>();
    setFetchResult(fetch.promise);
    const first = module.refreshSoundboard();
    const second = module.refreshSoundboard();
    assert.equal(first, second);
    assert.equal(calls.fetch, 1);
    fetch.resolve(undefined);
    await first;
    await module.refreshSoundboard();
    assert.equal(calls.fetch, 2);
});

test("a stalled native refresh times out and the next user retry can complete", async () => {
    let timeout: (() => void) | undefined;
    let clears = 0;
    const { module, setFetchResult } = await setup({
        clearTimeout: (() => clears++) as typeof clearTimeout,
        setTimeout: ((callback: () => void) => {
            timeout = callback;
            return 1;
        }) as unknown as typeof setTimeout
    });
    setFetchResult(new Promise(() => { }));
    const refresh = module.refreshSoundboard();
    timeout!();
    await assert.rejects(refresh, /timed out/);
    assert.equal(clears, 1);
    setFetchResult(Promise.resolve());
    await module.refreshSoundboard();
    assert.equal(clears, 2);
});

test("native playing state is unique and store failures cannot crash the modal", async () => {
    const { calls, module, state } = await setup();
    assert.deepEqual(Array.from(module.getNativePlayingSoundIds()), [sound.soundId]);
    state.storeBroken = true;
    assert.deepEqual(Array.from(module.getNativePlayingSoundIds()), []);
    assert.equal(calls.toasts.length, 1);
});

test("an old context-menu sound resolves its current availability and volume before local playback", async () => {
    const { module, state } = await setup();
    state.currentSound = { ...sound, available: false, name: "Updated sound", volume: 0.25 };
    const current = module.getCurrentSound(sound);
    assert.equal(current?.available, false);
    assert.equal(current?.name, "Updated sound");
    assert.equal(current?.volume, 0.25);
    assert.equal(current?.key, sound.key);
    assert.equal(current?.guildName, sound.guildName);
    state.currentSound = undefined;
    assert.equal(module.getCurrentSound(sound), null);
    state.currentSound = sound;
    state.guildExists = false;
    assert.equal(module.getCurrentSound(sound), null);
});
