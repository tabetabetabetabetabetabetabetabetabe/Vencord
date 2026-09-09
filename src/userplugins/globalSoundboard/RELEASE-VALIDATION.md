# GlobalSoundboard 品質改善版の検証記録

検証日: 2026-09-05。対象はGlobalSoundboardの全実装であり、Vencord本体や他のuserpluginの全面監査ではありません。

## 結果

| 検証 | 結果 |
| --- | --- |
| 回帰テスト | 37 / 37成功、失敗・skipなし |
| 音声ライフサイクル | 14件成功 |
| import・起動・停止・再有効化 | 2件成功 |
| 検索・一覧・履歴モデル | 7件成功 |
| 現在の純正Soundboard連携 | 7件成功 |
| アカウント別保存・失敗復旧 | 7件成功 |
| 対象ESLint | エラー・警告0 |
| 対象Stylelint | 成功 |
| Vencord全体のTypeScript `--noEmit` | 成功 |
| 通常desktop build（package.jsonのbuildと同じ処理） | 成功 |
| renderer sourcemapの製品コード確認 | 7実装TS/TSXモジュールを確認。テスト・テスト用mockの混入なし |
| 修正版の実Discord画面・VC受信 | **未実施。通話中のDiscordを再起動・操作していない** |

Vencord 1.15.3、TypeScript 6.0.3、esbuild 0.28.1、既存の開発依存を使用。テストは本番モジュールをbundleして実行し、Discord・DataStore・音声デバイスなどの境界のみをmockしています。実際のアカウント設定、音声デバイス、VCへはテストから接続していません。

初回のsandbox内テストでesbuildの親ディレクトリアクセスが拒否されたため、許可された実行経路で再実行しています。最終テスト・型検査・ビルドは正常終了を確認済みです。

## 修正した問題

- 出力先を変更しても古いデバイスへ音が流れ続ける問題を修正。
- キャンセルした再生の遅いNotFound応答が、新しく選んだ出力先をDefaultへ上書きする競合を修正。
- 再生準備中の停止、ended/pause/error後に「再生中」が復活する問題を修正。
- 設定画面を閉じていてもデバイス消失を検出し、現在の出力を停止。プラグイン停止時は監視を解除。
- 出力デバイス設定の読込失敗を無視して、意図しないDefault再生を始める問題を修正。再試行可能。
- お気に入り等の読込失敗後に空データを保存する問題、アカウント切替時の遅延書込み先混同を修正。
- 画面の開き直しより前に保存を完了させる共通キューを導入。失敗した変更は同じ起動セッション内で保持し、再試行を表示。
- 画面を閉じた後の再生完了で履歴が書き込まれる問題を修正。
- まだ読み込まれていないDiscord chunkのAPI探索失敗を永久に固定しないよう修正。
- 純正一覧更新の重複を抑制し、15秒timeout後の手動再試行に対応。
- 削除・脱退・利用不可への変更を再生直前に現在のStoreで検査し、古い右クリックメニューでも最新の音量等を使用。
- 純正の「送信依頼」と実際の受信先での再生完了を区別。Fallbackの適用条件、ローカル試聴、出力先を画面上に明記。
- 一覧を1ページ最大240枚に制限。検索・ページ変更・脱退後のフィルターとスクロールを調整。
- Guildアイコン取得をGuildごと1回に削減し、履歴の不正件数・重複を補正。
- モード変更・Native再生開始時に、既存のローカル音を停止。

## Discord内部APIの確認

チェックアウトのSoundboardStore型と、認証不要で取得できる[Discord公開bundle](https://discord.com/assets/web.f803cc09a978437c.js)を照合しました。

調査した公開bundleのSHA-256:

```text
A74BA599676144A1D1290EC543CE5D7080EA34E09B7E0700CAFB47DD01AEFDA4
```

- 純正再生: `SEND_SOUNDBOARD_SOUND` / `SOUNDBOARD_TRACK_USAGE`のモジュール内で、`source_guild_id`を含む純正actionを使用。
- 利用判定: `canUseSoundboardEverywhere` / `.available`を含む純正判定を維持。VC接続、発言権限、Soundboard権限、server mute / suppressも確認。
- 一覧取得: `EXPRESSION_PICKER_SOUNDBOARD_SOUNDS_LOADED`、`REQUEST_SOUNDBOARD_SOUNDS`、`SOUNDBOARD_FETCH_DEFAULT_SOUNDS`を含む既存関数。
- URL: `CDN_HOST`、`API_ENDPOINT`、`.SOUNDBOARD_SOUND(`を含む既存関数。CDN形式を独自に固定しない。
- Native playは同期voidで内部POSTの結果を返さないため、サーバーの成功応答・受信側の音声をこのactionの戻り値では確認できない。

公開bundleとの一致は、起動中の特定Discord画面で修正版が動作した証拠ではありません。Discordの更新・段階配信による差は残ります。トークン取得・独自REST/Gateway・権限偽装・外部テレメトリーは追加していません。

## 配布判定前に残る実機確認

自動検証とビルドは完了していますが、以下を実施するまでは「VCを含めた実機検証済み」とは扱いません。

1. 通話終了後に現在の導入経路へ修正版を反映し、Discordを完全終了・再起動する。
2. GlobalSoundboardの入口、検索、ページ送り、お気に入り・履歴の再オープン復元を確認する。Light/Dark、小さなウィンドウの表示も確認する。
3. 既定出力をヘッドホンにして、小さい▶が試聴となり、停止・音量変更が効くことを確認する。
4. 許可したテストVCでAudio Output → CABLE Input → Discord CABLE Outputの受信を別参加者側で確認する。マイク混合、遅延、ノイズ抑制、PTTも実環境で確認する。
5. 同意したテストVCでNativeを検証する。送信側表示だけでなく受信側で音が届くことを確認する。権限やNitro条件を回避しない。

Windows以外、他のDiscordリリースチャンネル、実デバイスの着脱、連続した長時間運用は未検証です。手順はREADMEを参照してください。
