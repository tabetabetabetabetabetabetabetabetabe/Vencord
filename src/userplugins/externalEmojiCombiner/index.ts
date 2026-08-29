/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { MessageObject, SendMessageOptions, SendMessageProps } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { makeRange, OptionType, StartAt } from "@utils/types";
import type { CloudUpload as TCloudUpload, CustomEmoji } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import { EmojiStore, GuildMemberStore, PermissionsBits, PermissionStore, showToast, Toasts, UserStore } from "@webpack/common";

import { EmojiToken, parseEmojiTokens, removeEmojiTokens, selectEmojiTokensToCombine } from "./emojiParser";
import { composeEmojiImage, EmojiImage } from "./imageComposer";

const logger = new Logger("ExternalEmojiCombiner");
const CloudUpload: typeof TCloudUpload = findLazy(module => module.prototype?.trackUploadFinished);
const inFlightChannels = new Set<string>();
const UPLOAD_TIMEOUT_MS = 60_000;

const settings = definePluginSettings({
    minimumEmojiCount: {
        default: 2,
        description: "Minimum number of custom emojis required before a message containing an external emoji is combined.",
        displayName: "Minimum Emoji Count",
        markers: makeRange(1, 20),
        stickToMarkers: false,
        type: OptionType.SLIDER
    },
    emojiSize: {
        description: "Width and height of each emoji tile.",
        displayName: "Emoji Size",
        options: [32, 48, 64, 96, 128].map(size => ({ default: size === 64, label: `${size}px`, value: size })),
        type: OptionType.SELECT
    },
    gap: {
        default: 4,
        description: "Transparent space between emoji tiles.",
        displayName: "Gap",
        markers: makeRange(0, 16),
        stickToMarkers: false,
        type: OptionType.SLIDER
    },
    mixedTextMode: {
        default: false,
        description: "When an external emoji triggers combining, remove all custom emojis from mixed text and send them as one image attachment.",
        displayName: "Mixed Text Mode",
        type: OptionType.BOOLEAN
    },
    preserveAnimation: {
        default: true,
        description: "Preserve animated emojis in a combined GIF when the client supports decoding them.",
        displayName: "Preserve Animation",
        type: OptionType.BOOLEAN
    },
    maxEmojis: {
        default: 20,
        description: "Maximum number of custom emojis allowed in one combined image.",
        displayName: "Max Emojis",
        markers: makeRange(1, 20),
        stickToMarkers: false,
        type: OptionType.SLIDER
    }
});

interface ResolvedToken {
    emoji?: CustomEmoji;
    image: EmojiImage;
    token: EmojiToken;
}

interface CombinePlan {
    content: string;
    emojis: EmojiImage[];
    ids: Set<string>;
}

type OptionsWithUploads = SendMessageOptions & {
    attachmentsToUpload?: TCloudUpload[];
};

function canUseEmojiNatively(emoji: CustomEmoji | undefined, props: SendMessageProps) {
    const guildId = props.channel.guild_id;
    if (!guildId || !emoji || emoji.available === false) return false;

    const hasNitro = (UserStore.getCurrentUser().premiumType ?? 0) > 0;
    const memberRoles = emoji.managed ? GuildMemberStore.getSelfMember(emoji.guildId)?.roles ?? [] : [];
    const hasManagedEmojiRole = emoji.managed && emoji.roles.some(role => memberRoles.includes(role));

    if (hasNitro || hasManagedEmojiRole)
        return emoji.guildId === guildId || PermissionStore.can(PermissionsBits.USE_EXTERNAL_EMOJIS, props.channel);

    return !emoji.animated && emoji.guildId === guildId;
}

