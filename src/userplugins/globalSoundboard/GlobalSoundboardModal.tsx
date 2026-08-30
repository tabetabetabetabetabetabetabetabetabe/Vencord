/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Button } from "@components/Button";
import { copyWithToast } from "@utils/discord";
import type { RenderModalProps } from "@vencord/discord-types";
import {
    ContextMenuApi,
    GuildStore,
    IconUtils,
    Menu,
    Modal,
    React,
    Select,
    SoundboardStore,
    TextInput,
    UserStore,
    useStateFromStores } from "@webpack/common";
import type { MouseEvent } from "react";

import {
    LocalPlayback,
    OutputDeviceMissingError,
    playLocalSound,
    stopCurrentSound,
    subscribeLocalPlayback,
    supportsOutputSelection
} from "./audio";
import { filterSounds, GlobalSound, pushRecent, SoundTab } from "./model";
import { FallbackMode, PlaybackMode, settings } from "./settings";
import {
    collectGlobalSounds,
    playNative,
    refreshSoundboard,
    resolveSoundUrl,
    showFailure,
    soundStillExists
} from "./soundboard";

const INITIAL_RENDER_LIMIT = 240;
const PLAYBACK_OPTIONS = [
    { label: "Native Discord", value: "native" },
    { label: "Audio Output", value: "output" },
    { label: "Local Preview", value: "preview" }
] as const;

// Discord's Select declaration currently mistypes aria-label as boolean.
const selectAriaLabel = (label: string) => ({ "aria-label": label }) as unknown as { "aria-label": boolean; };

interface GuildOption {
    count: number;
    icon?: string;
    label: string;
    value: string;
}

function getDataKey(name: "favorites" | "history" | "search") {
    return `GlobalSoundboard_${UserStore.getCurrentUser()?.id ?? "unknown"}_${name}`;
}

function SoundEmoji({ sound }: { sound: GlobalSound; }) {
    if (sound.emojiId) {
        return <img
            alt={sound.emojiName ?? ""}
            className="vc-gsb-emoji"
            loading="lazy"
            src={IconUtils.getEmojiURL({ animated: false, id: sound.emojiId, size: 32 })}
        />;
    }

    return <span aria-hidden="true" className="vc-gsb-emoji-text">{sound.emojiName || "♪"}</span>;
}

interface SoundCardProps {
    disabled: boolean;
    favorite: boolean;
    favoriteDisabled: boolean;
    filterGuild(sound: GlobalSound): void;
    onPlay(sound: GlobalSound): void;
    playing: boolean;
    showEmoji: boolean;
    showGuildIcons: boolean;
    sound: GlobalSound;
    toggleFavorite(sound: GlobalSound): void;
}

function SoundCard({
    disabled,
    favorite,
    favoriteDisabled,
    filterGuild,
    onPlay,
    playing,
    showEmoji,
    showGuildIcons,
    sound,
    toggleFavorite
}: SoundCardProps) {
    const openContextMenu = (event: MouseEvent<HTMLElement>) => {
        ContextMenuApi.openContextMenu(event, () => (
            <Menu.Menu
                aria-label="Global Soundboard"
                navId="vc-global-soundboard-context"
                onClose={ContextMenuApi.closeContextMenu}
            >
                <Menu.MenuItem
                    action={() => onPlay(sound)}
                    disabled={disabled}
                    id="vc-global-soundboard-play"
                    label="再生"
                />
                <Menu.MenuItem
                    action={() => toggleFavorite(sound)}
                    disabled={favoriteDisabled}
                    id="vc-global-soundboard-favorite"
                    label={favorite ? "お気に入りから削除" : "お気に入りに追加"}
                />
                <Menu.MenuItem
                    action={() => filterGuild(sound)}
                    id="vc-global-soundboard-filter-guild"
                    label="このサーバーだけ表示"
                />
                <Menu.MenuItem
                    action={() => copyWithToast(sound.soundId, "Sound IDをコピーしました。")}
                    id="vc-global-soundboard-copy-id"
                    label="Sound IDをコピー"
                />
            </Menu.Menu>
        ));
    };

    return (
        <article
            className={`vc-gsb-card${playing ? " vc-gsb-card-playing" : ""}${!sound.available ? " vc-gsb-card-unavailable" : ""}`}
            onContextMenu={openContextMenu}
        >
            <button
                aria-label={`${sound.name} — ${sound.guildName}${playing ? "（再生中）" : ""}${sound.available ? "" : "（利用不可）"}`}
                className="vc-gsb-card-main"
                disabled={disabled}
                onClick={() => onPlay(sound)}
                type="button"
            >
                {showEmoji && <SoundEmoji sound={sound} />}
                <span className="vc-gsb-card-copy">
                    <span className="vc-gsb-sound-name">{sound.name}</span>
                    <span className="vc-gsb-guild-name">
                        {showGuildIcons && sound.guildIcon
                            ? <img alt="" className="vc-gsb-guild-icon" loading="lazy" src={sound.guildIcon} />
                            : showGuildIcons && <span aria-hidden="true" className="vc-gsb-guild-fallback">{sound.guildName.slice(0, 1)}</span>}
                        {sound.guildName}
                    </span>
                    {!sound.available && <span className="vc-gsb-unavailable-label">利用不可</span>}
                </span>
            </button>
            <button
                aria-label={favorite ? `${sound.name}をお気に入りから削除` : `${sound.name}をお気に入りに追加`}
                aria-pressed={favorite}
                className={`vc-gsb-favorite${favorite ? " vc-gsb-favorite-active" : ""}`}
                disabled={favoriteDisabled}
                onClick={() => toggleFavorite(sound)}
                title={favorite ? "お気に入りから削除" : "お気に入りに追加"}
                type="button"
            >
                {favorite ? "★" : "☆"}
            </button>
        </article>
    );
}

