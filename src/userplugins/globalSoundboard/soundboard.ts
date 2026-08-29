/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import type { Channel, SoundboardSound, User } from "@vencord/discord-types";
import { filters, findByCodeLazy, mapMangledModuleLazy } from "@webpack";
import {
    ChannelStore,
    GuildStore,
    IconUtils,
    PermissionsBits,
    PermissionStore,
    RTCConnectionStore,
    showToast,
    SoundboardStore,
    Toasts,
    UserStore,
    VoiceStateStore
} from "@webpack/common";

import { flattenSoundMap, GlobalSound } from "./model";

const logger = new Logger("GlobalSoundboard");
const toastTimes = new Map<string, number>();

interface NativeSoundboardActions {
    canPlay(user: User, sound: SoundboardSound, channel: Channel, checkAvailable?: boolean): boolean;
    play(sound: SoundboardSound, channelId: string, analyticsLocations?: unknown[], sequenceIndex?: number): void;
}

const NativeSoundboard = mapMangledModuleLazy(
    ["SEND_SOUNDBOARD_SOUND", "SOUNDBOARD_TRACK_USAGE"],
    {
        canPlay: filters.byCode("canUseSoundboardEverywhere", ".available"),
        play: filters.byCode("source_guild_id", "SOUNDBOARD_TRACK_USAGE")
    }
) as NativeSoundboardActions;

const fetchAllSounds = findByCodeLazy(
    "EXPRESSION_PICKER_SOUNDBOARD_SOUNDS_LOADED",
    '"REQUEST_SOUNDBOARD_SOUNDS"',
    '"SOUNDBOARD_FETCH_DEFAULT_SOUNDS"'
) as ((options?: { disableAnalytics?: boolean; }) => Promise<unknown>);

const getSoundUrl = findByCodeLazy("CDN_HOST", "API_ENDPOINT", ".SOUNDBOARD_SOUND(") as ((soundId: string) => string);

export function showFailure(key: string, message: string, error?: unknown) {
    logger.error(message, error);
    const now = Date.now();
    if (now - (toastTimes.get(key) ?? 0) < 5_000) return;

    toastTimes.set(key, now);
    showToast(message, Toasts.Type.FAILURE, { duration: 5_000 });
}

export function collectGlobalSounds(): GlobalSound[] {
    if (!SoundboardStore || !GuildStore) return [];

    try {
        return flattenSoundMap(
            SoundboardStore.getSounds() ?? new Map(),
            GuildStore.getGuilds() ?? {},
            guild => IconUtils.getGuildIconURL({
                canAnimate: false,
                icon: guild.icon ?? undefined,
                id: guild.id,
                size: 32
            })
        );
    } catch (error) {
        showFailure("collect", "Soundboard一覧を読み込めませんでした。", error);
        return [];
    }
}

export async function refreshSoundboard() {
    if (!SoundboardStore || typeof fetchAllSounds !== "function")
        throw new Error("Discord Soundboard API is unavailable");

    let timeoutId: number | undefined;
    try {
        await Promise.race([
            fetchAllSounds({ disableAnalytics: true }),
            new Promise<never>((_, reject) => {
                timeoutId = window.setTimeout(
                    () => reject(new Error("Discord Soundboard refresh timed out")),
                    15_000
                );
            })
        ]);
    } finally {
        if (timeoutId != null) window.clearTimeout(timeoutId);
    }
}

export function resolveSoundUrl(soundId: string) {
    if (typeof getSoundUrl !== "function") throw new Error("Discord sound URL API is unavailable");

    const url = getSoundUrl(soundId);
    if (typeof url !== "string" || !url) throw new Error("Discord returned an invalid sound URL");
    return url;
}

export function soundStillExists(sound: GlobalSound) {
    try {
        return SoundboardStore?.getSound(sound.guildId, sound.soundId) != null
            && (sound.guildId === "0" || GuildStore?.getGuild(sound.guildId) != null);
    } catch {
        return false;
    }
}

export type NativePlayFailure = "api" | "not-allowed" | "not-connected" | "permission" | "unavailable";

export function playNative(sound: GlobalSound): { ok: true; } | { ok: false; reason: NativePlayFailure; } {
    if (!sound.available) return { ok: false, reason: "unavailable" };

    try {
        if (!RTCConnectionStore?.isConnected()) return { ok: false, reason: "not-connected" };

        const channelId = RTCConnectionStore.getChannelId();
        const channel = channelId ? ChannelStore?.getChannel(channelId) : undefined;
        const user = UserStore?.getCurrentUser();
        if (!channelId || !channel || !user) return { ok: false, reason: "not-connected" };

        const voiceState = VoiceStateStore?.getVoiceStateForChannel(channelId, user.id);
        if (voiceState?.mute || voiceState?.suppress) return { ok: false, reason: "permission" };

        if (channel.guild_id && (
            !channel.isGuildVoiceOrThread()
            || !PermissionStore.can(PermissionsBits.USE_SOUNDBOARD, channel)
            || !PermissionStore.can(PermissionsBits.SPEAK, channel)
        )) return { ok: false, reason: "permission" };

        if (typeof NativeSoundboard.canPlay !== "function" || typeof NativeSoundboard.play !== "function")
            return { ok: false, reason: "api" };
        if (!NativeSoundboard.canPlay(user, sound, channel, true))
            return { ok: false, reason: "not-allowed" };

        NativeSoundboard.play(sound, channelId, []);
        return { ok: true };
    } catch (error) {
        logger.error("Native Soundboard playback failed", error);
        return { ok: false, reason: "api" };
    }
}
