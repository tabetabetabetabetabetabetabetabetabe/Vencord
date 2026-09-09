/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

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
import { filterSounds, GlobalSound, normalizeHistoryLimit, pushRecent, SoundTab } from "./model";
import { FallbackMode, OutputDeviceSetting, PlaybackMode, settings } from "./settings";
import {
    collectGlobalSounds,
    getCurrentSound,
    getNativePlayingSoundIds,
    playNative,
    refreshSoundboard,
    resolveSoundUrl,
    showFailure
} from "./soundboard";
import { loadPickerData, savePickerData } from "./storage";

const PAGE_SIZE = 240;
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
    onPreview(sound: GlobalSound): void;
    loading: boolean;
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
    onPreview,
    loading,
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
                    action={() => onPreview(sound)}
                    disabled={disabled}
                    id="vc-global-soundboard-preview"
                    label="プレビュー"
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
            className={`vc-gsb-card${playing ? " vc-gsb-card-playing" : ""}${loading ? " vc-gsb-card-loading" : ""}${!sound.available ? " vc-gsb-card-unavailable" : ""}`}
            onContextMenu={openContextMenu}
        >
            <button
                aria-label={`${sound.name} — ${sound.guildName}${loading ? "（読み込み中）" : playing ? "（再生中）" : ""}${sound.available ? "" : "（利用不可）"}`}
                className="vc-gsb-card-main"
                disabled={disabled}
                onClick={() => onPlay(sound)}
                title={`${sound.name} — ${sound.guildName}`}
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
                aria-label={`${sound.name}をこの端末でプレビュー`}
                className="vc-gsb-preview"
                disabled={disabled}
                onClick={() => onPreview(sound)}
                title="この端末でプレビュー"
                type="button"
            >
                ▶
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
    const userId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id ?? null);

    return userId
        ? <SoundboardPicker {...props} key={userId} userId={userId} />
        : <Modal {...props} title="Global Soundboard">Discordへログインすると利用できます。</Modal>;
}

