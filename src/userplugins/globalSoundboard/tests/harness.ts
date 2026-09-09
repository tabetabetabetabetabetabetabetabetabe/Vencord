/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { build } from "esbuild";

const pluginDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Bundle the real implementation; replace only the Discord/browser boundaries. */
export async function loadModule<T>(
    relativeEntry: string,
    mocks: Record<string, object>,
    globals: Record<string, unknown> = {}
): Promise<T> {
    const result = await build({
        absWorkingDir: pluginDirectory,
        bundle: true,
        entryPoints: [resolve(pluginDirectory, relativeEntry)],
        format: "cjs",
        logLevel: "silent",
        platform: "node",
        plugins: [{
            name: "discord-test-boundaries",
            setup(builder) {
                builder.onResolve({ filter: /.*/ }, args =>
                    Object.hasOwn(mocks, args.path) ? { external: true, path: args.path } : undefined);
            }
        }],
        write: false
    });
    const module = { exports: {} };
    const require = createRequire(import.meta.url);
    runInNewContext(result.outputFiles[0].text, {
        console,
        DOMException,
        URL,
        clearTimeout,
        setTimeout,
        module,
        exports: module.exports,
        require: (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
        ...globals
    }, { filename: relativeEntry });
    return module.exports as T;
}

export function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}
