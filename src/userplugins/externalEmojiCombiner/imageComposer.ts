/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IconUtils } from "@webpack/common";
import { GIFEncoder, nearestColorIndex, quantize } from "gifenc";

const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_DIMENSION = 4096;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_WIDTH = 4096;
const MAX_OUTPUT_PIXELS = 1_000_000;
const MAX_DECODED_PIXELS = 32_000_000;
const MAX_TOTAL_FRAME_PIXELS = 40_000_000;
const MAX_DECODE_FRAMES_PER_EMOJI = 150;
const MAX_FRAMES = 150;
const MAX_DURATION_MS = 10_000;
const MAX_FPS = 25;
const DEFAULT_FRAME_DURATION_MS = 50;

export interface EmojiImage {
    animated: boolean;
    id: string;
}

export interface ComposeOptions {
    gap: number;
    preserveAnimation: boolean;
    size: number;
}

export interface ComposeResult {
    animationError?: unknown;
    animationFallback: boolean;
    file: File;
}

interface DecodedFrame {
    bitmap: ImageBitmap;
    endMs: number;
    startMs: number;
}

interface DecodedSequence {
    animated: boolean;
    durationMs: number;
    frames: DecodedFrame[];
}

function sourceKey(emoji: EmojiImage) {
    return `${emoji.id}:${emoji.animated}`;
}

async function fetchEmoji(emoji: EmojiImage) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
        const response = await fetch(IconUtils.getEmojiURL({
            animated: emoji.animated,
            id: emoji.id,
            size: 128
        }), { signal: controller.signal });

        if (!response.ok)
            throw new Error(`Emoji CDN returned HTTP ${response.status}`);

        const declaredSize = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredSize) && declaredSize > MAX_SOURCE_BYTES)
            throw new Error("Emoji source exceeds the download limit");

        const blob = await response.blob();
        if (blob.size > MAX_SOURCE_BYTES)
            throw new Error("Emoji source exceeds the download limit");

        return blob.type
            ? blob
            : new Blob([blob], { type: emoji.animated ? "image/gif" : "image/png" });
    } finally {
        window.clearTimeout(timeout);
    }
}

async function fetchSources(emojis: EmojiImage[]) {
    const unique = new Map<string, EmojiImage>();
    for (const emoji of emojis) unique.set(sourceKey(emoji), emoji);

    const pending = [...unique];
    const entries: Array<readonly [string, Blob]> = [];
    let totalBytes = 0;

    for (let i = 0; i < pending.length; i += 4) {
        const batch = await Promise.all(pending.slice(i, i + 4).map(async ([key, emoji]) => [key, await fetchEmoji(emoji)] as const));
        entries.push(...batch);
        totalBytes += batch.reduce((total, [, blob]) => total + blob.size, 0);

        if (totalBytes > MAX_TOTAL_SOURCE_BYTES)
            throw new Error("Combined emoji sources exceed the download limit");
    }

    return new Map(entries);
}

function getOutputSize(emojiCount: number, { gap, size }: ComposeOptions) {
    const width = emojiCount * size + Math.max(0, emojiCount - 1) * gap;
    const pixels = width * size;

    if (width > MAX_OUTPUT_WIDTH || pixels > MAX_OUTPUT_PIXELS)
        throw new Error("Combined emoji image exceeds the output size limit");

    return { height: size, width };
}

function createCanvas(width: number, height: number) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

async function resizeBitmap(source: ImageBitmapSource, width: number, height: number, size: number) {
    const scale = Math.min(size / width, size / height);
    return createImageBitmap(source, {
        resizeHeight: Math.max(1, Math.round(height * scale)),
        resizeQuality: "high",
        resizeWidth: Math.max(1, Math.round(width * scale))
    });
}

async function decodeStatic(blob: Blob, size: number): Promise<DecodedSequence> {
    const original = await createImageBitmap(blob);

    try {
        if (original.width > MAX_SOURCE_DIMENSION || original.height > MAX_SOURCE_DIMENSION)
            throw new Error("Emoji dimensions exceed the decode limit");

        const bitmap = await resizeBitmap(original, original.width, original.height, size);
        return {
            animated: false,
            durationMs: 0,
            frames: [{ bitmap, endMs: Infinity, startMs: 0 }]
        };
    } finally {
        original.close();
    }
}