function getCombinePlan(message: MessageObject, props: SendMessageProps): CombinePlan | null {
    const tokens = parseEmojiTokens(message.content);
    if (tokens.length === 0) return null;

    const parsedMessageContainsOnlyCustomEmojis = removeEmojiTokens(message.content, tokens).trim() === "";
    if (!settings.store.mixedTextMode && !parsedMessageContainsOnlyCustomEmojis) return null;

    const messageEmojis = new Map(message.validNonShortcutEmojis.map(emoji => [emoji.id, emoji]));
    const resolved: ResolvedToken[] = tokens.map(token => {
        const emoji = messageEmojis.get(token.id) ?? EmojiStore.getCustomEmojiById(token.id);
        return {
            emoji,
            image: {
                animated: emoji?.animated ?? token.animated,
                id: token.id
            },
            token
        };
    });
    const externalIds = new Set(resolved
        .filter(item => !canUseEmojiNatively(item.emoji, props))
        .map(item => item.token.id));
    const maximum = Math.min(20, Math.max(1, settings.store.maxEmojis));
    const minimum = Math.min(maximum, Math.max(1, settings.store.minimumEmojiCount));
    const combinedTokens = selectEmojiTokensToCombine(tokens, externalIds, minimum, maximum);

    if (!combinedTokens) return null;

    return {
        content: removeEmojiTokens(message.content, combinedTokens),
        emojis: resolved.map(item => item.image),
        ids: new Set(resolved.map(item => item.image.id))
    };
}

function uploadFile(upload: TCloudUpload) {
    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            window.clearTimeout(timeout);
            upload.removeListener("complete", complete);
            upload.removeListener("error", fail);
        };
        const complete = () => {
            cleanup();
            resolve();
        };
        const fail = (error: unknown) => {
            cleanup();
            reject(error instanceof Error ? error : new Error("Discord upload failed"));
        };
        const timeout = window.setTimeout(() => {
            cleanup();
            upload.once("error", () => { });

            try {
                upload.cancel();
            } catch { }

            reject(new Error("Discord upload timed out"));
        }, UPLOAD_TIMEOUT_MS);

        upload.once("complete", complete);
        upload.once("error", fail);
        try {
            void upload.upload().catch(fail);
        } catch (error) {
            fail(error);
        }
    });
}

export default definePlugin({
    name: "ExternalEmojiCombiner",
    description: "Combines custom emojis into a single uploaded image when a message contains an external emoji.",
    tags: ["Emotes", "Chat"],
    authors: [{ id: 0n, name: "tabetabetabetabetabetabetabetabetabe" }],
    dependencies: ["MessageEventsAPI"],
    requiresRestart: true,
    settings,
    startAt: StartAt.Init,

    async onBeforeMessageSend(channelId, message, options, props) {
        if (inFlightChannels.has(channelId)) return { cancel: true };

        let plan: CombinePlan | null;
        try {
            plan = getCombinePlan(message, props);
        } catch (error) {
            logger.error("Failed to prepare an emoji combination", error);
            showToast("Failed to combine emojis. Message was not modified.", Toasts.Type.FAILURE);
            return;
        }

        if (!plan) return;

        inFlightChannels.add(channelId);
        try {
            if (!props.channel.isPrivate() && !PermissionStore.can(PermissionsBits.ATTACH_FILES, props.channel))
                throw new Error("Missing permission to attach files in this channel");

            const result = await composeEmojiImage(plan.emojis, {
                gap: settings.store.gap,
                preserveAnimation: settings.store.preserveAnimation,
                size: settings.store.emojiSize
            });
            const upload = new CloudUpload({
                file: result.file,
                isThumbnail: false,
                platform: CloudUploadPlatform.WEB
            }, channelId);

            await uploadFile(upload);

            const sendOptions = options as OptionsWithUploads;
            (sendOptions.attachmentsToUpload ??= []).push(upload);
            message.content = plan.content;
            message.validNonShortcutEmojis = message.validNonShortcutEmojis.filter(emoji => !plan.ids.has(emoji.id));

            if (result.animationFallback) {
                logger.warn("Animated emoji decoding failed; used a static PNG instead", result.animationError);
                showToast("Animated emoji could not be preserved. Sent as a static image.", Toasts.Type.MESSAGE);
            }
        } catch (error) {
            logger.error("Failed to combine or upload emojis", error);
            showToast("Failed to combine emojis. Message was not modified.", Toasts.Type.FAILURE);
        } finally {
            inFlightChannels.delete(channelId);
        }
    }
});
