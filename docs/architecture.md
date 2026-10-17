# 設計と拡張ガイド

## 依存方向

```text
Cordis plugin ──────→ core ←────── GitHub integration
       │                ↑
       ├──→ Harness adapter
       └──→ HTTP observer
```

coreはNode.js標準ライブラリだけに依存する。HarnessやGitHub固有の型を持ち込まない。公開Harness APIの変更は `plugin.js` と `adapters/harness.js` の変更に閉じ込める。閲覧画面から状態を直接変更せず、業務上の変更はControlTowerを通してイベントと同時に保存する。

## モジュールの責任

| モジュール | 責任 |
|---|---|
| `core/store.js` | SQLiteスキーマ、DBオーナー、トランザクション、イベント保存 |
| `core/tower.js` | 送信・冪等性・配信状態・タスク権限・版番号・完了条件 |
| `core/contracts.d.ts` | 将来のアダプターが実装するメッセージと受付応答の型 |
| `core/delivery.js` | 未受付が確実な失敗を表すDeliveryRejected |
| `adapters/harness.js` | 設定済みのライブAgentへのsteerと送信元の帰属 |
| `integrations/github.js` | 生バイトの署名検証、許可リスト、重複排除、通知生成 |
| `http/server.js` | 読み取り専用API、認証、Webhookエンドポイント |
| `http/viewer.*` | 通信内容・状態・タスクを人間へ表示 |
| `plugin.js` | 設定と実Agentの対応、スコープ別ツール、初期化と終了 |
| `config.js` | Cordis/DSH設定画面で使うStandard Schemaと既定値 |

## 配布とプロファイルへの登録

`package.json` の `dsh.bundle.patch` が `cordis.patch.yml` を指す。このパッチは `id: session-messaging` のホスト行を挿入し、初期状態を `enabled: false` にする。利用者はプロファイルのパッチでconfig全体を指定して有効化する。標準の `dsh plugin add/remove` がbundleの選択を管理し、ホストコードの編集は不要。`engines.dsh` で検証対象の0.2.1-rc.2を明示する。

実行ファイルはJavaScriptのため、配布時のビルド・prepareは不要。tarballには実行JSとviewerアセットを一緒に含める。coreは引き続きNode標準ライブラリだけに依存し、設定スキーマ用のSchemasteryはプラグイン境界の実行依存とする。導入の結合テストはモデルを呼ばず、実DSHプロファイルと実Agentを使って実行する。

## 配送先を追加する

1. 新しい `src/adapters/<name>.js` を作成する。
2. `deliver(message)` で受付まで待ち、`{ id: <相手のInbox受付ID> }` を返す。
3. `tower.registerAdapter(name, adapter)` で登録し、SessionBindingにそのadapterとaddressを指定する。
4. 受付前の失敗が確実な場合だけ `DeliveryRejected` を投げる。それ以外の例外は `uncertain` と記録される。
5. ネットワークを越える場合は `message.id` で相手側も重複排除する。送信側だけでexactly-onceを保証しない。

```js
import { DeliveryRejected } from 'dsh-session-messaging/core';

const adapter = {
  async deliver(message) {
    const receipt = await trustedTransport.accept({
      idempotencyKey: message.id,
      recipient: message.recipient.address,
      body: message.body,
    });
    if (receipt.rejectedBeforeAdmission) throw new DeliveryRejected('Target refused input');
    return { id: receipt.inboxId };
  },
};
tower.registerAdapter('remote', adapter);
```

この例の `trustedTransport` は実装する通信層であり、この版には含まれない。ローカルHarnessプラグインは現在 `harness` のみを構成する。追加アダプターをホストから組み込むときは `core` のAPIで構成するか、pluginのcomposition部分を拡張する。

## イベント連携を追加する

外部イベントの検証・正規化を `integrations/` に置き、イベント受領記録・重複排除・コントロールタワーへのenqueueを一つの `store.transaction()` 内で行う。ネットワーク処理や `await` をトランザクション内に入れない。`enqueue` は内部向けで、外側のトランザクションを必要とする。通常の呼び出しは `send` を使う。

## スキーマや機能を追加する

- 既存の意味を保った任意フィールドの追加はイベント `version: 1` で扱える。
- 既存フィールドの意味や必須条件を変更する場合は、新しいイベントversionと読み取り互換処理を設計する。
- DBスキーマの変更は `PRAGMA user_version` ごとの前進マイグレーションとして追加する。既存データの削除で解決しない。
- 新しいタスク操作は権限・版番号チェック・状態保存・監査イベントを一つのトランザクションにする。
- 認証・配送の重複・復元・権限を検証するテストを追加する。個別UIの見た目だけのテストは必須にしない。

## モデルを追加する

このプラグインはモデルのAPIを直接呼ばない。Harnessホストでモデルを利用可能にし、そのモデルを使うセッションを設定する。通信プロトコルの変更は不要。`provider` と `model` は設定の監査用ラベルなので、稼働中のモデル変更を追従する機能は別途追加する。
