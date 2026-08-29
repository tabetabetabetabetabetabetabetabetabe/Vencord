/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const CUSTOM_EMOJI_TOKEN = /(?<!\\)<(a?):(\w+):(\d+)>|(?<![\\!])\[([^\]\r\n]*)\]\((https?:\/\/[^\s)]+)\)|(?<![\\(<])((?:https?:\/\/)[^\s<>()]+)/gi;
const DISCORD_EMOJI_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const CODE_SPAN = /```[\s\S]*?```|`[^`\r\n]*`/g;

export interface EmojiToken {
    animated: boolean;
    end: number;
    id: string;
    name: string;
    raw: string;
    start: number;
}

function parseEmojiUrl(value: string) {
    try {
        const url = new URL(value);
        if (!DISCORD_EMOJI_HOSTS.has(url.hostname)) return null;

        const path = url.pathname.match(/^\/emojis\/(\d+)\.(png|webp|gif)$/i);
        if (!path) return null;

        return {
            animated: path[2].toLowerCase() === "gif" || url.searchParams.get("animated") === "true",
            id: path[1],
            name: url.searchParams.get("name") || "emoji"
        };
    } catch {
        return null;
    }
}

export function parseEmojiTokens(content: string): EmojiToken[] {
    const tokens: EmojiToken[] = [];
    const codeRanges = [...content.matchAll(CODE_SPAN)].map(match => ({
        end: match.index + match[0].length,
        start: match.index
    }));

    for (const match of content.matchAll(CUSTOM_EMOJI_TOKEN)) {
        const start = match.index;
        if (codeRanges.some(range => start >= range.start && start < range.end)) continue;

        const url = match[5] ?? match[6];
        const parsed = url
            ? parseEmojiUrl(url)
            : { animated: match[1] === "a", id: match[3], name: match[2] };

        if (!parsed) continue;

        tokens.push({
            ...parsed,
            end: start + match[0].length,
            raw: match[0],
            start
        });
    }

    return tokens;
}

export function removeEmojiTokens(content: string, tokens: EmojiToken[]) {
    const ranges: Array<{ end: number; start: number; }> = [];

    for (const token of tokens) {
        const previous = ranges.at(-1);
        if (previous && /^\s*$/.test(content.slice(previous.end, token.start)))
            previous.end = token.end;
        else
            ranges.push({ end: token.end, start: token.start });
    }

    let cursor = 0;
    let result = "";

    for (const range of ranges) {
        let { end, start } = range;
        if (end < content.length && /[ \t]/.test(content[end]))
            while (end < content.length && /[ \t]/.test(content[end])) end++;
        else
            while (start > cursor && /[ \t]/.test(content[start - 1])) start--;

        if (start < cursor) continue;

        result += content.slice(cursor, start);
        cursor = end;
    }

    return result + content.slice(cursor);
}
