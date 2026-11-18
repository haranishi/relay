# Turso databases

Relayはサービス境界ごとに4つのTurso DBを利用します。

- `community`: コミュニティと在籍資格
- `listing`: 出品の正本とOutbox
- `matching`: 応募・候補順位・受渡し・Outbox
- `read-model`: 一覧検索に最適化した投影

## Migrationの適用

DBごとに、ファイル名の番号順に、1ファイルを1回だけ適用します。
**Workerを更新する前に適用してください。** 新しいWorkerは、追加した列・トリガー・索引があることを前提にします。

| DB | 初回 | 追加（番号順） |
|---|---|---|
| community | `0001_initial.sql`、デモ用に `demo_seed.sql` | なし |
| listing | `0001_initial.sql` | `0002_matching_revision.sql`（出品の変更番号を足す） |
| matching | `0001_initial.sql` | `0002_handoff_transition.sql`（終了した受渡しの状態変更を拒む）<br>`0003_listing_keys.sql`（再送用キーを出品ごとに分け、既存の記録を引き継ぐ）<br>`0004_application_open.sql`（募集中でない出品への応募を拒む） |
| read-model | `0001_initial.sql` | `0002_matching_revision.sql`（一覧に変更番号を足す） |

適用例（開発用のDB）:

```bash
turso db shell relay-community-dev < db/community/0001_initial.sql
turso db shell relay-community-dev < db/community/demo_seed.sql
turso db shell relay-listing-dev < db/listing/0001_initial.sql
turso db shell relay-listing-dev < db/listing/0002_matching_revision.sql
turso db shell relay-matching-dev < db/matching/0001_initial.sql
turso db shell relay-matching-dev < db/matching/0002_handoff_transition.sql
turso db shell relay-matching-dev < db/matching/0003_listing_keys.sql
turso db shell relay-matching-dev < db/matching/0004_application_open.sql
turso db shell relay-read-model-dev < db/read-model/0001_initial.sql
turso db shell relay-read-model-dev < db/read-model/0002_matching_revision.sql
```

`0003_listing_keys.sql` は、既存の再送記録を、対応する受渡しの出品に結び付けて引き継ぎます。
対応する受渡しが無い記録は、出品が分からず再送の判定に使えないので、引き継がずに捨てます。
捨てられる件数は、既存のDBに適用する前に、次で確かめられます。

```bash
turso db shell relay-matching-dev "SELECT count(*) FROM idempotency_keys k LEFT JOIN handoffs h ON h.id = k.resource_id WHERE h.id IS NULL;"
```

各Workerの `TURSO_DATABASE_URL` と `TURSO_AUTH_TOKEN` は `wrangler secret put` で個別登録します。
