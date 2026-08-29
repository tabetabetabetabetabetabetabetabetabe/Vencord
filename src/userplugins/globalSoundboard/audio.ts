/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import type { GlobalSound } from "./model";
import { showFailure } from "./soundboard";

const OUTPUT_DEVICE_KEY = "GlobalSoundboard_outputDevice";

export interface OutputDevice {
    deviceId: string;
    label: string;
}

export interface LocalPlayback {
    key: string;
    mode: "output" | "preview";
}

export class OutputDeviceMissingError extends Error {
    constructor() {
        super("選択した出力デバイスが見つからないため、Defaultへ戻しました。もう一度再生してください。");
        this.name = "OutputDeviceMissingError";
    }
}

let audio: HTMLAudioElement | null = null;
let current: LocalPlayback | null = null;
let currentSoundVolume = 1;
let currentToken = 0;
let selectedOutputDevice = "default";
let outputDeviceLoaded: Promise<void> | null = null;
const listeners = new Set<(playing: LocalPlayback | null) => void>();

function emit(playing: LocalPlayback | null) {
    current = playing;
    listeners.forEach(listener => listener(playing));
}

function calculateVolume(masterVolume: number) {
    return Math.min(1, Math.max(0, currentSoundVolume * masterVolume / 100));
}

function applyVolume(masterVolume: number) {
    if (!audio) return;
    audio.volume = calculateVolume(masterVolume);
}

function stopAudioElement(audioElement: HTMLAudioElement) {
    audioElement.onended = null;
    audioElement.onerror = null;
    audioElement.onpause = null;
    audioElement.pause();
    audioElement.removeAttribute("src");
    audioElement.load();
}

export function supportsOutputSelection() {
    return typeof HTMLAudioElement !== "undefined"
        && typeof navigator !== "undefined"
        && navigator.mediaDevices?.enumerateDevices != null
        && "setSinkId" in HTMLAudioElement.prototype;
}

export async function enumerateAudioOutputs(): Promise<OutputDevice[]> {
    if (!supportsOutputSelection()) return [];

    const devices = await navigator.mediaDevices.enumerateDevices();
    let unnamed = 0;
    return devices
        .filter(device => device.kind === "audiooutput")
        .map(device => ({
            deviceId: device.deviceId,
            label: device.label || `Output Device ${++unnamed}`
        }));
}

export function getSelectedOutputDevice() {
    return selectedOutputDevice;
}

export function loadSelectedOutputDevice() {
    return outputDeviceLoaded ??= DataStore.get<string>(OUTPUT_DEVICE_KEY)
        .then(saved => {
            if (typeof saved === "string" && saved) selectedOutputDevice = saved;
        })
        .catch(error => showFailure("device-load", "出力デバイス設定を読み込めませんでした。", error));
}

export async function selectOutputDevice(deviceId: string) {
    const next = deviceId || "default";
    await DataStore.set(OUTPUT_DEVICE_KEY, next);
    selectedOutputDevice = next;
}

export function subscribeLocalPlayback(listener: (playing: LocalPlayback | null) => void) {
    listeners.add(listener);
    listener(current);
    return () => {
        listeners.delete(listener);
    };
}

export function setCurrentMasterVolume(masterVolume: number) {
    applyVolume(masterVolume);
}

export function stopCurrentSound() {
    currentToken++;
    const previousAudio = audio;
    audio = null;
    if (previousAudio) stopAudioElement(previousAudio);
    emit(null);
}

async function setOutput(audioElement: HTMLAudioElement, mode: LocalPlayback["mode"]) {
    const setSinkId = audioElement.setSinkId?.bind(audioElement);
    if (mode === "preview") {
        await setSinkId?.("");
        return;
    }
    if (!supportsOutputSelection() || !setSinkId)
        throw new Error("Audio output selection is unavailable in this client");

    await loadSelectedOutputDevice();
    const sinkId = selectedOutputDevice === "default" ? "" : selectedOutputDevice;
    try {
        await setSinkId(sinkId);
    } catch (error) {
        const missing = error instanceof DOMException && error.name === "NotFoundError";
        if (sinkId === "" || !missing) throw error;

        await selectOutputDevice("default");
        throw new OutputDeviceMissingError();
    }
}

export async function playLocalSound(
    sound: GlobalSound,
    url: string,
    mode: LocalPlayback["mode"],
    masterVolume: number
) {
    stopCurrentSound();
    const token = ++currentToken;
    const audioElement = new Audio();
    audio = audioElement;
    currentSoundVolume = Number.isFinite(sound.volume) ? sound.volume : 1;
    audioElement.preload = "auto";
    audioElement.src = url;
    audioElement.volume = calculateVolume(masterVolume);

    try {
        await setOutput(audioElement, mode);
    } catch (error) {
        if (audio === audioElement) audio = null;
        stopAudioElement(audioElement);
        if (token !== currentToken) return false;
        throw error;
    }
    if (token !== currentToken) {
        stopAudioElement(audioElement);
        return false;
    }

    const finish = () => {
        if (token !== currentToken) return;
        if (audio === audioElement) audio = null;
        stopAudioElement(audioElement);
        emit(null);
    };
    let started = false;
    audioElement.onended = finish;
    audioElement.onpause = finish;
    audioElement.onerror = () => {
        if (token !== currentToken) return;
        finish();
        if (started) showFailure("audio-decode", "Soundの取得またはデコードに失敗しました。");
    };

    try {
        await audioElement.play();
        started = true;
    } catch (error) {
        if (audio === audioElement) audio = null;
        stopAudioElement(audioElement);
        if (token !== currentToken) return false;
        throw error;
    }
    if (token !== currentToken) {
        stopAudioElement(audioElement);
        return false;
    }

    emit({ key: sound.key, mode });
    return true;
}

export function disposeAudio() {
    stopCurrentSound();
    listeners.clear();
    audio = null;
}
