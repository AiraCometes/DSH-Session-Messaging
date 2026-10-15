# DSH Session Messaging

DeepSeek Harnessのセッション間通信を記録し、コントロールタワー・仕様・実装・レビューの進捗を確認するためのプラグインです。異なるモデルを使うセッションを、同じ通信形式で扱います。

**現在は初期実装 v0.1。** 同一Harnessプロセス内の、明示的に設定したロード済みセッションを接続します。別プロセス・別マシン間の配送、セッションの自動生成・コールド再開、モデル選択の自動化は今後の拡張です。

## できること

- 送信元・宛先・設定上のモデル名・本文・タスクID・返信先を永続保存。
- 「送信待ち」「受信済み」「受信者からの処理報告」「失敗」「配信結果不明」を区別。
- 通信タイムライン、本文の展開、セッション・タスク・状態による絞り込み。
- 役割と担当に基づくタスク更新、版番号による競合検知、依存関係の循環検知。
- 実装タスクでは、現在のコミットSHAへのレビュー承認とCI成功の報告を完了条件にする。
- GitHub Webhookの署名・リポジトリ許可リスト・配信ID重複を検証し、コントロールタワーへ通知。
- SQLiteへの状態とイベントの同時コミット。モデル・配送先の追加はアダプター単位で拡張。

GitHubイベントは変更の通知です。差分の取得・影響調査・タスクへの反映は、コントロールタワーがHarness側のGitHubツール等を使って行います。CI・レビュー欄は担当セッションの報告であり、GitHubの承認APIとの自動照合はまだありません。

## 模擬デモ

Node.js 24以降を使用します。デモ本体は外部パッケージ・LLM API・GitHub接続を必要としません。

```bash
git clone https://github.com/AiraCometes/DSH-Session-Messaging.git
cd DSH-Session-Messaging
npm run demo
```

表示されたローカルURLを開き、ターミナルに表示される閲覧トークンを入力してください。4役の**模擬通信**を閲覧できます。実モデルは動きません。データは `.tower/demo.sqlite` に保存されます。トークンを固定する場合は `DSH_TOWER_VIEWER_TOKEN` を24バイト以上に設定します。

## Harnessへ接続

1. 利用するHarness環境で、コントロールタワー・仕様・実装・レビューの各セッションを作成し、それぞれのモデルを選択します。
2. `examples/harness.config.json` の `address` を実際のHarness Session IDに置き換えます。`model` / `provider` は監査用の設定ラベルです。実際のモデルを変更した場合は設定も更新し、新しいセッションIDを割り当ててください。
3. Harnessが使うNode.js環境からこのパッケージと `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm` を解決できるようにします。
4. このプラグインの `src/plugin.js` を既存Cordis構成からロードし、JSON設定を渡します。ホストコードからの登録例は `examples/mount.js` にあります。
5. `DSH_TOWER_VIEWER_TOKEN` を設定して起動し、`http://127.0.0.1:3091` で通信を確認します。

対象にした公開パッケージは `0.2.1-alpha.3` です。テストは実際の `defineTool` / `createUserMessage` の契約を検証しています。認証済みLLMを呼ぶHarness全体でのE2E検証はまだ行っていません。

systemPromptサービスが利用できるAgentには、監査可能な通信ツールを使うための共通指示を登録します。ログの対象は本プラグイン経由の通信です。組み込みの `send_message` や外部チャットなど別経路の通信を自動収集する機能は含みません。

ツールは**設定済みの実Agentスコープ**だけに登録します。送信者をモデル引数から受け取らず、実行元Agentから決定します。独立したルートセッションも、同じプロセスにロードされていれば接続できます。未ロードの相手は配送失敗になり、ロード後にコントロールタワーが明示的に再試行します。

### モデルに公開するツール

| ツール | 用途 |
|---|---|
| `tower_get_state` | セッション・タスク・直近の通信を読む |
| `tower_get_events` | シーケンス番号から保存済み履歴を読む |
| `tower_send_message` | 本文と冪等キーを指定して送信する |
| `tower_report_message` | 受信した依頼の処理開始・完了を報告する |
| `tower_create_task` | タスク作成。コントロールタワーのみ |
| `tower_update_task` | 現在の版番号を指定して更新する |
| `tower_retry_message` | 失敗した配送を明示的に再試行する |

役割ごとの初期指示例は [examples/prompts.md](examples/prompts.md) を参照してください。

## GitHub変更の通知

設定の `github` を有効にし、次の環境変数を設定します。秘密値を設定ファイルやGitに保存しないでください。

```bash
export DSH_TOWER_VIEWER_TOKEN='<24バイト以上のランダムな値>'
export DSH_TOWER_GITHUB_SECRET='<GitHub Webhookと一致するsecret>'
```

Webhookの宛先は `/webhooks/github` です。サーバーはループバックにのみバインドするため、GitHubから接続する場合はHTTPSのリバースプロキシ等で**Webhookのパスだけ**を公開します。プラグインはトンネルやWebhook登録を自動作成しません。

対応イベントは `push`、`pull_request`、`check_run`、`workflow_run`。署名は生のリクエスト本文で検証し、許可されたリポジトリだけを受け付けます。同じ配信IDの再送は二重通知しません。外部データは専用のメッセージソースと注意文で識別し、人間からの指示と区別します。

## 開発・拡張

```bash
npm ci --ignore-scripts
npm run check
npm test
```

テストは永続化・クラッシュ後の復元・配送の重複防止・配送結果不明・権限・タスク競合・依存関係・SHA別の完了条件・署名・HTTP認証・公開Harness APIとの互換性を確認します。HTTP結合テストにはローカルのlisten権限が必要です。

```text
src/core/           モデルに依存しない通信・タスク管理・永続化
src/adapters/       Harnessや将来の配送先への接続
src/integrations/   GitHubなど外部イベントの受信
src/http/           人間向け通信ログと読み取りAPI
src/plugin.js      Cordisへの登録とライフサイクル
```

- [設計・拡張ガイド](docs/architecture.md)
- [運用とデータ契約](docs/operations.md)
- [段階的な追加機能](docs/roadmap.md)
- [設計判断](docs/adr-0001-modular-coordination.md)

## 現在の制約

- DBは単一プロセス・単一オーナーです。複数のHarnessから同じSQLiteファイルを開かないでください。
- 全設定済みセッションは同じプロジェクトの信頼境界に属し、相互のタスク・通信履歴を読めます。マルチテナントの分離はありません。
- 自動再送は行いません。配送中の停止や不明な例外は `uncertain` になり、相手で未受信と確認してから再試行します。
- `accepted` はInboxへの受付であり、別の同期ディスク書き込み完了やモデルの処理完了を保証しません。Harness側の永続セッション保存も設定してください。
- 返信チェーンは既定32件、各送信元の新規送信は毎分60件まで。新規チェーンへの意図的な分割まで防ぐものではありません。
- モデル内部の思考過程は記録しません。送受信本文、状態遷移、明示的な報告を記録します。
- worktree作成・コードのマージ・PR作成・予算制御・人間の承認フローはこの版では自動化しません。
