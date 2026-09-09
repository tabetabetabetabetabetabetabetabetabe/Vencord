/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawnSync } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function isDiscordRunning() {
    const tasks = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq Discord.exe", "/FO", "CSV", "/NH"], {
        encoding: "utf8", windowsHide: true
    });
    if (tasks.error || tasks.status !== 0 || !tasks.stdout.trim()) throw new Error("Discordの起動状態を確認できません。");
    return /^"Discord\.exe"/mi.test(tasks.stdout);
}

// Run only on demand. Never stop a running Discord or download an official replacement build.
try {
    if (process.platform !== "win32") throw new Error("この復旧手順はWindows用です。");
    if (!process.env.LOCALAPPDATA) throw new Error("LOCALAPPDATAを確認できません。");
    if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("利用できる引数は--checkだけです。");
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const dist = join(repo, "dist");
    const installer = join(dist, "Installer", "VencordInstallerCli.exe");
    const discord = join(process.env.LOCALAPPDATA, "Discord");
    if (!existsSync(installer)) throw new Error("既存のVencordInstallerCli.exeがありません。自動ダウンロードは行いません。");
    for (const file of ["patcher.js", "renderer.js", "preload.js", "renderer.css", "package.json"]) {
        const info = statSync(join(dist, file));
        if (!info.isFile() || !info.size) throw new Error(`ビルドが不完全です: ${file}。先にpnpm.cmd buildCustomを実行してください。`);
    }
    const patcher = readFileSync(join(dist, "patcher.js"), "utf8");
    const renderer = readFileSync(join(dist, "renderer.js"), "utf8");
    if (!patcher.slice(0, 2048).includes("Updater Disabled: true"))
        throw new Error("先にpnpm.cmd buildCustomを実行してください。通常buildでは上書き防止が有効になりません。");
    for (const plugin of ["ExternalEmojiCombiner", "GlobalSoundboard"])
        if (!renderer.includes(`name:"${plugin}"`)) throw new Error(`ビルドに${plugin}がありません。`);

    const appDirectories = readdirSync(discord, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.startsWith("app-"))
        .map(entry => entry.name);
    const versions = appDirectories.filter(name => /^app-\d+(?:\.\d+)+$/.test(name))
        .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
    const latest = versions.at(-1);
    if (!latest) throw new Error("Discordのインストール先を確認できません。");
    // The cached official CLI sorts these paths lexically; fail before it can modify a different version.
    if ([...appDirectories].sort().at(-1) !== latest)
        throw new Error("Discordの版選択がInstallerと一致しません。何も変更せず中止します。");
    const injection = join(discord, latest, "resources", "app.asar");
    if (!existsSync(injection) || !existsSync(join(discord, latest, "Discord.exe")))
        throw new Error("Discordの配置が想定と異なります。何も変更しません。");

    const running = isDiscordRunning();
    console.log(`導入するビルド: ${dist}\n対象: ${discord}\nDiscord起動中: ${running ? "はい" : "いいえ"}`);
    if (process.argv.includes("--check")) {
        console.log("確認のみ。ファイル変更、Discord終了、インストールは行っていません。");
    } else {
        if (running) throw new Error("通話を終え、通知領域のDiscordから「Quit Discord」で完全終了してから再実行してください。強制終了はしません。");
        const backup = join(dist, "custom-install-backups", new Date().toISOString().replaceAll(":", "-"));
        mkdirSync(backup, { recursive: true });
        copyFileSync(injection, join(backup, "app.asar"), constants.COPYFILE_EXCL);
        const original = join(discord, latest, "resources", "_app.asar");
        if (existsSync(original)) copyFileSync(original, join(backup, "_app.asar"), constants.COPYFILE_EXCL);
        console.log(`注入前のバックアップ: ${backup}`);
        if (isDiscordRunning()) throw new Error("準備中にDiscordが起動したため、導入を中止しました。");
        const result = spawnSync(installer, ["-install", "-location", discord], {
            cwd: repo,
            env: { ...process.env, VENCORD_USER_DATA_DIR: repo, VENCORD_DEV_INSTALL: "1" },
            stdio: "inherit",
            windowsHide: true
        });
        if (result.error || result.status !== 0) throw new Error("導入に失敗しました。上の結果とバックアップを確認してください。");
        const expected = JSON.stringify(join(dist, "patcher.js")).slice(1, -1);
        if (!readFileSync(injection).toString("utf8").includes(expected))
            throw new Error("注入先の検証に失敗しました。バックアップを保持しています。");
        console.log("2つのプラグインを含む固定ビルドへの導入を確認しました。Discordを起動してください。");
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
