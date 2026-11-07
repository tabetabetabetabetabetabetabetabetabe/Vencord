/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { makeRange, OptionType } from "@utils/types";
import { React, Select } from "@webpack/common";

import {
    getSelectedOutputDevice,
    refreshAudioOutputs,
    selectOutputDevice,
    setCurrentMasterVolume,
    stopCurrentSound,
    subscribeOutputDevice,
    supportsOutputSelection
} from "./audio";
import { showFailure } from "./soundboard";

export type PlaybackMode = "native" | "output" | "preview";
export type FallbackMode = "disabled" | "output" | "preview";

// Discord's Select declaration currently mistypes aria-label as boolean.
const selectAriaLabel = (label: string) => ({ "aria-label": label }) as unknown as { "aria-label": boolean; };

export function OutputDeviceSetting({ compact = false }: { compact?: boolean; }) {
    const [devices, setDevices] = React.useState<{ label: string; value: string; }[]>([]);
    const [selected, setSelected] = React.useState(getSelectedOutputDevice());
    const [loading, setLoading] = React.useState(true);
    const [failed, setFailed] = React.useState(false);
    const mounted = React.useRef(false);
    const request = React.useRef(0);
    const supported = supportsOutputSelection();

    const refresh = React.useCallback(async () => {
        const id = ++request.current;
        if (!supported) {
            setLoading(false);
            return;
        }

        setLoading(true);
        setFailed(false);
        try {
            const outputs = await refreshAudioOutputs();
            if (!mounted.current || id !== request.current) return;
            const options = [
                { label: "Default", value: "default" },
                ...outputs
                    .filter(device => device.deviceId && device.deviceId !== "default")
                    .map(device => ({ label: device.label, value: device.deviceId }))
            ];
            setSelected(getSelectedOutputDevice());
            setDevices(options);
        } catch (error) {
            if (!mounted.current || id !== request.current) return;
            setFailed(true);
            showFailure("device-list", "オーディオ出力デバイスを取得できませんでした。", error);
        } finally {
            if (mounted.current && id === request.current) setLoading(false);
        }
    }, [supported]);

    React.useEffect(() => {
        mounted.current = true;
        const unsubscribe = subscribeOutputDevice(setSelected);
        void refresh();
        if (supported) navigator.mediaDevices.addEventListener?.("devicechange", refresh);
        return () => {
            mounted.current = false;
            request.current++;
            unsubscribe();
            if (supported) navigator.mediaDevices.removeEventListener?.("devicechange", refresh);
        };
    }, [refresh, supported]);

    return (
        <div>
            {!compact && <Heading>Audio Output Device</Heading>}
            {!supported
                ? <Paragraph>この環境ではsetSinkIdによる出力先の選択を利用できません。</Paragraph>
                : <Select
                    {...selectAriaLabel("Audio Output Device")}
                    closeOnSelect
                    isDisabled={loading || failed}
                    isSelected={value => value === selected}
                    options={devices}
                    placeholder={loading ? "Loading devices…" : "Select an output device"}
                    select={async value => {
                        const id = ++request.current;
                        setLoading(true);
                        try {
                            await selectOutputDevice(value);
                        } catch (error) {
                            if (mounted.current && id === request.current)
                                showFailure("device-save", "出力先は変更しましたが、設定を保存できませんでした。再起動後に再選択してください。", error);
                        } finally {
                            if (mounted.current && id === request.current) {
                                setSelected(getSelectedOutputDevice());
                                setLoading(false);
                            }
                        }
                    }}
                    serialize={String}
                />}
            {failed && <Paragraph>出力先を確認できませんでした。再試行してください。</Paragraph>}
            {supported && <Button disabled={loading} onClick={() => void refresh()} size="small" variant="secondary">
                {failed ? "再試行" : "出力先を再読み込み"}
            </Button>}
            {!compact && <Paragraph>
                Audio Outputは選択した再生デバイスへ出力します。VCへ送るには仮想ケーブルなどをDiscordの入力に設定してください。マイクの混合は行いません。
                デバイスIDはこの端末のDataStoreだけに保存され、外部へ送信しません。
            </Paragraph>}
        </div>
    );
}

export const settings = definePluginSettings({
    playbackMode: {
        type: OptionType.SELECT,
        description: "How cards play Soundboard sounds.",
        displayName: "Playback Mode",
        onChange: stopCurrentSound,
        options: [
            { label: "Native Discord", value: "native", default: true },
            { label: "Audio Output", value: "output" },
            { label: "Local Preview", value: "preview" }
        ] as const
    },
    fallbackMode: {
        type: OptionType.SELECT,
        description: "What to use when Discord's native preflight rejects a sound.",
        displayName: "Fallback Mode",
        options: [
            { label: "Audio Output", value: "output" },
            { label: "Local Preview", value: "preview", default: true },
            { label: "Disabled", value: "disabled" }
        ] as const
    },
    outputDevice: {
        type: OptionType.COMPONENT,
        component: () => <OutputDeviceSetting />
    },
    masterVolume: {
        type: OptionType.SLIDER,
        description: "Local Audio Output and Preview volume. Quiet sounds can be boosted up to the browser's safe maximum.",
        displayName: "Master Volume",
        markers: makeRange(0, 200, 25),
        default: 100,
        stickToMarkers: false,
        onChange: setCurrentMasterVolume
    },
    rememberSearch: {
        type: OptionType.BOOLEAN,
        description: "Restore the last search text when the picker opens.",
        displayName: "Remember Search",
        default: true
    },
    showGuildIcons: {
        type: OptionType.BOOLEAN,
        description: "Show server icons in filters and sound cards.",
        displayName: "Show Guild Icons",
        default: true
    },
    showEmoji: {
        type: OptionType.BOOLEAN,
        description: "Show each sound's emoji when available.",
        displayName: "Show Emoji",
        default: true
    },
    showUnavailable: {
        type: OptionType.BOOLEAN,
        description: "Show unavailable sounds as disabled cards.",
        displayName: "Show Unavailable Sounds",
        default: true
    },
    historyLimit: {
        type: OptionType.NUMBER,
        description: "Maximum number of recently played sounds to keep (1–100).",
        displayName: "History Limit",
        default: 30,
        isValid: (value: number) => Number.isInteger(value) && value >= 1 && value <= 100 || "Enter a whole number from 1 to 100."
    },
    keyboardShortcut: {
        type: OptionType.BOOLEAN,
        description: "Open Global Soundboard with Ctrl + Shift + B outside text fields.",
        displayName: "Keyboard Shortcut",
        default: true
    }
});
