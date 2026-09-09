/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import test from "node:test";

import { deferred, loadModule } from "./tests/harness";

type Storage = typeof import("./storage");

async function fixture(initial: [string, unknown][] = []) {
    const values = new Map<string, unknown>(initial);
    const boundary = {
        get: async (key: string) => values.get(key),
        set: async (key: string, value: unknown) => { values.set(key, value); },
        del: async (key: string) => { values.delete(key); }
    };
    const storage = await loadModule<Storage>("storage.ts", { "@api/DataStore": boundary });
    return { boundary, storage, values };
}

test("a reopened picker waits for pending writes and sees the latest favorite", async () => {
    const { boundary, storage, values } = await fixture();
    const gate = deferred<void>();
    boundary.set = async (key, value) => {
        await gate.promise;
        values.set(key, value);
    };
    const saving = storage.savePickerData("123", "favorites", ["guild:sound"]);
    let loaded = false;
    const reopening = storage.loadPickerData("123", 30).then(data => { loaded = true; return data; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(loaded, false);
    gate.resolve();
    await saving;
    assert.deepEqual(Array.from((await reopening).favorites), ["guild:sound"]);
});

test("queued writes retain the original account and an immutable value snapshot", async () => {
    const { boundary, storage, values } = await fixture();
    const gate = deferred<void>();
    boundary.set = async (key, value) => { await gate.promise; values.set(key, value); };
    const favorites = ["guild:a"];
    const oldAccount = storage.savePickerData("123", "favorites", favorites);
    favorites.push("guild:should-not-be-written");
    const newAccount = storage.savePickerData("456", "favorites", ["guild:b"]);
    gate.resolve();
    await Promise.all([oldAccount, newAccount]);
    assert.deepEqual(Array.from(values.get("GlobalSoundboard_123_favorites") as string[]), ["guild:a"]);
    assert.deepEqual(Array.from(values.get("GlobalSoundboard_456_favorites") as string[]), ["guild:b"]);
});

test("a failed read rejects without erasing existing data and can be retried", async () => {
    const { boundary, storage, values } = await fixture([
        ["GlobalSoundboard_123_favorites", ["guild:kept"]]
    ]);
    const read = boundary.get;
    boundary.get = async key => {
        if (key.endsWith("_history")) throw new Error("temporary IndexedDB failure");
        return read(key);
    };
    await assert.rejects(storage.loadPickerData("123", 30), /IndexedDB/);
    assert.deepEqual(values.get("GlobalSoundboard_123_favorites"), ["guild:kept"]);
    boundary.get = read;
    assert.deepEqual(Array.from((await storage.loadPickerData("123", 30)).favorites), ["guild:kept"]);
});

test("a failed write does not poison future reads and writes", async () => {
    const { boundary, storage, values } = await fixture();
    boundary.set = async () => { throw new Error("disk full"); };
    await assert.rejects(storage.savePickerData("123", "search", "old"), /disk full/);
    boundary.set = async (key, value) => { values.set(key, value); };
    await storage.savePickerData("123", "search", "new");
    assert.equal((await storage.loadPickerData("123", 30)).search, "new");
    await storage.savePickerData("123", "search", null);
    assert.equal((await storage.loadPickerData("123", 30)).search, "");
});

test("failed edits survive closing and reopening, remain account-scoped, and clear after retry", async () => {
    const { boundary, storage, values } = await fixture([
        ["GlobalSoundboard_123_favorites", ["guild:old"]]
    ]);
    boundary.set = async () => { throw new Error("disk full"); };
    const edits = ["guild:new"];
    await assert.rejects(storage.savePickerData("123", "favorites", edits), /disk full/);
    edits.push("guild:not-captured");
    const reopened = await storage.loadPickerData("123", 30);
    assert.deepEqual(Array.from(reopened.favorites), ["guild:new"]);
    assert.equal(reopened.unsavedChanges, true);
    assert.deepEqual(values.get("GlobalSoundboard_123_favorites"), ["guild:old"]);
    const other = await storage.loadPickerData("456", 30);
    assert.equal(other.favorites.size, 0);
    assert.equal(other.unsavedChanges, false);
    boundary.set = async (key, value) => { values.set(key, value); };
    await storage.savePickerData("123", "favorites", Array.from(reopened.favorites));
    assert.equal((await storage.loadPickerData("123", 30)).unsavedChanges, false);
    assert.deepEqual(Array.from(values.get("GlobalSoundboard_123_favorites") as string[]), ["guild:new"]);
});

test("failed search deletion stays pending until a successful retry", async () => {
    const { boundary, storage, values } = await fixture([["GlobalSoundboard_123_search", "old"]]);
    boundary.del = async () => { throw new Error("disk full"); };
    await assert.rejects(storage.savePickerData("123", "search", null), /disk full/);
    const reopened = await storage.loadPickerData("123", 30);
    assert.equal(reopened.search, "");
    assert.equal(reopened.unsavedChanges, true);
    assert.equal(values.get("GlobalSoundboard_123_search"), "old");
    boundary.del = async key => { values.delete(key); };
    await storage.savePickerData("123", "search", null);
    assert.equal((await storage.loadPickerData("123", 30)).unsavedChanges, false);
});

test("stored lists are sanitized, history bounded, and invalid schema is not overwritten", async () => {
    const { storage, values } = await fixture([
        ["GlobalSoundboard_123_favorites", ["a", null, "a", 3, "b"]],
        ["GlobalSoundboard_123_history", ["a", "b", "c"]],
        ["GlobalSoundboard_123_search", "x".repeat(2000)]
    ]);
    const loaded = await storage.loadPickerData("123", 2);
    assert.deepEqual(Array.from(loaded.favorites), ["a", "b"]);
    assert.deepEqual(Array.from(loaded.history), ["a", "b"]);
    assert.equal(loaded.search.length, 1024);
    values.set("GlobalSoundboard_123_favorites", { broken: true });
    await assert.rejects(storage.loadPickerData("123", 30), /favorites/);
    assert.deepEqual(values.get("GlobalSoundboard_123_favorites"), { broken: true });
    assert.throws(() => storage.savePickerData("unknown", "search", "unsafe"));
});
