/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import type { Channel, SoundboardSound, User } from "@vencord/discord-types";
import { filters, findByCode, mapMangledModule } from "@webpack";
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

let nativeSoundboard: NativeSoundboardActions | undefined;
let fetchAllSounds: ((options?: { disableAnalytics?: boolean; }) => Promise<unknown>) | undefined;
let getSoundUrl: ((soundId: string) => string) | undefined;
let refreshInFlight: Promise<void> | undefined;

function getNativeSoundboard(): NativeSoundboardActions {
    if (nativeSoundboard) return nativeSoundboard;

    // Failed lazy lookups must remain retryable after Discord loads its soundboard chunks.
    const actions = mapMangledModule(
        ["SEND_SOUNDBOARD_SOUND", "SOUNDBOARD_TRACK_USAGE"],
        {
            canPlay: filters.byCode("canUseSoundboardEverywhere", ".available"),
            play: filters.byCode("source_guild_id", "SOUNDBOARD_TRACK_USAGE")
        }
    );
    if (typeof actions.canPlay !== "function" || typeof actions.play !== "function")
        throw new Error("Discord native Soundboard API is unavailable");

    return nativeSoundboard = actions as NativeSoundboardActions;
}

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

export function getNativePlayingSoundIds(): string[] {
    if (!SoundboardStore) return [];

    try {
        const playing = new Set<string>();
        for (const sounds of SoundboardStore.getSounds().values()) {
            for (const sound of sounds) {
                if (SoundboardStore.isPlayingSound(sound.soundId)) playing.add(sound.soundId);
            }
        }
        return [...playing].sort();
    } catch (error) {
        showFailure("native-playing", "DiscordのSoundboard再生状態を取得できませんでした。", error);
        return [];
    }
}

export function refreshSoundboard(): Promise<void> {
    return refreshInFlight ??= fetchSoundboard().finally(() => refreshInFlight = undefined);
}

async function fetchSoundboard() {
    if (!SoundboardStore)
        throw new Error("Discord Soundboard API is unavailable");

    const fetchSounds = fetchAllSounds ?? findByCode(
        "EXPRESSION_PICKER_SOUNDBOARD_SOUNDS_LOADED",
        '"REQUEST_SOUNDBOARD_SOUNDS"',
        '"SOUNDBOARD_FETCH_DEFAULT_SOUNDS"'
    );
    if (typeof fetchSounds !== "function") throw new Error("Discord Soundboard API is unavailable");
    fetchAllSounds = fetchSounds;

    let timeoutId: number | undefined;
    try {
        await Promise.race([
            fetchSounds({ disableAnalytics: true }),
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
    const resolve = getSoundUrl ?? findByCode("CDN_HOST", "API_ENDPOINT", ".SOUNDBOARD_SOUND(");
    if (typeof resolve !== "function") throw new Error("Discord sound URL API is unavailable");
    getSoundUrl = resolve;

    const url = resolve(soundId);
    if (typeof url !== "string" || !url) throw new Error("Discord returned an invalid sound URL");
    return url;
}

export function getCurrentSound(sound: GlobalSound): GlobalSound | null {
    try {
        const currentSound = SoundboardStore?.getSound(sound.guildId, sound.soundId);
        if (!currentSound || (sound.guildId !== "0" && !GuildStore?.getGuild(sound.guildId))) return null;
        return { ...sound, ...currentSound };
    } catch {
        return null;
    }
}

export type NativePlayFailure = "api" | "not-allowed" | "not-connected" | "permission" | "unavailable";

export function playNative(sound: GlobalSound): { ok: true; } | { ok: false; reason: NativePlayFailure; } {
    try {
        const currentSound = getCurrentSound(sound);
        if (!currentSound?.available)
            return { ok: false, reason: "unavailable" };

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

        const actions = getNativeSoundboard();
        if (!actions.canPlay(user, currentSound, channel, true))
            return { ok: false, reason: "not-allowed" };

        // Discord's native action returns void and does not expose the server acknowledgement.
        actions.play(currentSound, channelId, []);
        return { ok: true };
    } catch (error) {
        logger.error("Native Soundboard playback failed", error);
        return { ok: false, reason: "api" };
    }
}