export function GlobalSoundboardModal(props: RenderModalProps) {
    const visibleSettings = settings.use([
        "fallbackMode",
        "historyLimit",
        "masterVolume",
        "playbackMode",
        "rememberSearch",
        "showEmoji",
        "showGuildIcons",
        "showUnavailable"
    ]);
    const [search, setSearch] = React.useState("");
    const deferredSearch = React.useDeferredValue(search);
    const [guildId, setGuildId] = React.useState("all");
    const [tab, setTab] = React.useState<SoundTab>("all");
    const [favorites, setFavorites] = React.useState<Set<string>>(new Set());
    const [history, setHistory] = React.useState<string[]>([]);
    const [storageReady, setStorageReady] = React.useState(false);
    const [refreshAttempt, setRefreshAttempt] = React.useState(0);
    const [refreshStatus, setRefreshStatus] = React.useState<"error" | "loading" | "ready">("loading");
    const [visibleLimit, setVisibleLimit] = React.useState(INITIAL_RENDER_LIMIT);
    const [localPlayback, setLocalPlayback] = React.useState<LocalPlayback | null>(null);
    const writeQueue = React.useRef<Promise<unknown>>(Promise.resolve());
    const searchRef = React.useRef(search);
    const storageReadyRef = React.useRef(storageReady);
    const rememberSearchRef = React.useRef(visibleSettings.rememberSearch);
    const stores = React.useMemo(() => [SoundboardStore, GuildStore].filter(Boolean), []);
    const allSounds = useStateFromStores(stores, collectGlobalSounds);
    const nativePlayingIds = useStateFromStores(
        SoundboardStore ? [SoundboardStore] : [],
        () => {
            const playing: string[] = [];
            for (const sounds of SoundboardStore?.getSounds?.()?.values?.() ?? []) {
                for (const sound of sounds) {
                    if (SoundboardStore.isPlayingSound(sound.soundId)) playing.push(sound.soundId);
                }
            }
            return playing.sort();
        },
        undefined,
        (previous, next) => previous.length === next.length && previous.every((id, index) => id === next[index])
    );
    const nativePlaying = React.useMemo(() => new Set(nativePlayingIds), [nativePlayingIds]);
    const historyLimit = Math.min(100, Math.max(1, Math.floor(visibleSettings.historyLimit)));
    const outputSupported = supportsOutputSelection();
    const playbackOptions = React.useMemo(() => PLAYBACK_OPTIONS.map(option => ({
        ...option,
        disabled: option.value === "output" && !outputSupported,
        label: option.value === "output" && !outputSupported
            ? "Audio Output（setSinkId非対応）"
            : option.label
    })), [outputSupported]);

    searchRef.current = search;
    storageReadyRef.current = storageReady;
    rememberSearchRef.current = visibleSettings.rememberSearch;

    const queueWrite = React.useCallback((operation: () => Promise<unknown>) => {
        writeQueue.current = writeQueue.current
            .catch(() => undefined)
            .then(operation)
            .catch(error => showFailure("storage-write", "Global Soundboardのデータを保存できませんでした。", error));
    }, []);

    React.useEffect(() => {
        let active = true;
        void Promise.all([
            DataStore.get<string[]>(getDataKey("favorites")),
            DataStore.get<string[]>(getDataKey("history")),
            DataStore.get<string>(getDataKey("search"))
        ]).then(([savedFavorites, savedHistory, savedSearch]) => {
            if (!active) return;
            setFavorites(new Set(Array.isArray(savedFavorites) ? savedFavorites.filter(key => typeof key === "string") : []));
            setHistory(Array.isArray(savedHistory)
                ? Array.from(new Set(savedHistory.filter(key => typeof key === "string"))).slice(0, historyLimit)
                : []);
            if (visibleSettings.rememberSearch && typeof savedSearch === "string") setSearch(savedSearch);
            setStorageReady(true);
        }).catch(error => {
            if (!active) return;
            showFailure("storage-read", "Global Soundboardの保存データを読み込めませんでした。", error);
            setStorageReady(true);
        });

        return () => {
            active = false;
        };
    }, []);

    React.useEffect(() => {
        let active = true;
        setRefreshStatus("loading");
        void refreshSoundboard()
            .then(() => {
                if (active) setRefreshStatus("ready");
            })
            .catch(error => {
                if (!active) return;
                setRefreshStatus("error");
                showFailure("fetch", "DiscordからSoundboard一覧を取得できませんでした。", error);
            });
        return () => {
            active = false;
        };
    }, [refreshAttempt]);

    React.useEffect(() => subscribeLocalPlayback(setLocalPlayback), []);
    React.useEffect(() => () => stopCurrentSound(), []);

    React.useEffect(() => {
        if (!storageReady) return;
        if (!visibleSettings.rememberSearch) {
            queueWrite(() => DataStore.del(getDataKey("search")));
            return;
        }

        const timeout = window.setTimeout(() => {
            queueWrite(() => DataStore.set(getDataKey("search"), search));
        }, 300);
        return () => window.clearTimeout(timeout);
    }, [queueWrite, search, storageReady, visibleSettings.rememberSearch]);

    React.useEffect(() => () => {
        if (!storageReadyRef.current || !rememberSearchRef.current) return;
        queueWrite(() => DataStore.set(getDataKey("search"), searchRef.current));
    }, [queueWrite]);

    React.useEffect(() => {
        if (outputSupported) return;
        if (visibleSettings.playbackMode === "output") settings.store.playbackMode = "preview";
        if (visibleSettings.fallbackMode === "output") settings.store.fallbackMode = "preview";
    }, [outputSupported, visibleSettings.fallbackMode, visibleSettings.playbackMode]);

    React.useEffect(() => {
        setVisibleLimit(INITIAL_RENDER_LIMIT);
    }, [deferredSearch, guildId, tab, visibleSettings.showUnavailable]);

    React.useEffect(() => {
        if (!storageReady || history.length <= historyLimit) return;
        const next = history.slice(0, historyLimit);
        setHistory(next);
        queueWrite(() => DataStore.set(getDataKey("history"), next));
    }, [history, historyLimit, queueWrite, storageReady]);

    const guildOptions = React.useMemo<GuildOption[]>(() => {
        const counts = new Map<string, GuildOption>();
        for (const sound of allSounds) {
            const existing = counts.get(sound.guildId);
            if (existing) existing.count++;
            else counts.set(sound.guildId, {
                count: 1,
                icon: sound.guildIcon,
                label: sound.guildName,
                value: sound.guildId
            });
        }

        return [
            { count: allSounds.length, label: "すべてのサーバー", value: "all" },
            ...Array.from(counts.values()).sort((left, right) => left.label.localeCompare(right.label))
        ];
    }, [allSounds]);

    const filteredSounds = React.useMemo(() => filterSounds(allSounds, {
        favorites,
        guildId,
        history,
        query: deferredSearch,
        showUnavailable: visibleSettings.showUnavailable,
        tab
    }), [allSounds, deferredSearch, favorites, guildId, history, tab, visibleSettings.showUnavailable]);
    const visibleSounds = filteredSounds.slice(0, visibleLimit);
    const knownFavorites = React.useMemo(
        () => allSounds.reduce((count, sound) => count + Number(favorites.has(sound.key)), 0),
        [allSounds, favorites]
    );
    const knownHistory = React.useMemo(() => {
        const keys = new Set(allSounds.map(sound => sound.key));
        return history.reduce((count, key) => count + Number(keys.has(key)), 0);
    }, [allSounds, history]);

    const recordHistory = React.useCallback((sound: GlobalSound) => {
        setHistory(previous => {
            const next = pushRecent(previous, sound.key, historyLimit);
            queueWrite(() => DataStore.set(getDataKey("history"), next));
            return next;
        });
    }, [historyLimit, queueWrite]);

    const toggleFavorite = React.useCallback((sound: GlobalSound) => {
        if (!storageReady) return;
        setFavorites(previous => {
            const next = new Set(previous);
            next.has(sound.key) ? next.delete(sound.key) : next.add(sound.key);
            queueWrite(() => DataStore.set(getDataKey("favorites"), Array.from(next)));
            return next;
        });
    }, [queueWrite, storageReady]);

    const playLocal = React.useCallback(async (sound: GlobalSound, mode: "output" | "preview") => {
        try {
            const played = await playLocalSound(sound, resolveSoundUrl(sound.soundId), mode, visibleSettings.masterVolume);
            if (played) recordHistory(sound);
        } catch (error) {
            const deviceMissing = error instanceof OutputDeviceMissingError;
            showFailure(
                deviceMissing ? "device-missing" : `play-${mode}`,
                deviceMissing
                    ? error.message
                    : mode === "output"
                        ? "選択したオーディオ出力へ再生できませんでした。"
                        : "ローカルプレビューを再生できませんでした。",
                error
            );
        }
    }, [recordHistory, visibleSettings.masterVolume]);

    const playSound = React.useCallback(async (sound: GlobalSound) => {
        if (!storageReady) return;
        if (!soundStillExists(sound)) {
            showFailure("sound-deleted", "このSoundは削除されたか、サーバーから利用できなくなりました。");
            return;
        }
        if (!sound.available) {
            showFailure("sound-unavailable", "このSoundはDiscord上で利用できません。");
            return;
        }

        const mode = visibleSettings.playbackMode as PlaybackMode;
        if (mode !== "native") {
            await playLocal(sound, mode);
            return;
        }

        const result = playNative(sound);
        if (result.ok) {
            recordHistory(sound);
            return;
        }

        if (result.reason === "not-connected") {
            showFailure("native-not-connected", "Native Discord再生にはVCへの参加が必要です。");
        } else {
            showFailure("native-rejected", "Discord側でこのサウンドを直接再生できません。Audio Outputモードを使用できます。");
        }

        const fallback = visibleSettings.fallbackMode as FallbackMode;
        if (fallback !== "disabled") await playLocal(sound, fallback);
    }, [playLocal, recordHistory, storageReady, visibleSettings.fallbackMode, visibleSettings.playbackMode]);

    const filterGuild = React.useCallback((sound: GlobalSound) => {
        setGuildId(sound.guildId);
        setTab("all");
    }, []);
    const playSoundCard = React.useCallback((sound: GlobalSound) => {
        void playSound(sound);
    }, [playSound]);

    return (
        <Modal
            {...props}
            size="xl"
            subtitle={`${filteredSounds.length.toLocaleString()} / ${allSounds.length.toLocaleString()} Sounds${refreshStatus === "loading" ? " — 取得中…" : refreshStatus === "error" ? " — 更新失敗" : ""}`}
            title="Global Soundboard"
        >
            <div className="vc-gsb-root">
                <div className="vc-gsb-controls">
                    <TextInput
                        aria-label="Soundを検索"
                        disabled={!storageReady}
                        maxLength={null}
                        onChange={setSearch}
                        placeholder="サウンド名・サーバー名・絵文字で検索"
                        value={search}
                    />
                    <Select
                        {...selectAriaLabel("サーバーフィルター")}
                        closeOnSelect
                        isSelected={value => value === guildId}
                        maxVisibleItems={8}
                        options={guildOptions}
                        renderOptionLabel={option => {
                            const guild = option as GuildOption;
                            return <span className="vc-gsb-guild-option">
                                {visibleSettings.showGuildIcons && guild.icon && <img alt="" src={guild.icon} />}
                                <span>{guild.label}</span>
                                <span className="vc-gsb-option-count">{guild.count}</span>
                            </span>;
                        }}
                        select={setGuildId}
                        serialize={String}
                    />
                </div>

                <div className="vc-gsb-toolbar">
                    <div aria-label="Sound一覧" className="vc-gsb-tabs">
                        <button aria-pressed={tab === "all"} onClick={() => setTab("all")} type="button">
                            すべて <span>{allSounds.length}</span>
                        </button>
                        <button aria-pressed={tab === "favorites"} onClick={() => setTab("favorites")} type="button">
                            ★ お気に入り <span>{knownFavorites}</span>
                        </button>
                        <button aria-pressed={tab === "history"} onClick={() => setTab("history")} type="button">
                            履歴 <span>{knownHistory}</span>
                        </button>
                    </div>

                    <div className="vc-gsb-playback-controls">
                        <Select
                            {...selectAriaLabel("再生モード")}
                            closeOnSelect
                            isSelected={value => value === visibleSettings.playbackMode}
                            options={playbackOptions}
                            select={value => settings.store.playbackMode = value as PlaybackMode}
                            serialize={String}
                        />
                        <label className="vc-gsb-volume">
                            <span>音量</span>
                            <input
                                aria-label="Master Volume"
                                max={200}
                                min={0}
                                onChange={event => settings.store.masterVolume = Number(event.currentTarget.value)}
                                step={1}
                                type="range"
                                value={visibleSettings.masterVolume}
                            />
                            <output>{Math.round(visibleSettings.masterVolume)}%</output>
                        </label>
                        <Button
                            disabled={!localPlayback}
                            onClick={stopCurrentSound}
                            size="small"
                            variant="secondary"
                        >
                            ローカル停止
                        </Button>
                    </div>
                </div>

                <div className="vc-gsb-list">
                    {refreshStatus === "error" && <div aria-live="polite" className="vc-gsb-refresh-error" role="status">
                        <span>Soundboard一覧を更新できませんでした。保存済み一覧があればそのまま利用できます。</span>
                        <Button onClick={() => setRefreshAttempt(attempt => attempt + 1)} size="small" variant="secondary">
                            再試行
                        </Button>
                    </div>}

                    {!SoundboardStore
                        ? <div aria-live="polite" className="vc-gsb-empty" role="status">SoundboardStoreが見つかりません。Discord更新後にVencordを更新してください。</div>
                        : !storageReady || refreshStatus === "loading" && allSounds.length === 0
                            ? <div aria-live="polite" className="vc-gsb-empty" role="status">Soundboardを読み込んでいます…</div>
                            : refreshStatus === "error" && allSounds.length === 0
                                ? null
                                : visibleSounds.length === 0
                                    ? <div aria-live="polite" className="vc-gsb-empty" role="status">条件に一致するSoundはありません。</div>
                                : <div className="vc-gsb-grid">
                                    {visibleSounds.map(sound => <SoundCard
                                        disabled={!storageReady || !sound.available}
                                        favorite={favorites.has(sound.key)}
                                        favoriteDisabled={!storageReady}
                                        filterGuild={filterGuild}
                                        key={sound.key}
                                        onPlay={playSoundCard}
                                        playing={localPlayback?.key === sound.key || nativePlaying.has(sound.soundId)}
                                        showEmoji={visibleSettings.showEmoji}
                                        showGuildIcons={visibleSettings.showGuildIcons}
                                        sound={sound}
                                        toggleFavorite={toggleFavorite}
                                    />)}
                                </div>}

                    {filteredSounds.length > visibleLimit && <Button
                        className="vc-gsb-more"
                        onClick={() => setVisibleLimit(limit => limit + INITIAL_RENDER_LIMIT)}
                        variant="secondary"
                    >
                        さらに表示（残り {(filteredSounds.length - visibleLimit).toLocaleString()}件）
                    </Button>}
                </div>
            </div>
        </Modal>
    );
}