async function decodeAnimation(blob: Blob, size: number, frameLimit: number): Promise<DecodedSequence> {
    if (typeof ImageDecoder === "undefined" || !await ImageDecoder.isTypeSupported(blob.type))
        throw new Error(`Animated ${blob.type || "image"} decoding is unavailable`);

    const decoder = new ImageDecoder({
        data: await blob.arrayBuffer(),
        preferAnimation: true,
        type: blob.type
    });
    const frames: DecodedFrame[] = [];

    try {
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack;
        if (!track || track.frameCount < 2)
            throw new Error("Animated emoji has fewer than two frames");

        let elapsed = 0;
        const count = Math.min(track.frameCount, frameLimit);

        for (let i = 0; i < count && elapsed < MAX_DURATION_MS; i++) {
            const { image } = await decoder.decode({ completeFramesOnly: true, frameIndex: i });

            try {
                if (image.displayWidth > MAX_SOURCE_DIMENSION || image.displayHeight > MAX_SOURCE_DIMENSION)
                    throw new Error("Emoji frame dimensions exceed the decode limit");

                const duration = Math.max(20, Math.round((image.duration ?? DEFAULT_FRAME_DURATION_MS * 1000) / 1000));
                const endMs = Math.min(MAX_DURATION_MS, elapsed + duration);
                const bitmap = await resizeBitmap(image, image.displayWidth, image.displayHeight, size);
                frames.push({ bitmap, endMs, startMs: elapsed });
                elapsed = endMs;
            } finally {
                image.close();
            }
        }

        if (frames.length < 2)
            throw new Error("Animated emoji could not provide two usable frames");

        return { animated: true, durationMs: elapsed, frames };
    } catch (error) {
        for (const frame of frames) frame.bitmap.close();
        throw error;
    } finally {
        decoder.close();
    }
}

function closeSequences(sequences: Iterable<DecodedSequence>) {
    for (const sequence of sequences)
        for (const frame of sequence.frames)
            frame.bitmap.close();
}

async function decodeSources(emojis: EmojiImage[], sources: Map<string, Blob>, size: number, animated: boolean) {
    const sequences = new Map<string, DecodedSequence>();
    const uniqueAnimatedCount = new Set(emojis.filter(emoji => emoji.animated).map(sourceKey)).size;
    const frameLimit = uniqueAnimatedCount === 0
        ? MAX_DECODE_FRAMES_PER_EMOJI
        : Math.max(2, Math.min(
            MAX_DECODE_FRAMES_PER_EMOJI,
            Math.floor(MAX_DECODED_PIXELS / (size * size * uniqueAnimatedCount))
        ));

    try {
        for (const emoji of emojis) {
            const key = sourceKey(emoji);
            if (sequences.has(key)) continue;

            const blob = sources.get(key);
            if (!blob) throw new Error("Downloaded emoji source is missing");

            sequences.set(key, animated && emoji.animated
                ? await decodeAnimation(blob, size, frameLimit)
                : await decodeStatic(blob, size));
        }

        return sequences;
    } catch (error) {
        closeSequences(sequences.values());
        throw error;
    }
}

function drawSequence(
    context: CanvasRenderingContext2D,
    sequence: DecodedSequence,
    x: number,
    size: number,
    timeMs: number
) {
    const localTime = sequence.animated ? timeMs % sequence.durationMs : 0;
    const frame = sequence.frames.find(frame => localTime >= frame.startMs && localTime < frame.endMs) ?? sequence.frames.at(-1)!;
    const offsetX = x + (size - frame.bitmap.width) / 2;
    const offsetY = (size - frame.bitmap.height) / 2;
    context.drawImage(frame.bitmap, offsetX, offsetY);
}

