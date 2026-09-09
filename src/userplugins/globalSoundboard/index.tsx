/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import definePlugin, { IconComponent } from "@utils/types";
import { closeModal, openModal } from "@webpack/common";

import { disposeAudio, initializeAudio, supportsOutputSelection } from "./audio";
import { GlobalSoundboardModal } from "./GlobalSoundboardModal";
import { settings } from "./settings";

let modalKey: string | null = null;

const GlobalSoundboardIcon: IconComponent = ({ className, height = 20, width = 20 }) => (
    <svg
        aria-hidden="true"
        className={className}
        fill="none"
        height={height}
        viewBox="0 0 24 24"
        width={width}
    >
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2" />
        <path d="M3.8 9h16.4M3.8 15h16.4M12 3.5c2.2 2.3 3.3 5.1 3.3 8.5S14.2 18.2 12 20.5M12 3.5C9.8 5.8 8.7 8.6 8.7 12s1.1 6.2 3.3 8.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
        <path d="m17.2 15.4 1.7-1v4.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
);

export function openGlobalSoundboard() {
    if (modalKey) return;

    modalKey = openModal(
        props => <GlobalSoundboardModal {...props} />,
        { onCloseCallback: () => modalKey = null }
    );
}

const GlobalSoundboardButton: ChatBarButtonFactory = ({ isAnyChat }) => {
    if (!isAnyChat) return null;

    return (
        <ChatBarButton
            buttonProps={{ "aria-haspopup": "dialog" }}
            onClick={openGlobalSoundboard}
            tooltip="Global Soundboard"
        >
            <GlobalSoundboardIcon />
        </ChatBarButton>
    );
};

function handleKeydown(event: KeyboardEvent) {
    if (!settings.store.keyboardShortcut
        || event.repeat
        || event.defaultPrevented
        || event.code !== "KeyB"
        || !event.ctrlKey
        || !event.shiftKey
        || event.altKey
        || event.metaKey
    ) return;

    const { target } = event;
    if (target instanceof HTMLElement && (
        target.isContentEditable
        || target.tagName === "INPUT"
        || target.tagName === "TEXTAREA"
        || target.tagName === "SELECT"
    )) return;

    event.preventDefault();
    openGlobalSoundboard();
}

export default definePlugin({
    name: "GlobalSoundboard",
    description: "Search, filter, and play Soundboard sounds from every server in one place.",
    tags: ["Voice", "Utility"],
    authors: [{ id: 0n, name: "tabetabetabetabetabetabetabetabetabe" }],
    settings,

    chatBarButton: {
        icon: GlobalSoundboardIcon,
        render: GlobalSoundboardButton
    },

    toolboxActions: {
        "Global Soundboard": openGlobalSoundboard
    },

    start() {
        document.addEventListener("keydown", handleKeydown);
        if (!supportsOutputSelection()) {
            if (settings.store.playbackMode === "output") settings.store.playbackMode = "preview";
            if (settings.store.fallbackMode === "output") settings.store.fallbackMode = "preview";
        }
        initializeAudio();
    },

    stop() {
        document.removeEventListener("keydown", handleKeydown);
        if (modalKey) closeModal(modalKey);
        modalKey = null;
        disposeAudio();
    }
});