function SoundboardPicker({ userId, ...props }: RenderModalProps & { userId: string; }) {
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
    const [storageStatus, setStorageStatus] = React.useState<"error" | "loading" | "ready">("loading");
    const [storageAttempt, setStorageAttempt] = React.useState(0);
    const [storageWriteFailed, setStorageWriteFailed] = React.useState(false);
    const [refreshAttempt, setRefreshAttempt] = React.useState(0);
    const [refreshStatus, setRefreshStatus] = React.useState<"error" | "loading" | "ready">("loading");
    const [page, setPage] = React.useState(0);
    const [localPlayback, setLocalPlayback] = React.useState<LocalPlayback | null>(null);
    const [nativeRequest, setNativeRequest] = React.useState("");
    const mountedRef = React.useRef(true);
    const listRef = React.useRef<HTMLDivElement>(null);
    const favoritesRef = React.useRef(favorites);
    const historyRef = React.useRef(history);
    const searchRef = React.useRef(search);
    const searchEditedRef = React.useRef(false);
    const storageReady = storageStatus === "ready";
    const storageReadyRef = React.useRef(storageReady);
    const rememberSearchRef = React.useRef(visibleSettings.rememberSearch);
    const stores = React.useMemo(() => [SoundboardStore, GuildStore].filter(Boolean), []);
    const allSounds = useStateFromStores(stores, collectGlobalSounds);
    const nativePlayingIds = useStateFromStores(
        SoundboardStore ? [SoundboardStore] : [],
        getNativePlayingSoundIds,
        undefined,
        (previous, next) => previous.length === next.length && previous.every((id, index) => id === next[index])
    );
    const nativePlaying = React.useMemo(() => new Set(nativePlayingIds), [nativePlayingIds]);
    const historyLimit = normalizeHistoryLimit(visibleSettings.historyLimit);
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

    const saveData = React.useCallback((name: "favorites" | "history" | "search", value: string[] | string | null) => {
        void savePickerData(userId, name, value).catch(error => {
            if (mountedRef.current) setStorageWriteFailed(true);
            showFailure("storage-write", "Global Soundboardの変更を保存できませんでした。画面の再試行から保存できます。", error);
        });
    }, [userId]);

    React.useEffect(() => {
        let active = true;
        setStorageStatus("loading");
        void loadPickerData(userId, historyLimit).then(saved => {
            if (!active) return;
            favoritesRef.current = saved.favorites;
            historyRef.current = saved.history;
            setFavorites(saved.favorites);
            setHistory(saved.history);
            setStorageWriteFailed(saved.unsavedChanges);
            if (rememberSearchRef.current && !searchEditedRef.current) setSearch(saved.search);
            setStorageStatus("ready");
        }).catch(error => {
            if (!active) return;
            showFailure("storage-read", "Global Soundboardの保存データを読み込めませんでした。", error);
            setStorageStatus("error");
        });

        return () => {
            active = false;
        };
    }, [storageAttempt, userId]);

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
    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            stopCurrentSound();
        };
    }, []);

    React.useEffect(() => {
        if (!storageReady) return;
        if (!visibleSettings.rememberSearch) {
            saveData("search", null);
            return;
        }

        const timeout = window.setTimeout(() => {
            saveData("search", search);
        }, 300);
        return () => window.clearTimeout(timeout);
    }, [saveData, search, storageReady, visibleSettings.rememberSearch]);

    React.useEffect(() => () => {
        if (!storageReadyRef.current || !rememberSearchRef.current) return;
        saveData("search", searchRef.current);
    }, [saveData]);

    React.useEffect(() => {
        if (outputSupported) return;
        if (visibleSettings.playbackMode === "output") settings.store.playbackMode = "preview";
        if (visibleSettings.fallbackMode === "output") settings.store.fallbackMode = "preview";
    }, [outputSupported, visibleSettings.fallbackMode, visibleSettings.playbackMode]);

    React.useEffect(() => {
        setPage(0);
        if (listRef.current) listRef.current.scrollTop = 0;
    }, [deferredSearch, guildId, tab, visibleSettings.showUnavailable]);

    React.useEffect(() => {
        if (!storageReady || history.length <= historyLimit) return;
        const next = history.slice(0, historyLimit);
        historyRef.current = next;
        setHistory(next);
        saveData("history", next);
    }, [history, historyLimit, saveData, storageReady]);

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

    React.useEffect(() => {
        if (guildId !== "all" && !guildOptions.some(option => option.value === guildId)) setGuildId("all");
    }, [guildId, guildOptions]);

    const filteredSounds = React.useMemo(() => filterSounds(allSounds, {
        favorites,
        guildId,
        history,
        query: deferredSearch,
        showUnavailable: visibleSettings.showUnavailable,
        tab
    }), [allSounds, deferredSearch, favorites, guildId, history, tab, visibleSettings.showUnavailable]);
    // Keep the mounted card count bounded, including after browsing thousands of sounds.
    const pageCount = Math.max(1, Math.ceil(filteredSounds.length / PAGE_SIZE));
    const currentPage = Math.min(page, pageCount - 1);
    const visibleSounds = filteredSounds.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

    React.useEffect(() => {
        if (listRef.current) listRef.current.scrollTop = 0;
        if (page !== currentPage) setPage(currentPage);
    }, [currentPage, page]);
    const knownFavorites = React.useMemo(
        () => allSounds.reduce((count, sound) => count + Number(favorites.has(sound.key)), 0),
        [allSounds, favorites]
    );
    const knownHistory = React.useMemo(() => {
        const keys = new Set(allSounds.map(sound => sound.key));
        return history.reduce((count, key) => count + Number(keys.has(key)), 0);
    }, [allSounds, history]);

    const recordHistory = React.useCallback((sound: GlobalSound) => {
        if (!mountedRef.current || !storageReadyRef.current) return;
        const next = pushRecent(historyRef.current, sound.key, historyLimit);
        historyRef.current = next;
        setHistory(next);
        saveData("history", next);
    }, [historyLimit, saveData]);

    const toggleFavorite = React.useCallback((sound: GlobalSound) => {
        if (!mountedRef.current || !storageReadyRef.current) return;
        const next = new Set(favoritesRef.current);
        next.has(sound.key) ? next.delete(sound.key) : next.add(sound.key);
        favoritesRef.current = next;
        setFavorites(next);
        saveData("favorites", Array.from(next));
    }, [saveData]);

    const retrySave = async () => {
        try {
            await Promise.all([
                savePickerData(userId, "favorites", Array.from(favoritesRef.current)),
                savePickerData(userId, "history", historyRef.current),
                savePickerData(userId, "search", rememberSearchRef.current ? searchRef.current : null)
            ]);
            if (mountedRef.current) setStorageWriteFailed(false);
        } catch (error) {
            showFailure("storage-write", "Global Soundboardの変更を保存できませんでした。", error);
        }
    };

    const playLocal = React.useCallback(async (sound: GlobalSound, mode: "output" | "preview") => {
        try {
            const played = await playLocalSound(sound, resolveSoundUrl(sound.soundId), mode, visibleSettings.masterVolume);
            if (played) recordHistory(sound);
        } catch (error) {
            if (!mountedRef.current) return;
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

    const playSound = React.useCallback(async (clickedSound: GlobalSound, forcedMode?: PlaybackMode) => {
        if (!mountedRef.current) return;
        setNativeRequest("");
        const sound = getCurrentSound(clickedSound);
        if (!sound) {
            showFailure("sound-deleted", "このSoundは削除されたか、サーバーから利用できなくなりました。");
            return;
        }
        if (!sound.available) {
            showFailure("sound-unavailable", "このSoundはDiscord上で利用できません。");
            return;
        }

        const mode = forcedMode ?? visibleSettings.playbackMode as PlaybackMode;
        if (mode !== "native") {
            await playLocal(sound, mode);
            return;
        }

        stopCurrentSound();
        const result = playNative(sound);
        if (result.ok) {
            recordHistory(sound);
            setNativeRequest(`${sound.name}：Discordへ再生を要求しました。送信先での再生完了は確認できません。`);
            return;
        }

        if (result.reason === "not-connected") {
            showFailure("native-not-connected", "Native Discord再生にはVCへの参加が必要です。");
        } else {
            showFailure("native-rejected", "Discord側でこのサウンドを直接再生できません。Audio Outputモードを使用できます。");
        }

        const fallback = visibleSettings.fallbackMode as FallbackMode;
        if (fallback !== "disabled") await playLocal(sound, fallback);
    }, [playLocal, recordHistory, visibleSettings.fallbackMode, visibleSettings.playbackMode]);

    const filterGuild = React.useCallback((sound: GlobalSound) => {
        setGuildId(sound.guildId);
        setTab("all");
    }, []);
    const playSoundCard = React.useCallback((sound: GlobalSound) => {
        void playSound(sound);
    }, [playSound]);
    const previewSoundCard = React.useCallback((sound: GlobalSound) => {
        void playSound(sound, "preview");
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
                        maxLength={1024}
                        onChange={value => {
                            searchEditedRef.current = true;
                            setSearch(value);
                        }}
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
                            <span>ローカル音量</span>
                            <input
                                aria-label="Audio Outputとプレビューの音量"
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

                <div className="vc-gsb-playback-help">
                    <p>{visibleSettings.playbackMode === "native"
                        ? "カード本体：Discord標準のVC再生を要求します。VC参加・権限が必要で、他サーバーの音はNitroなどの利用条件に従います。"
                        : visibleSettings.playbackMode === "output"
                            ? "カード本体：下の出力デバイスへ再生します。VCへ送るには仮想ケーブルなどの設定が必要です。マイク音声の自動混合は行いません。"
                            : "カード本体：この端末の既定の出力デバイスで試聴します。"}</p>
                    <p>小さい▶は常にローカル試聴です。ローカル音量・停止はAudio Outputと試聴に適用されます。</p>
                    {visibleSettings.playbackMode === "native" && <p>
                        フォールバック：{visibleSettings.fallbackMode === "disabled"
                            ? "無効"
                            : visibleSettings.fallbackMode === "output" ? "Audio Output" : "Local Preview"}（純正の事前判定失敗時のみ）。履歴にはVCへの再生要求も含まれます。
                    </p>}
                    {visibleSettings.playbackMode === "output" && <OutputDeviceSetting compact />}
                    <div aria-live="polite" className="vc-gsb-playback-status" role="status">
                        {localPlayback
                            ? `${localPlayback.mode === "output" ? "Audio Output" : "ローカル試聴"}：${localPlayback.status === "loading" ? "読み込み中…（停止できます）" : "再生中"}`
                            : nativeRequest}
                    </div>
                </div>

                <div className="vc-gsb-list" ref={listRef}>
                    {storageStatus === "loading" && <div aria-live="polite" className="vc-gsb-storage-status" role="status">
                        お気に入り・履歴を読み込んでいます。再生は利用できます。
                    </div>}
                    {storageStatus === "error" && <div aria-live="polite" className="vc-gsb-refresh-error" role="status">
                        <span>保存データを読み込めませんでした。再生は利用できますが、お気に入りの変更と履歴の保存は停止しています。</span>
                        <Button onClick={() => setStorageAttempt(attempt => attempt + 1)} size="small" variant="secondary">
                            読み込みを再試行
                        </Button>
                    </div>}
                    {storageWriteFailed && <div aria-live="polite" className="vc-gsb-refresh-error" role="status">
                        <span>未保存の変更があります。この画面を閉じる前に保存を再試行してください。</span>
                        <Button onClick={() => void retrySave()} size="small" variant="secondary">
                            保存を再試行
                        </Button>
                    </div>}
                    {refreshStatus === "error" && <div aria-live="polite" className="vc-gsb-refresh-error" role="status">
                        <span>Soundboard一覧を更新できませんでした。保存済み一覧があればそのまま利用できます。</span>
                        <Button onClick={() => setRefreshAttempt(attempt => attempt + 1)} size="small" variant="secondary">
                            再試行
                        </Button>
                    </div>}

                    {!SoundboardStore
                        ? <div aria-live="polite" className="vc-gsb-empty" role="status">SoundboardStoreが見つかりません。Discord更新後にVencordを更新してください。</div>
                        : refreshStatus === "loading" && allSounds.length === 0
                            ? <div aria-live="polite" className="vc-gsb-empty" role="status">Soundboardを読み込んでいます…</div>
                            : refreshStatus === "error" && allSounds.length === 0
                                ? null
                                : visibleSounds.length === 0
                                    ? <div aria-live="polite" className="vc-gsb-empty" role="status">条件に一致するSoundはありません。</div>
                                : <div className="vc-gsb-grid">
                                    {visibleSounds.map(sound => <SoundCard
                                        disabled={!sound.available}
                                        favorite={favorites.has(sound.key)}
                                        favoriteDisabled={!storageReady}
                                        filterGuild={filterGuild}
                                        key={sound.key}
                                        loading={localPlayback?.key === sound.key && localPlayback.status === "loading"}
                                        onPlay={playSoundCard}
                                        onPreview={previewSoundCard}
                                        playing={localPlayback?.key === sound.key && localPlayback.status === "playing" || nativePlaying.has(sound.soundId)}
                                        showEmoji={visibleSettings.showEmoji}
                                        showGuildIcons={visibleSettings.showGuildIcons}
                                        sound={sound}
                                        toggleFavorite={toggleFavorite}
                                    />)}
                                </div>}

                </div>
                {pageCount > 1 && <div aria-label="サウンド一覧のページ" className="vc-gsb-pagination">
                    <Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} size="small" variant="secondary">
                        前へ
                    </Button>
                    <span aria-live="polite">{currentPage + 1} / {pageCount} ページ（{filteredSounds.length.toLocaleString()}件）</span>
                    <Button disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)} size="small" variant="secondary">
                        次へ
                    </Button>
                </div>}
            </div>
        </Modal>
    );
}
