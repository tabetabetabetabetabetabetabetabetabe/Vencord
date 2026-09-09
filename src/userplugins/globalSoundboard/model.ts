/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface StoredSound {
    available: boolean;
    emojiId: string | null;
    emojiName: string | null;
    guildId: string;
    name: string;
    soundId: string;
    volume: number;
}

export interface GuildSummary {
    icon?: string | null;
    id: string;
    name: string;
}

export interface GlobalSound extends StoredSound {
    guildIcon?: string;
    guildName: string;
    key: string;
}

export type SoundTab = "all" | "favorites" | "history";

export function makeSoundKey(sound: Pick<StoredSound, "guildId" | "soundId">) {
    return `${sound.guildId}:${sound.soundId}`;
}

export function flattenSoundMap(
    soundsByGuild: ReadonlyMap<string, readonly StoredSound[]>,
    guilds: Readonly<Record<string, GuildSummary>>,
    getGuildIcon: (guild: GuildSummary) => string | undefined
) {
    const result: GlobalSound[] = [];

    for (const [mapGuildId, sounds] of soundsByGuild) {
        const isDiscordDefaults = mapGuildId === "0";
        const guild = guilds[mapGuildId];
        if (!guild && !isDiscordDefaults) continue;
        const guildIcon = guild ? getGuildIcon(guild) : undefined;

        for (const sound of sounds ?? []) {
            const guildId = sound.guildId || mapGuildId;
            result.push({
                ...sound,
                guildId,
                guildIcon,
                guildName: guild?.name ?? "Discord Standard",
                key: `${guildId}:${sound.soundId}`
            });
        }
    }

    return result.sort((left, right) =>
        left.guildName.localeCompare(right.guildName) || left.name.localeCompare(right.name)
    );
}

function searchable(value: string | null | undefined) {
    return (value ?? "").normalize("NFKC").toLocaleLowerCase();
}

export function filterSounds(
    sounds: readonly GlobalSound[],
    options: {
        favorites: ReadonlySet<string>;
        guildId: string;
        history: readonly string[];
        query: string;
        showUnavailable: boolean;
        tab: SoundTab;
    }
) {
    let base = sounds;
    if (options.tab === "history") {
        const byKey = new Map(sounds.map(sound => [sound.key, sound]));
        base = options.history.map(key => byKey.get(key)).filter((sound): sound is GlobalSound => sound != null);
    }
    const query = searchable(options.query.trim());

    return base.filter(sound => {
        if (!options.showUnavailable && !sound.available) return false;
        if (options.guildId !== "all" && sound.guildId !== options.guildId) return false;
        if (options.tab === "favorites" && !options.favorites.has(sound.key)) return false;
        if (!query) return true;

        return [sound.name, sound.guildName, sound.emojiName]
            .some(value => searchable(value).includes(query));
    });
}

export function pushRecent(history: readonly string[], key: string, limit: number) {
    return Array.from(new Set([key, ...history])).slice(0, normalizeHistoryLimit(limit));
}

export function normalizeHistoryLimit(limit: number) {
    return Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 30;
}
