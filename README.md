# Relay

卒業・退職・異動などで不要になった物を、同じコミュニティの人へ期限内に引き継ぐ応募型マッチングサービスです。

現在の実装状況、無料枠の方針、クラウド構築の残作業は [進捗メモ](docs/進捗メモ.md) に記録しています。

## 実装済み

- Campus Relayの発表用インタラクティブUI（PC・スマートフォン対応）
- 出品、応募、第一・予備候補選定、辞退、繰上げ、完了のドメインロジック
- API Gateway、Community Auth、Listing、Matching、Read Model、Event Router、Notification Worker
- Turso/libSQL用MigrationとTransactional Outbox
- Cloudflare Service Bindings、Queues、R2のWrangler構成
- ドメインとイベント契約の自動テスト
- Consumerのメッセージ単位ack/retry、Read ModelとListing投影の冪等化

画面のデモ操作は発表時の再現性を優先したインメモリ・シミュレーションです。Workers側には同じユースケースを処理するAPI境界と永続化処理があります。本番認証、実メール送信、クラウドへのプロビジョニングは資格情報の設定後に行います。

## 開発

```bash
corepack pnpm install
corepack pnpm cf-typegen
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm --filter @relay/web dev
```

Web UI: `http://localhost:3000`

Cloudflare用Web bundleの確認:

```bash
corepack pnpm --filter @relay/web cf-build
```

## デモフロー

1. 卒業予定者としてソファを出品
2. 在学生A・Bとして応募
3. 卒業予定者がAを第一候補、Bを予備候補に選定
4. Aが辞退
5. Bが繰上げを承諾して受渡し完了

## 構成

```text
Browser -> API Gateway Worker -> Community / Listing / Matching / Read Model
                 |                     |          |           |
          Service Bindings          Turso+R2    Turso       Turso
                                         \        /
                                          Outbox
                                             |
                                       Domain Events Queue
                                             |
                                         Event Router
                                     /       |       |       \
                                Listing  Matching  Read Model  Notification
                                  Queue    Queue      Queue        Queue
```

```text
apps/web                 Next.js + OpenNext発表用UI
packages/contracts       Zod API・イベント契約
packages/domain          マッチングAggregateとSagaロジック
packages/turso           libSQL接続・Outbox共通処理
workers/*                Cloudflare Workers 7サービス
db/*                     サービス別Turso Migration
```

## Cloudflare/Tursoへ接続する前に

1. `db/README.md` に従って4つのTurso DBへMigrationを適用する。
2. 各DB利用Workerへ `TURSO_DATABASE_URL` と `TURSO_AUTH_TOKEN` をSecretとして設定する。
3. 次のQueueとDLQ、`relay-listing-images-dev` R2 bucketを作成する。

```text
relay-domain-events-dev
relay-listing-commands-dev
relay-matching-commands-dev
relay-read-model-commands-dev
relay-notification-commands-dev
relay-domain-events-dlq-dev
relay-read-model-dlq-dev
relay-notification-dlq-dev
```

## ライセンス

自作のコード・資料は [MIT License](LICENSE) で公開しています。
外部ライブラリ・素材・フォントは各権利者のライセンスに従い、このMITライセンスでは再許諾しません。
ソース公開は、サービスの一般提供・ストア配布・本番運用の安全性を保証するものではありません。
