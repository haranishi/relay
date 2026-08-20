# Turso databases

Relayはサービス境界ごとに4つのTurso DBを利用します。

- `community`: コミュニティと在籍資格
- `listing`: 出品の正本とOutbox
- `matching`: 応募・候補順位・受渡し・Outbox
- `read-model`: 一覧検索に最適化した投影

適用例:

```bash
turso db shell relay-community-dev < db/community/0001_initial.sql
turso db shell relay-community-dev < db/community/demo_seed.sql
turso db shell relay-listing-dev < db/listing/0001_initial.sql
turso db shell relay-matching-dev < db/matching/0001_initial.sql
turso db shell relay-read-model-dev < db/read-model/0001_initial.sql
```

各Workerの `TURSO_DATABASE_URL` と `TURSO_AUTH_TOKEN` は `wrangler secret put` で個別登録します。
