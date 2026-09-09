# GlobalSoundboard

参加中のサーバーのSoundboardを、検索・サーバー絞り込み・お気に入り・履歴から選んで再生するVencordカスタムプラグインです。Discordが取得できたサウンドを扱い、Nitroやサーバー権限を偽装しません。

## 開き方と再生先

メッセージ入力欄の地球アイコン、Vencord Toolbox、または入力欄の外で `Ctrl + Shift + B` を押します。

| 操作・モード | 音の行き先 | 注意 |
| --- | --- | --- |
| カードの小さい▶ | この端末の既定の出力デバイス | 常にプレビュー。下のモード選択とは独立 |
| Native Discord | Discord標準のSoundboardとしてVCへ再生を要求 | VC参加、権限、他サーバーの音のNitro等の条件に従う |
| Audio Output | 指定した再生デバイス | 仮想ケーブルからマイク入力としてVCに流せる。自動でマイクを混合しない |
| Local Preview | この端末の既定の出力デバイス | 試聴用。通常は自分のスピーカー・ヘッドホン |

Nativeの「再生を要求しました」は送信先での再生完了を保証しません。Discord内部の純正アクションはサーバー応答を返さないためです。Fallback Modeは純正の**事前判定**で再生できなかった場合だけ適用し、送信後のサーバーエラーでは自動的に別経路へ再送しません。

「ローカル停止」と「ローカル音量」はAudio Outputとプレビュー専用です。純正Soundboardの音は停止・音量変更できません。ローカル再生は同時に1つまでで、新しい音の再生・モード変更・画面を閉じる・プラグイン無効化で前の音を停止します。読み込み中でも停止できます。

100%は元の音量です。200%は小さい音を最大2倍まで上げますが、ブラウザーの音量上限1.0を超える増幅はしません。出力先を変更したり、選択デバイスが消えたりするとAudio Output再生を停止します。消失時はDefaultに戻し、その音を勝手に既定デバイスで再開しません。

## Nitroなし・VoicemeeterなしでVCへ流す（Windows）

純正Soundboardの利用条件を解除する機能ではありません。Audio Outputを通常のマイク音声として送る構成です。

1. [VB-CABLE公式ページ](https://vb-audio.com/Cable/)からドライバーを入手し、展開して管理者としてセットアップします。インストール後はWindowsを再起動します。
2. Windowsの既定の再生デバイスとDiscordの出力デバイスは、普段のヘッドホン／スピーカーにしておきます。**既定の再生先をCABLE Inputにしないでください。** プレビューや他アプリの音までケーブルへ流れるのを防ぎます。
3. GlobalSoundboardの再生モードを **Audio Output** にし、出力先を **CABLE Input (VB-Audio Virtual Cable)** にします。
4. Discordの「音声・ビデオ」で入力デバイスを **CABLE Output (VB-Audio Virtual Cable)** にします。Discordの出力はCABLEにしません。
5. VCでミュートを解除し、カード本体を押します。小さい▶は試聴なのでVC送信用ではありません。まず小さい音量で、同意した相手に届くことを確認してください。

この構成だけでは実マイクの声は入りません。自分の声も同時に送りたい場合、Windowsのサウンド設定から実マイクのプロパティを開き、「聴く」→「このデバイスを聴く」の再生先を **CABLE Input** にする構成が使えます。遅延や音切れは機器に依存します。ケーブル自身をケーブルへ戻す設定はハウリングの原因になるため避けてください。終了後は「聴く」を解除し、Discord入力を普段のマイクに戻せます。

音が途切れる場合はDiscordの入力メーターを見て、必要に応じてノイズ抑制・自動ゲイン・入力感度を調整します。Push to Talkでは送信キーが必要です。VC送信時の加工はDiscord側の設定です。

## 保存・検索

- お気に入り、履歴、最後の検索語はDiscordアカウントごとにVencord DataStoreへ保存します。アカウント切替後の書込み先は混ざりません。
- データ読込に失敗したときは、既存データを空の一覧で上書きせず、画面から再試行できます。再生と一時検索は利用できます。
- 書込に失敗した変更は、この起動セッション内では画面を開き直しても保持し、「保存を再試行」できます。**未保存のままDiscordを再起動・終了すると、その変更は失われます。**
- 出力デバイスIDは端末共通のDataStore設定です。保存失敗時には通知します。その場合の変更は現在の起動中だけ有効で、再起動後は再選択が必要です。
- 検索は全角・半角、大文字・小文字を正規化し、サウンド名・サーバー名・絵文字名から探します。1ページ最大240件、履歴最大100件です。

外部解析・独自APIサーバー・トークン取得・直接のREST/Gateway呼び出しは追加していません。取得・純正再生はDiscord内部の既存機能を使用し、ローカル音源はDiscordのURL解決機能から取得します。

## インストール・更新

このフォルダーをVencordソースの `src/userplugins/globalSoundboard` に置き、Vencordのルートで次を実行します。既存フォルダーとビルド成果物は先にバックアップしてください。Node.jsとpnpmのバージョンはVencordのpackage.jsonに合わせます。

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd build
pnpm.cmd inject
```

PowerShellで `pnpm.ps1` が実行ポリシーにより止まる場合も、`pnpm.cmd` なら実行ポリシーを緩めずに起動できます。導入先を選択し、**通話が終わってからDiscordを完全終了・再起動**してください。その後「Vencord → Plugins → GlobalSoundboard」を有効にします。既にカスタムビルドを導入済みの場合は、現在の配布・注入経路に合わせて更新してください。公式Vencordの上書き更新ではカスタムプラグインが外れる場合があります。

## 開発・検証

Vencordルートで実行します。既存の開発依存のみを使用し、製品のランタイム依存は追加していません。

```powershell
pnpm.cmd exec tsx --test src/userplugins/globalSoundboard/model.test.ts src/userplugins/globalSoundboard/storage.test.ts src/userplugins/globalSoundboard/audio.test.ts src/userplugins/globalSoundboard/native.test.ts src/userplugins/globalSoundboard/entrypoint.test.ts
pnpm.cmd exec eslint --no-ignore "src/userplugins/globalSoundboard/**/*.{ts,tsx}"
pnpm.cmd exec stylelint src/userplugins/globalSoundboard/style.css
pnpm.cmd exec tsc --noEmit
pnpm.cmd build
```

音声・保存・純正APIのテストは実装モジュールを読み込み、Discord・ブラウザーの境界だけを差し替えています。実VCへの送信、実デバイスの聴感・遅延、Discord更新後の互換性を保証するものではありません。配布前にはテスト用VCで送信側と受信側の確認が必要です。

## 対応範囲・ライセンス

2026-09-05のWindows / Discord desktop / Vencord 1.15.3を検証対象としています。Audio Outputには `HTMLMediaElement.setSinkId` 対応が必要です。非対応クライアントではプレビューへ切り替えます。モバイル・他OS・別のDiscordリリースチャンネルは未検証です。

Discordの内部機能は予告なく変わるため、永久互換を保証できません。また、[Vencord公式FAQ](https://vencord.dev/faq/)が説明する通りクライアント改造にはDiscord利用規約上のリスクがあります。Discordの認定製品ではありません。純正Soundboardの条件は[Discord公式ガイド](https://support.discord.com/hc/en-us/articles/12612888127767-Discord-Soundboard-Guide-Using-Adding-and-Managing-Sounds)を参照してください。

GPL-3.0-or-later。Vencordの著作権表示とライセンスを維持してください。変更ソースを含めて配布し、外部ドライバーやDiscord本体をこのプラグインに同梱しないでください。
