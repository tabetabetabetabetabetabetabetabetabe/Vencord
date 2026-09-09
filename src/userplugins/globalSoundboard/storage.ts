/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { normalizeHistoryLimit } from "./model";

type PickerField = "favorites" | "history" | "search";
type PickerValue = string[] | string | null;

// Keep reads behind pending writes even when the picker closes and reopens.
let pending: Promise<unknown> = Promise.resolve();
// Retain failed edits across modal remounts; never pretend they are persisted.
const unsaved = new Map<string, PickerValue>();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
}

function dataKey(userId: string, field: PickerField) {
    if (!userId || userId === "unknown") throw new Error("ログイン中のアカウントを確認できません。");
    return `GlobalSoundboard_${userId}_${field}`;
}

function readKeys(value: unknown, field: PickerField): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(`${field}の保存形式が正しくありません。既存データは保持しています。`);
    return Array.from(new Set(value.filter((key): key is string => typeof key === "string" && key.length > 0)));
}

export function loadPickerData(userId: string, historyLimit: number) {
    const keys = [dataKey(userId, "favorites"), dataKey(userId, "history"), dataKey(userId, "search")];
    return enqueue(async () => {
        const stored = await Promise.all(keys.map(key => DataStore.get<unknown>(key)));
        const [favorites, history, search] = keys.map((key, index) =>
            unsaved.has(key) ? unsaved.get(key) ?? undefined : stored[index]
        );
        if (search !== undefined && typeof search !== "string")
            throw new Error("検索条件の保存形式が正しくありません。既存データは保持しています。");
        return {
            favorites: new Set(readKeys(favorites, "favorites")),
            history: readKeys(history, "history").slice(0, normalizeHistoryLimit(historyLimit)),
            search: typeof search === "string" ? search.slice(0, 1024) : "",
            unsavedChanges: keys.some(key => unsaved.has(key))
        };
    });
}

export function savePickerData(userId: string, field: PickerField, value: PickerValue): Promise<void> {
    // Capture the account and value now, never look up UserStore in a delayed write.
    const key = dataKey(userId, field);
    const snapshot = Array.isArray(value) ? [...value] : value;
    return enqueue(async () => {
        try {
            if (snapshot === null) await DataStore.del(key);
            else await DataStore.set(key, snapshot);
            unsaved.delete(key);
        } catch (error) {
            unsaved.set(key, snapshot);
            throw error;
        }
    });
}
