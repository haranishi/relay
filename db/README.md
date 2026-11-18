# Turso databases

Matching DBには応募受付の追加条件もあります。既存の番号付きMigrationに続けて `db/matching/0004_application_open.sql` を1回適用してください。

Relayはサービス境界ごとに4つのTurso DBを利用します。

- `community`: コミュニティと在籍資格
- `listing`: 出品の正本とOutbox
- `matching`: 応募・候補順位・受渡し・Outbox
- `read-model`: 一覧検索に最適化した投影

Matching DBの追加Migrationはファイル名順に1回ずつ適用します。
`db/matching/0003_listing_keys.sql` は既存の再送記録を対応する出品に引き継ぎます。

適用例:

```bash
turso db shell relay-community-dev < db/community/0001_initial.sql
turso db shell relay-community-dev < db/community/demo_seed.sql
turso db shell relay-listing-dev < db/listing/0001_initial.sql
turso db shell relay-matching-dev < db/matching/0001_initial.sql
turso db shell relay-matching-dev < db/matching/0002_handoff_transition.sql
turso db shell relay-read-model-dev < db/read-model/0001_initial.sql
```

出品・一覧DBでは、初期テーブルの作成後、Workerの更新前に次の追加Migrationをそれぞれ1回適用します。

```bash
turso db shell relay-listing-dev < db/listing/0002_matching_revision.sql
turso db shell relay-read-model-dev < db/read-model/0002_matching_revision.sql
```

`turso db shell relay-matching-dev < db/matching/0003_listing_keys.sql`

各Workerの `TURSO_DATABASE_URL` と `TURSO_AUTH_TOKEN` は `wrangler secret put` で個別登録します。
