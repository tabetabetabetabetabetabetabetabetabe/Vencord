/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { makeRange, OptionType } from "@utils/types";
import { Forms, React, Select } from "@webpack/common";

import {
    enumerateAudioOutputs,
    getSelectedOutputDevice,
    loadSelectedOutputDevice,
    selectOutputDevice,
    setCurrentMasterVolume,
    supportsOutputSelection
} from "./audio";
import { showFailure } from "./soundboard";

export type PlaybackMode = "native" | "output" | "preview";
export type FallbackMode = "disabled" | "output" | "preview";

// Discord's Select declaration currently mistypes aria-label as boolean.
const selectAriaLabel = (label: string) => ({ "aria-label": label }) as unknown as { "aria-label": boolean; };

function OutputDeviceSetting() {
    const [devices, setDevices] = React.useState<{ label: string; value: string; }[]>([]);
    const [selected, setSelected] = React.useState(getSelectedOutputDevice());
    const [loading, setLoading] = React.useState(true);
    const supported = supportsOutputSelection();

    const refresh = React.useCallback(async () => {
        if (!supported) {
            setLoading(false);
            return;
        }

        try {
            await loadSelectedOutputDevice();
            const outputs = await enumerateAudioOutputs();
            const options = [
                { label: "Default", value: "default" },
                ...outputs
                    .filter(device => device.deviceId !== "default")
                    .map(device => ({ label: device.label, value: device.deviceId }))
            ];
            let nextSelected = getSelectedOutputDevice();
            if (nextSelected !== "default" && !options.some(option => option.value === nextSelected)) {
                nextSelected = "default";
                await selectOutputDevice(nextSelected);
                showFailure("device-missing", "選択した出力デバイスが見つからないため、Defaultへ戻しました。");
            }
            setSelected(nextSelected);
            setDevices(options);
        } catch (error) {
            showFailure("device-list", "オーディオ出力デバイスを取得できませんでした。", error);
        } finally {
            setLoading(false);
        }
    }, [supported]);

    React.useEffect(() => {
        void refresh();
        if (!supported) return;

        navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
        return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
    }, [refresh, supported]);

    return (
        <div>
            <Forms.FormTitle>Audio Output Device</Forms.FormTitle>
            {!supported
                ? <Forms.FormText>この環境ではsetSinkIdによる出力先の選択を利用できません。</Forms.FormText>
                : <Select
                    {...selectAriaLabel("Audio Output Device")}
                    closeOnSelect
                    isDisabled={loading}
                    isSelected={value => value === selected}
                    options={devices}
                    placeholder={loading ? "Loading devices…" : "Select an output device"}
                    select={async value => {
                        try {
                            await selectOutputDevice(value);
                            setSelected(value);
                        } catch (error) {
                            showFailure("device-save", "出力デバイス設定を保存できませんでした。", error);
                        }
                    }}
                    serialize={String}
                />}
            <Forms.FormText>選択したデバイスIDはこの端末のDataStoreだけに保存され、外部へ送信しません。</Forms.FormText>
        </div>
    );
}

export const settings = definePluginSettings({
    playbackMode: {
        type: OptionType.SELECT,
        description: "How cards play Soundboard sounds.",
        displayName: "Playback Mode",
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
        component: OutputDeviceSetting
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
