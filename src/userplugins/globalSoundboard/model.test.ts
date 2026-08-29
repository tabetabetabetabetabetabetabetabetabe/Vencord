/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import test from "node:test";

import { filterSounds, flattenSoundMap, GlobalSound, pushRecent } from "./model";

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