function drawCombinedFrame(
    context: CanvasRenderingContext2D,
    emojis: EmojiImage[],
    sequences: Map<string, DecodedSequence>,
    options: ComposeOptions,
    timeMs: number
) {
    context.clearRect(0, 0, context.canvas.width, context.canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";

    emojis.forEach((emoji, index) => {
        drawSequence(
            context,
            sequences.get(sourceKey(emoji))!,
            index * (options.size + options.gap),
            options.size,
            timeMs
        );
    });
}

function canvasToFile(canvas: HTMLCanvasElement, name: string) {
    return new Promise<File>((resolve, reject) => {
        canvas.toBlob(blob => {
            if (!blob) reject(new Error("Canvas PNG encoding failed"));
            else if (blob.size > MAX_OUTPUT_BYTES) reject(new Error("Combined PNG exceeds the file size limit"));
            else resolve(new File([blob], name, { type: "image/png" }));
        }, "image/png");
    });
}

async function composeStatic(emojis: EmojiImage[], sources: Map<string, Blob>, options: ComposeOptions) {
    const { height, width } = getOutputSize(emojis.length, options);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");

    const sequences = await decodeSources(emojis, sources, options.size, false);

    try {
        drawCombinedFrame(context, emojis, sequences, options, 0);
        return await canvasToFile(canvas, `combined-emojis-${Date.now()}.png`);
    } finally {
        closeSequences(sequences.values());
    }
}

function greatestCommonDivisor(a: number, b: number) {
    while (b !== 0) [a, b] = [b, a % b];
    return a;
}

function getTimeline(sequences: Iterable<DecodedSequence>, pixelsPerFrame: number) {
    const animated = [...sequences].filter(sequence => sequence.animated);
    const durationUnits = animated.map(sequence => Math.max(1, Math.round(sequence.durationMs / 10)));
    let totalUnits = durationUnits[0];

    for (const duration of durationUnits.slice(1)) {
        const combined = totalUnits / greatestCommonDivisor(totalUnits, duration) * duration;
        totalUnits = Math.min(MAX_DURATION_MS / 10, combined);
    }

    const durationMs = Math.min(MAX_DURATION_MS, totalUnits * 10);
    const shortestFrame = Math.min(...animated.flatMap(sequence => sequence.frames.map(frame => frame.endMs - frame.startMs)));
    const preferredFrames = Math.max(2, Math.floor(durationMs / Math.max(1000 / MAX_FPS, shortestFrame)));
    const pixelLimitedFrames = Math.floor(MAX_TOTAL_FRAME_PIXELS / pixelsPerFrame);
    const frameCount = Math.max(1, Math.min(MAX_FRAMES, preferredFrames, pixelLimitedFrames));

    if (frameCount < 2) throw new Error("Animated output exceeds the frame pixel limit");
    return { delayMs: Math.max(1000 / MAX_FPS, durationMs / frameCount), durationMs, frameCount };
}

function applyTransparentPalette(data: Uint8ClampedArray, palette: number[][]) {
    const indexes = new Uint8Array(data.length / 4);
    const cache = new Int16Array(2 ** 16);
    cache.fill(-1);

    for (let i = 0; i < indexes.length; i++) {
        const offset = i * 4;
        if (data[offset + 3] < 128) {
            indexes[i] = 255;
            continue;
        }

        const key = ((data[offset] << 8) & 0xf800) | ((data[offset + 1] << 3) & 0x07e0) | (data[offset + 2] >> 3);
        const cached = cache[key];
        indexes[i] = cached >= 0
            ? cached
            : cache[key] = nearestColorIndex(palette, [data[offset], data[offset + 1], data[offset + 2]]);
    }

    return indexes;
}

async function composeAnimated(emojis: EmojiImage[], sources: Map<string, Blob>, options: ComposeOptions) {
    const { height, width } = getOutputSize(emojis.length, options);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas 2D is unavailable");

    const sequences = await decodeSources(emojis, sources, options.size, true);

    try {
        const timeline = getTimeline(sequences.values(), width * height);
        const gif = GIFEncoder();
        const deadline = performance.now() + 15_000;

        for (let i = 0; i < timeline.frameCount; i++) {
            if (performance.now() > deadline) throw new Error("Animated image encoding timed out");

            drawCombinedFrame(context, emojis, sequences, options, i * timeline.durationMs / timeline.frameCount);
            const { data } = context.getImageData(0, 0, width, height);
            const palette = quantize(data, 255);
            const indexes = applyTransparentPalette(data, palette);

            gif.writeFrame(indexes, width, height, {
                delay: timeline.delayMs,
                dispose: 2,
                palette,
                repeat: 0,
                transparent: true,
                transparentIndex: 255
            });

            if (gif.bytesView().byteLength > MAX_OUTPUT_BYTES)
                throw new Error("Combined GIF exceeds the file size limit");
            if (i % 8 === 7)
                await new Promise<void>(resolve => setTimeout(resolve, 0));
        }

        gif.finish();
        const bytes = Uint8Array.from(gif.bytesView());
        if (bytes.byteLength > MAX_OUTPUT_BYTES)
            throw new Error("Combined GIF exceeds the file size limit");

        return new File([bytes.buffer], `combined-emojis-${Date.now()}.gif`, { type: "image/gif" });
    } finally {
        closeSequences(sequences.values());
    }
}

export async function composeEmojiImage(emojis: EmojiImage[], options: ComposeOptions): Promise<ComposeResult> {
    const sources = await fetchSources(emojis);
    const shouldAnimate = options.preserveAnimation && emojis.some(emoji => emoji.animated);

    if (shouldAnimate) {
        try {
            return {
                animationFallback: false,
                file: await composeAnimated(emojis, sources, options)
            };
        } catch (animationError) {
            return {
                animationError,
                animationFallback: true,
                file: await composeStatic(emojis, sources, options)
            };
        }
    }

    return {
        animationFallback: false,
        file: await composeStatic(emojis, sources, options)
    };
}
