# カスタムVencordの復旧と更新（Windows）

ExternalEmojiCombinerとGlobalSoundboardを含むローカルビルド用です。

## 今回の確認結果（2026-09-09）

- Discordの注入先はRoamingのVencord/distで、導入済みrendererには2つのプラグインがありませんでした。
- ソースとカスタムビルドは残っており、2つの有効設定も維持されていました。
- そのため、Vencordを2つ入りの固定ローカルビルドへ再導入します。プラグイン設定やSoundboard保存データを初期化しません。

## 通話が終わったら

1. 通知領域のDiscordアイコンから **Quit Discord** で完全終了します。ウィンドウの×だけでは終了しない場合があります。
2. このフォルダーの **Apply-Custom-Vencord.cmd** をダブルクリックします。
3. 「固定ビルドへの導入を確認しました」と表示されたら、普段のDiscordを起動します。
4. Vencord → PluginsでExternalEmojiCombinerとGlobalSoundboardを確認します。

Discordが起動中なら復旧処理を中止するため、通話を勝手に切りません。実行中はDiscordを開き直さないでください。PowerShellの実行ポリシーは変更しません。

導入処理は既存の公式Installer CLIを開発ビルド用の環境変数付きで使用し、このフォルダーのdist/patcher.jsを参照させます。公式配布ビルドのダウンロードは行いません。注入ファイルはdist/custom-install-backupsに実行ごとに保存します。

## 上書き防止とPC再起動

`buildCustom` はVencord自身の自動更新を無効にしてビルドします。Discord本体の更新は無効にしません。Vencordの修正を取り込みたいときは、カスタムプラグインを保持したまま手動で更新・再ビルドしてください。

```powershell
pnpm.cmd buildCustom
pnpm.cmd injectCustom
```

通常の `pnpm.cmd build` ではこの上書き防止が外れるため、以後は `buildCustom` を使用してください。確認だけなら `node scripts/installCustom.mjs --check` で、設定変更やインストールをせずに対象を表示できます。

Windows再起動・シャットダウン・ログオフ時には、通常のbefore-quitイベントが呼ばれません。[Electron公式仕様](https://www.electronjs.org/docs/latest/api/app#event-before-quit)

このビルドではWindows終了イベントにもVencord既存の更新引継ぎ処理を接続し、展開済みの新しいDiscordにも注入を引き継ぐよう補強しています。別の常駐ソフトやタスクスケジューラは追加しません。

このソースフォルダーを削除・移動すると注入先がなくなります。残しておいてください。強制電源断、Discord/Vencordの再インストール、将来のDiscord仕様変更までは保証できません。外れたときは、通話終了後に同じApply-Custom-Vencord.cmdで復旧できます。

## 検証の範囲

2026-09-09に以下を確認しました。

- GlobalSoundboard回帰37件、Windows終了・コピー失敗時復旧12件、復旧スクリプトの隔離テスト12件がすべて成功。
- ExternalEmojiCombinerの既存パーサーテスト、対象ESLint、TypeScriptチェック、上書き防止ビルドが成功。
- 製品bundleに2つのプラグインとWindows終了フックが含まれ、テスト用コードが含まれないことを確認。
- 復旧スクリプトの実環境 `--check` が成功。現在のDiscord注入ファイルのハッシュは作業前と一致。

ソースの実体はEドライブへ移設されています。型・lintを実行するときは、Cドライブの移設用リンクではなく、このフォルダーのEドライブ側の実体を作業ディレクトリにしてください。C/Eの混在で同じ型が二重に読み込まれるのを防ぎます。

ユーザーの選択に従い、現在のDiscordへの反映・終了・実PC再起動は行っていません。実画面の復旧確認は、通話終了後の適用・Discord再起動後に行ってください。実再起動・VC受信の検証済みという意味ではありません。

```powershell
node --test scripts/testDiscordUpdatePersistence.mjs scripts/testCustomInstall.mjs
node scripts/installCustom.mjs --check
```
