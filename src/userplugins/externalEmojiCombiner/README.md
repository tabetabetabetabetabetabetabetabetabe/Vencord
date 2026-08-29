# ExternalEmojiCombiner

ExternalEmojiCombiner turns custom emojis into one transparent image attachment when the message includes an external emoji. Select multiple emojis in Discord's normal emoji picker and press Enter or the Send button once; recipients see a normal PNG or GIF without installing Vencord.

By default, conversion runs when a message contains at least two custom emojis, includes at least one emoji Discord cannot send natively in that channel, and otherwise contains only custom emojis and whitespace. Once triggered, all custom emojis in that message—including emojis from the current server—are combined into the same image. Messages containing only natively usable emojis remain unchanged. In DMs, all custom emojis are treated as external.

## Installation

1. Place this directory at `src/userplugins/externalEmojiCombiner` in a current Vencord source checkout.
2. Run `pnpm install`, then `pnpm build` (or the normal Vencord build/install workflow).
3. Restart Discord, open Vencord Settings > Plugins, enable **ExternalEmojiCombiner**, and restart when prompted.

The plugin must start before FakeNitro's send hook, so changing its enabled state requires a restart.

## Settings

| Setting | Default | Behavior |
| --- | ---: | --- |
| Minimum Emoji Count | 2 | Required custom emoji count in the message, from 1 to 20. |
| Emoji Size | 64px | Square tile size: 32, 48, 64, 96, or 128px. |
| Gap | 4px | Transparent spacing between tiles, from 0 to 16px. |
| Mixed Text Mode | Off | Keeps non-emoji text in the message and moves all custom emojis into the attachment when combining is triggered. |
| Preserve Animation | On | Produces an animated GIF when any combined emoji is animated. |
| Max Emojis | 20 | Refuses conversion when the total number of custom emojis exceeds the configured limit. |

## FakeNitro compatibility

FakeNitro may stay enabled and is useful for making external emojis selectable without Nitro. The recommended setup is:

- **Enable Emoji Bypass:** On
- **ExternalEmojiCombiner:** On, followed by a Discord restart
- **Use Hyperlinks / Emoji Size:** Any value; eligible messages are combined before FakeNitro converts them

The plugin also recognizes FakeNitro's Discord CDN Markdown links and bare URLs as a fallback if hook order changes. Successfully combined emojis are removed from FakeNitro's pending emoji list to prevent URL conversion or an unnecessary embed-permission warning. Messages that do not meet the combination rules continue through FakeNitro normally.

## Animation and safety limits

Animated GIF, WebP, and APNG decoding uses Chromium's built-in `ImageDecoder`; GIF output uses Vencord's existing `gifenc` dependency. Different source frame rates share a capped timeline, and shorter animations loop while the combined GIF is generated. Static and animated emojis can be mixed.

Generation is bounded to 20 emojis, 2 MiB per source, 20 MiB total source data, 4096px source dimensions, 1 million output pixels, 10 seconds, 25 FPS, 150 output frames, 40 million encoded frame-pixels, an 8 MiB output file, and a 15-second GIF encoding budget. If animation decoding or GIF encoding is unavailable, the plugin sends a first-frame PNG and shows a toast.

## Limitations

- The channel must allow file attachments.
- The running Electron/Chromium build must expose `ImageDecoder` to preserve animation.
- If downloading, composing, or uploading fails, the original message and existing attachments are left unchanged and normal sending continues.
- Existing attachments are preserved, but Discord's own attachment-count and upload-size limits still apply.
- This plugin operates on new composer sends, not message edits.

Parser check on Windows: `.\node_modules\.bin\tsx.cmd src\userplugins\externalEmojiCombiner\emojiParser.test.ts`.
