/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import { parseEmojiTokens, removeEmojiTokens, selectEmojiTokensToCombine } from "./emojiParser";

const raw = "<:first:123> <a:second:456>";
const rawTokens = parseEmojiTokens(raw);
assert.deepEqual(rawTokens.map(({ animated, id, name }) => ({ animated, id, name })), [
    { animated: false, id: "123", name: "first" },
    { animated: true, id: "456", name: "second" }
]);
assert.equal(removeEmojiTokens(raw, rawTokens), "");

const fakeNitro = "[dance](https://cdn.discordapp.com/emojis/789.gif?size=48&name=dance&lossless=true) https://media.discordapp.net/emojis/987.webp?size=48";
const fakeNitroTokens = parseEmojiTokens(fakeNitro);
assert.deepEqual(fakeNitroTokens.map(({ animated, id }) => ({ animated, id })), [
    { animated: true, id: "789" },
    { animated: false, id: "987" }
]);
assert.equal(removeEmojiTokens(fakeNitro, [fakeNitroTokens[0]]), "https://media.discordapp.net/emojis/987.webp?size=48");

assert.equal(parseEmojiTokens("\\<:escaped:123> https://example.com/emojis/123.gif").length, 0);
assert.deepEqual(parseEmojiTokens("<:same:1><:same:1> <:other:2>").map(token => token.id), ["1", "1", "2"]);
assert.equal(parseEmojiTokens("\\[dance](https://cdn.discordapp.com/emojis/1.gif) ![dance](https://cdn.discordapp.com/emojis/2.gif)").length, 0);
assert.equal(parseEmojiTokens("`<:code:1>` ```https://cdn.discordapp.com/emojis/2.gif```").length, 0);
assert.equal(parseEmojiTokens("<:bad/name:1> <:bad<name:2>").length, 0);
assert.equal(removeEmojiTokens("keep  spacing\n  indented <:one:1> <:two:2>", parseEmojiTokens("keep  spacing\n  indented <:one:1> <:two:2>")), "keep  spacing\n  indented");

const localAndExternal = "<:local:111> <:external:222>";
const localAndExternalTokens = parseEmojiTokens(localAndExternal);
const combinedTokens = selectEmojiTokensToCombine(localAndExternalTokens, new Set(["222"]), 2, 20);
assert.deepEqual(combinedTokens?.map(token => token.id), ["111", "222"]);
assert.equal(removeEmojiTokens(localAndExternal, combinedTokens ?? []), "");
assert.equal(selectEmojiTokensToCombine(localAndExternalTokens, new Set(), 2, 20), null);
assert.throws(
    () => selectEmojiTokensToCombine(localAndExternalTokens, new Set(["222"]), 2, 1),
    /configured 1 emoji limit/
);

console.log("ExternalEmojiCombiner parser checks passed.");
