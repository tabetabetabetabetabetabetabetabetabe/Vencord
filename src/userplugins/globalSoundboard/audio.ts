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
    status: "loading" | "playing";
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
let outputDeviceWrites: Promise<void> = Promise.resolve();
let outputDeviceRevision = 0;
let outputRefreshRevision = 0;
let audioGeneration = 0;
let initialized = false;
const listeners = new Set<(playing: LocalPlayback | null) => void>();
const outputDeviceListeners = new Set<(deviceId: string) => void>();

function emit(playing: LocalPlayback | null) {
    current = playing;
    listeners.forEach(listener => listener(playing));
}

function calculateVolume(masterVolume: number) {
    const master = Number.isFinite(masterVolume) ? Math.min(200, Math.max(0, masterVolume)) : 100;
    return Math.min(1, Math.max(0, currentSoundVolume * master / 100));
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
        && typeof HTMLAudioElement.prototype.setSinkId === "function";
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
    if (outputDeviceLoaded) return outputDeviceLoaded;

    const revision = outputDeviceRevision;
    const generation = audioGeneration;
    const pending = outputDeviceWrites
        .catch(() => undefined)
        .then(() => DataStore.get<string>(OUTPUT_DEVICE_KEY))
        .then(saved => {
            if (generation !== audioGeneration || revision !== outputDeviceRevision) return;
            selectedOutputDevice = typeof saved === "string" && saved ? saved : "default";
            outputDeviceListeners.forEach(listener => listener(selectedOutputDevice));
        })
        .catch(error => {
            if (outputDeviceLoaded === pending) outputDeviceLoaded = null;
            throw error;
        });
    outputDeviceLoaded = pending;
    return pending;
}

function saveOutputDevice(deviceId: string, cancelPlayback: boolean) {
    const next = typeof deviceId === "string" && deviceId ? deviceId : "default";
    if (cancelPlayback && next !== selectedOutputDevice && current?.mode === "output") stopCurrentSound();
    selectedOutputDevice = next;
    outputDeviceRevision++;
    // An explicit choice supersedes a pending read, including after a failed read.
    outputDeviceLoaded = Promise.resolve();
    outputDeviceListeners.forEach(listener => listener(next));
    outputDeviceWrites = outputDeviceWrites
        .catch(() => undefined)
        .then(() => DataStore.set(OUTPUT_DEVICE_KEY, next));
    return outputDeviceWrites;
}

export function selectOutputDevice(deviceId: string) {
    return saveOutputDevice(deviceId, true);
}

export function subscribeOutputDevice(listener: (deviceId: string) => void) {
    outputDeviceListeners.add(listener);
    listener(selectedOutputDevice);
    return () => {
        outputDeviceListeners.delete(listener);
    };
}

export async function refreshAudioOutputs(): Promise<OutputDevice[]> {
    if (!supportsOutputSelection()) return [];

    const refreshRevision = ++outputRefreshRevision;
    const generation = audioGeneration;
    await loadSelectedOutputDevice();
    const revision = outputDeviceRevision;
    const selected = selectedOutputDevice;
    const outputs = await enumerateAudioOutputs();
    if (generation !== audioGeneration || refreshRevision !== outputRefreshRevision || revision !== outputDeviceRevision)
        return outputs;

    if (selected !== "default" && !outputs.some(device => device.deviceId === selected)) {
        await selectOutputDevice("default");
        if (generation === audioGeneration && selectedOutputDevice === "default" && outputDeviceRevision === revision + 1)
            showFailure("device-missing", "選択した出力デバイスが見つからないため、再生を停止してDefaultへ戻しました。");
    }
    return outputs;
}

function handleDeviceChange() {
    const generation = audioGeneration;
    void refreshAudioOutputs().catch(error => {
        if (initialized && generation === audioGeneration)
            showFailure("device-list", "オーディオ出力デバイスを取得できませんでした。", error);
    });
}

export function initializeAudio() {
    if (initialized) return;
    initialized = true;
    if (supportsOutputSelection()) {
        navigator.mediaDevices.addEventListener?.("devicechange", handleDeviceChange);
        handleDeviceChange();
    } else {
        const generation = audioGeneration;
        void loadSelectedOutputDevice().catch(error => {
            if (initialized && generation === audioGeneration)
                showFailure("device-load", "出力デバイス設定を読み込めませんでした。", error);
        });
    }
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

async function setOutput(audioElement: HTMLAudioElement, mode: LocalPlayback["mode"], token: number) {
    const setSinkId = audioElement.setSinkId?.bind(audioElement);
    if (mode === "preview") {
        await setSinkId?.("");
        return;
    }
    if (!supportsOutputSelection() || !setSinkId)
        throw new Error("Audio output selection is unavailable in this client");

    await loadSelectedOutputDevice();
    if (token !== currentToken) return;
    const revision = outputDeviceRevision;
    const sinkId = selectedOutputDevice === "default" ? "" : selectedOutputDevice;
    try {
        await setSinkId(sinkId);
    } catch (error) {
        const missing = error instanceof DOMException && error.name === "NotFoundError";
        if (sinkId === "" || !missing) throw error;
        if (token !== currentToken || revision !== outputDeviceRevision) return;

        await saveOutputDevice("default", false);
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

    const finish = () => {
        if (token !== currentToken) return;
        currentToken++;
        if (audio === audioElement) audio = null;
        stopAudioElement(audioElement);
        emit(null);
    };
    audioElement.onended = finish;
    audioElement.onpause = finish;
    audioElement.onerror = () => {
        if (token !== currentToken) return;
        finish();
        showFailure("audio-decode", "Soundの取得またはデコードに失敗しました。");
    };
    emit({ key: sound.key, mode, status: "loading" });

    try {
        audioElement.preload = "auto";
        audioElement.src = url;
        audioElement.volume = calculateVolume(masterVolume);
        await setOutput(audioElement, mode, token);
        if (token !== currentToken) {
            stopAudioElement(audioElement);
            return false;
        }
        await audioElement.play();
    } catch (error) {
        const cancelled = token !== currentToken;
        finish();
        stopAudioElement(audioElement);
        if (cancelled) return false;
        throw error;
    }
    if (token !== currentToken) {
        stopAudioElement(audioElement);
        return false;
    }

    emit({ key: sound.key, mode, status: "playing" });
    return true;
}

export function disposeAudio() {
    initialized = false;
    audioGeneration++;
    outputRefreshRevision++;
    if (typeof navigator !== "undefined")
        navigator.mediaDevices?.removeEventListener?.("devicechange", handleDeviceChange);
    stopCurrentSound();
    listeners.clear();
    outputDeviceListeners.clear();
    outputDeviceLoaded = null;
    audio = null;
}
