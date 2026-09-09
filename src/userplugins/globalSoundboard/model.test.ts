/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import test from "node:test";

import { filterSounds, flattenSoundMap, GlobalSound, normalizeHistoryLimit, pushRecent } from "./model";

const sounds: GlobalSound[] = [
    {
        available: true,
        emojiId: null,
        emojiName: "笑顔",
        guildId: "guild-a",
        guildName: "テスト Server",
        key: "guild-a:sound-a",
        name: "拍手",
        soundId: "sound-a",
        volume: 1
    },
    {
        available: false,
        emojiId: null,
        emojiName: null,
        guildId: "guild-b",
        guildName: "Other",
        key: "guild-b:sound-b",
        name: "Locked",
        soundId: "sound-b",
        volume: 0.5
    }
];

test("searches sound, guild, and emoji names without case or width differences", () => {
    const common = { favorites: new Set<string>(), guildId: "all", history: [], showUnavailable: true, tab: "all" as const };
    assert.deepEqual(filterSounds(sounds, { ...common, query: "ＳＥＲＶＥＲ" }).map(sound => sound.key), ["guild-a:sound-a"]);
    assert.deepEqual(filterSounds(sounds, { ...common, query: "笑顔" }).map(sound => sound.key), ["guild-a:sound-a"]);
});

test("keeps history newest-first and removes duplicates", () => {
    assert.deepEqual(pushRecent(["a", "b", "c"], "b", 3), ["b", "a", "c"]);
    assert.deepEqual(pushRecent(["a", "b", "c"], "d", 2), ["d", "a"]);
    assert.deepEqual(pushRecent(["a", "a", "b", "b"], "c", 3), ["c", "a", "b"]);
});

test("bounds history even when saved configuration is invalid", () => {
    assert.equal(normalizeHistoryLimit(Number.NaN), 30);
    assert.equal(normalizeHistoryLimit(Infinity), 30);
    assert.equal(normalizeHistoryLimit(-4), 1);
    assert.equal(normalizeHistoryLimit(3.9), 3);
    assert.equal(normalizeHistoryLimit(1000), 100);
    assert.equal(pushRecent(Array.from({ length: 120 }, (_, index) => String(index)), "new", Infinity).length, 30);
});

test("combines favorites, guild, availability, and search filters", () => {
    const common = {
        favorites: new Set(sounds.map(sound => sound.key)),
        guildId: "guild-b",
        history: [],
        query: "locked",
        showUnavailable: true,
        tab: "favorites" as const
    };
    assert.deepEqual(filterSounds(sounds, common), [sounds[1]]);
    assert.deepEqual(filterSounds(sounds, { ...common, showUnavailable: false }), []);
    assert.deepEqual(filterSounds(sounds, { ...common, favorites: new Set([sounds[0].key]) }), []);
    assert.deepEqual(filterSounds(sounds, { ...common, guildId: "guild-a" }), []);
});

test("history preserves recency while omitting removed sounds and applying filters", () => {
    const common = {
        favorites: new Set<string>(),
        guildId: "all",
        history: [sounds[1].key, "removed:sound", sounds[0].key],
        query: "",
        showUnavailable: true,
        tab: "history" as const
    };
    assert.deepEqual(filterSounds(sounds, common), [sounds[1], sounds[0]]);
    assert.deepEqual(filterSounds(sounds, { ...common, showUnavailable: false }), [sounds[0]]);
    assert.deepEqual(filterSounds(sounds, { ...common, query: "拍手" }), [sounds[0]]);
});

test("drops sounds from guilds the user has left", () => {
    const flattened = flattenSoundMap(
        new Map([
            ["joined", [{ ...sounds[0], guildId: "joined" }]],
            ["left", [{ ...sounds[1], guildId: "left" }]]
        ]),
        { joined: { id: "joined", name: "Joined" } },
        () => undefined
    );

    assert.deepEqual(flattened.map(sound => sound.guildId), ["joined"]);
});

test("keeps Discord defaults and scopes keys by guild while resolving each icon once", () => {
    let iconCalls = 0;
    const flattened = flattenSoundMap(
        new Map([
            ["0", [{ ...sounds[0], guildId: "" }]],
            ["joined", [{ ...sounds[0], guildId: "joined" }, { ...sounds[0], guildId: "joined", soundId: "another" }]]
        ]),
        { joined: { id: "joined", name: "Joined" } },
        () => {
            iconCalls++;
            return "icon-url";
        }
    );
    assert.equal(iconCalls, 1);
    assert.equal(flattened.find(sound => sound.guildId === "0")?.guildName, "Discord Standard");
    assert.deepEqual(new Set(flattened.map(sound => sound.key)), new Set(["0:sound-a", "joined:sound-a", "joined:another"]));
    assert.equal(flattened.filter(sound => sound.guildId === "joined").every(sound => sound.guildIcon === "icon-url"), true);
});
