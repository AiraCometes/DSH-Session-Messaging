# DSH標準bundleとしてのインストール

## 対応環境

- WSL2/Linux、Node.js 24以降。
- `@deepseek-ai/dsh` 0.2.1-rc.2。`engines.dsh` と共有DSHパッケージのpeerを同版へ固定しています。
- DSHが使うpnpmをPATHから実行できること。
- `shiguredo/deepseek-harness` の `shiguredo` ブランチは、確認対象commit `bb8e649df3c976c9cd965037593f353009992ae3` で0.2.1-rc.2です。標準bundleの導入仕様、Agent・tool APIを確認しています。フォーク自体のビルド・実行試験と、公開npm版での実行試験は区別します。

今後DSHのバージョンが変わった場合は、APIと導入テストを確認してから対応範囲を更新します。別バージョンを確認なしで互換扱いにはしません。

## npm版DSHへローカルチェックアウトを導入

DSHは既にインストール済みとします。このプラグインのディレクトリで:

```bash
npm ci --ignore-scripts
dsh --version
dsh plugin --profile web add "$PWD"
dsh --profile web --dump-config
```

`--profile` はpnpmに渡す `add` より前へ置きます。ローカルパスは絶対パスにすると、コマンドを実行する場所に依存しません。この方法はチェックアウトへのlinkを作るため、そのディレクトリを移動・削除すると解決できなくなります。

設定ダンプに `id: session-messaging`、`name: dsh-session-messaging`、`enabled: false` があればbundleレイヤーが追加されています。ダンプは起動確認ではありません。

追加先が既存のWebプロファイルなら、そのまま利用できます。独立したプロファイルを新設する場合は、**初回だけ**次を実行してから、そのプロファイルへ `add` します。

```bash
dsh --profile session-messaging --from-default-profile web --dump-config
dsh plugin --profile session-messaging add /absolute/path/to/DSH-Session-Messaging
```

`--from-default-profile` は同名のプロファイルをテンプレートで置き換えます。既存プロファイルの更新や、通常の再起動では使わないでください。

## shiguredoフォークをソースから起動する場合

フォークの取得・ビルドはそのREADMEに従い、`pnpm dsh --version` が0.2.1-rc.2と表示される状態にします。Harnessのホストコードを編集する必要はありません。

まずこのプラグインのディレクトリで `npm ci --ignore-scripts` を実行します。次に、ビルド済みフォークのディレクトリで:

```bash
pnpm dsh plugin --profile web add /absolute/path/to/DSH-Session-Messaging
pnpm dsh --profile web --dump-config
```

以後の `dsh ...` も、このディレクトリで `pnpm dsh ...` として実行します。`DSH_HOME` を普段指定している場合は、追加・起動・削除のすべてで同じ値を使ってください。

フォークはインスタンス別の保存領域も拡張しています。このプラグインのDBはその内部ディレクトリ構造を推定せず、configの絶対パスで明示します。異なるHarnessプロセスには別のDBと閲覧ポートを割り当ててください。

## 配布用tarball

JavaScriptをそのまま同梱しているため、ビルド・prepareスクリプトは不要です。プラグインのディレクトリで:

```bash
npm pack --ignore-scripts
dsh plugin --profile web add /absolute/path/to/dsh-session-messaging-0.1.1.tgz
```

tarballにはbundleパッチ、実行JS、設定スキーマ、viewerのHTML/JS、表示用locale、設定例が含まれます。テストやnode_modulesは含めません。npmレジストリへの公開は行っていません。

## 設定と有効化

インストール時の `enabled: false` は、接続先未設定の状態を表します。この状態ではDBやviewerを開きません。Plugin Managerでbundleを有効にすることと、業務設定の `enabled: true` は別です。

