# 公式npm版DSHをWSL＋systemdで使う

対象は公式 `@deepseek-ai/dsh@0.2.1-rc.2`、Node.js 24以降、WSL2/Linuxです。以下のシェル操作はzshで実行できます。Windowsネイティブ版の手順ではありません。

## 保存先と実行環境をそろえる

CLIで追加するプロファイルと、サービスが起動するプロファイルは同じ保存先にします。

```zsh
type -a dsh
command -v node
dsh --version
printenv DSH_HOME
sudo systemctl cat dsh.service --no-pager
```

サービス名が違う場合は読み替えてください。本ガイドはシステムサービスが通常ユーザーとして起動する構成です。ユーザーサービスなら `systemctl --user` を使い、drop-inもユーザー側へ追加します。

`DSH_HOME` 未指定時は通常 `~/.dsh` です。サービスの `HOME`・`DSH_HOME` と実際の保存先も確認してください。サービスは通常 `~/.zshrc` を読みません。ターミナルでのexportだけではviewerトークンを渡せません。

専用npm prefixとmiseを使う構成例:

```ini
WorkingDirectory=/home/<WSL_USER>
Environment="HOME=/home/<WSL_USER>"
Environment="PATH=/home/<WSL_USER>/.local/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=/home/<WSL_USER>/.local/bin/mise exec -- /home/<WSL_USER>/.local/npm-global/bin/dsh web --no-open
```

既存の `--public-url`・`--trusted-host` 等は維持します。これは既存unitを丸ごと置き換える指示ではありません。miseがサービスのWorkingDirectoryでもNode.js 24以降とpnpmを解決できることが必要です。

## 初回導入

PR #2の標準bundle対応がmainへマージされるまでは `feat/standard-dsh-bundle` ブランチを使用します。既存チェックアウトに未コミット変更がある場合は、先に内容を確認してください。

```zsh
git clone --branch feat/standard-dsh-bundle https://github.com/AiraCometes/DSH-Session-Messaging.git
cd DSH-Session-Messaging
npm ci --ignore-scripts
npm pack --ignore-scripts
```

サービスを停止し、実際のDSH_HOMEをバックアップしてから追加します。ここでは保存先を `~/.dsh` とします。バックアップには認証情報も含まれるため公開しないでください。

```zsh
sudo systemctl stop dsh.service
cp -a -- "$HOME/.dsh" "$HOME/.dsh.backup-$(date +%Y%m%d-%H%M%S)"
DSH_HOME="$HOME/.dsh" dsh plugin --profile web add "$PWD/dsh-session-messaging-0.1.1.tgz"
sudo systemctl start dsh.service
```

この版はインストールだけでは `enabled: false` の設定待ちです。まだDBやviewerを起動せず、既存Agentへツールも登録しません。DSH起動後に4役のセッションを作成・ロードし、各Session IDを取得します。モデルはDSH側で選びます。

開発時にチェックアウトを直接使うならtarballの代わりに `"$PWD"` を追加できます。ただしサービスユーザーからそのディレクトリと依存が読める必要があり、削除・移動や編集中の変更が稼働環境へ影響します。通常運用ではtarballを推奨します。

## viewerトークンをサービスへ渡す

次はサービスと同じ通常ユーザーで実行します。トークンをコマンド引数や出力に載せず、専用ファイルへ保存します。すでに存在する場合は上書きせずエラーになります。

```zsh
node --input-type=module <<'JS'
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const directory = join(homedir(), '.config', 'dsh');
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(join(directory, 'session-messaging.env'),
  `DSH_TOWER_VIEWER_TOKEN=${randomBytes(32).toString('hex')}\n`,
  { flag: 'wx', mode: 0o600 });
JS
```

システムサービスにdrop-inを追加します。

```zsh
sudo systemctl edit dsh.service
```

`<WSL_USER>` を実際のユーザー名へ置き換えて記載します。systemdのパスには `~` や `$HOME` を使いません。既存drop-inがある場合はその内容を保ちます。

```ini
[Service]
Environment="DSH_HOME=/home/<WSL_USER>/.dsh"
EnvironmentFile=/home/<WSL_USER>/.config/dsh/session-messaging.env
```

## セッション接続を有効化

1. サービスを停止します。
2. `examples/profile.patch.yml` を参考に、`~/.dsh/profiles/web/cordis.patch.yml` の既存リストへ `id: session-messaging` 行を追加します。同じidがあれば更新し、ファイル全体や他プラグインの行を上書きしません。
3. `enabled: true`、4役の実Session ID、DBの絶対パスを設定します。例: `/home/<WSL_USER>/.dsh/session-messaging/control-tower.sqlite`。DB親ディレクトリはStoreが作成します。provider/modelは監査用ラベルであり、DSHのモデル設定を変更しません。
4. 再読み込み・起動します。

```zsh
sudo systemctl daemon-reload
sudo systemctl start dsh.service
sudo systemctl status dsh.service --no-pager -l
```

DSH Web UIで対象の保存済みセッションをロードします。再起動後にまだロードされていない相手へは配送できません。設定だけでは自動再開しません。

viewerは `http://127.0.0.1:3091` です。WSLのlocalhost転送が有効ならWindowsのブラウザーから開けます。転送できない場合はWSL側で待受と接続を確認します。認証欄へ、envファイルの `DSH_TOWER_VIEWER_TOKEN=` の右辺を入力してください。秘密値をチャットやログへ貼らないでください。

viewerはDSH本体とは別のループバックHTTPサーバーです。既存DSHのTailscale URL・`--public-url`・認証設定は自動適用されません。まずlocalhostで検証してください。外部アクセスを追加する場合は別途リバースプロキシ等の設計が必要です。

## 実モデルを使う手動確認

これはLLMリクエストを発生させる運用検証です。自動インストールテストとは区別します。

1. control側で `tower_get_state` が呼べ、4役の接続先が見えることを確認します。
2. controlからspecへ一意の冪等キーで短いメッセージを1件送信します。
3. viewerで本文・送信元・宛先と `queued` → `accepted` を確認します。
4. specに `tower_report_message` で `processing`、`completed` を報告させます。タスク完了とは別の状態です。
5. 正常停止・再起動後も同じDBの通信履歴が見えることを確認します。`uncertain` の通信を確認なしに再送しません。

## DSH-Marketとの使い分け

このパッケージはnpm未公開・Marketカタログ未掲載です。初回導入と開発版の更新はCLIで行います。DSH-Marketはカタログ掲載先にインストール元を制限するため、未掲載の開発版の発見・更新までできるとは扱いません。同名の別プロジェクトを更新先として選ばないでください。

Marketで表示・無効化等ができるかと、日本語パックとの同時稼働は実環境で確認してください。今回の自動テストは公式DSH単体でのbundle導入・有効化・削除を対象とし、これら第三者プラグインを含む検証ではありません。systemd運用では再起動は `sudo systemctl restart dsh.service` を使用します。

## 更新・切り戻し

更新前にサービスを停止し、プロファイルとDBをバックアップしてから新tarballを追加します。設定ファイルとviewerトークンは継続して使います。DBや履歴は削除しません。現在の対応版以外へDSHを更新する際は、先に互換性テストが必要です。

起動に失敗した場合はサービスを停止し、ユーザーパッチの `session-messaging` 行を一時的に `config: { enabled: false }` へ変更して起動してください。プラグイン自体のロードに失敗する場合は、ユーザーパッチの該当行を除去してCLIでパッケージを削除します。無効化だけで依存パッケージの問題まで直るとは限りません。再有効化には保存した全configを戻します。