1. Web UIで接続するセッションを作成・ロードし、実Session IDを取得します。
2. `examples/profile.patch.yml` のパスとSession ID、provider/modelラベルを置き換えます。
3. `$DSH_HOME/profiles/<profile>/cordis.patch.yml` の既存のYAMLリストへ編集済みの行を追加します。既定のホームは `~/.dsh`。同じidがあればその行を更新し、ファイル全体は上書きしません。
4. 起動シェルへ `DSH_TOWER_VIEWER_TOKEN` を24バイト以上の秘密値として設定します。
5. プロファイルを再起動します（例: `dsh --profile web --no-open`）。bundleの追加・削除後は再起動してください。
6. 既定の `http://127.0.0.1:3091` へ接続し、トークン認証後にセッション一覧を確認します。

ホストの再起動で対象Agentが未ロードになった場合は、Web UI等から同じ保存済みセッションをロードしてください。設定だけではセッションをコールド再開しません。HMRが有効な環境では設定の変更に伴ってプラグインが再構成されます。

DSHの設定画面ではエクスポートしたStandard Schemaの `Config` を参照できます。相互参照や重複IDなど、実セッション構成に依存するチェックは起動時にも行います。トークン・Webhook secretは環境変数の**名前**だけをconfigに指定し、値をYAMLに書きません。

viewerを使わない場合は `viewer: false`。GitHub Webhookを使う場合はviewerサーバーが必要で、`github` にtarget・許可リポジトリ・secretEnv等を設定します。

## 更新・削除

更新前にDSHを停止します。link導入はチェックアウトを更新して `npm ci --ignore-scripts` を実行し、tarball導入は新しいアーカイブを `dsh plugin --profile <profile> add <新しいtgzの絶対パス>` で追加します。バージョン要件を確認してから再起動してください。初期化用の `--from-default-profile` は使いません。

削除時はユーザーパッチの `id: session-messaging` 行を取り除き、停止後に:

```bash
dsh plugin --profile web remove dsh-session-messaging
dsh --profile web --dump-config
```

bundleレイヤーが消えることを確認します。DBと通信履歴は保持します。他のプラグイン設定、既存セッション、他プロファイルは削除しません。

## 導入の自動検証

このリポジトリのチェックアウトで、DSH実行ファイルの絶対パスを指定します。pnpmもPATH上に必要です。

```bash
DSH_BIN=/absolute/path/to/dsh npm run test:install
DSH_BIN=/absolute/path/to/dsh DSH_INSTALL_MODE=link npm run test:install
```

各実行は独立した一時DSH_HOMEとWebプロファイルを使い、pack内容、標準add、設定レイヤー、実Agentの7ツール、viewer認証、DB終了処理、removeを確認します。LLMへプロンプトは送らず、モデル課金は発生しません。テスト用のprovider/modelラベルは実モデルの稼働を示しません。ネットワークはpnpmによる依存取得に必要になる場合があります。

設定スキーマの検出もDSH CLIで確認します。公開DSH rc.2のWeb構成では、一部の組み込みpreset行などの投影が部分的になり、`--dump-config-schema` 全体が終了コード1になる場合があります。テストではこのbundle自身の行が `status: schema` で完全に投影されることを要求し、他の行に関する部分出力とは区別します。全DSH構成のスキーマが正常という判定には使いません。

ソース起動のフォークを直接検証する場合は、そのビルド済み起動処理へ引数を転送する実行可能なラッパーを `DSH_BIN` に指定します。ラッパーは `pnpm --dir /absolute/path/to/deepseek-harness dsh "$@"` のように引数と環境変数を保持してください。テストはラッパーを一時ディレクトリから呼び、渡すDSH_HOMEはテスト専用です。

## v0.1.0からの変更

v0.1.0は手動の `ctx.plugin()` 組み込み例だけでした。v0.1.1は `dsh.bundle` とパッチで導入する形式を追加し、初期状態を設定待ちにしています。以前の手動設定には `enabled: true` の追加が必要です。DBスキーマと既存の通信・タスク記録形式は変更していません。

参照: [フォーク側の公式導入ガイド](https://github.com/shiguredo/deepseek-harness/blob/bb8e649df3c976c9cd965037593f353009992ae3/docs/user/develop/basic/publish.md)。
