# ローカル通し検証

クラウドへはつなぎません。

## 必要なもの

- `lsof`（macOS 標準）。
- `sqld`（libSQL のサーバー）を `~/.turso/sqld` に置く。入手先は、[tursodatabase/libsql](https://github.com/tursodatabase/libsql) のリリース（`libsql-server`）。動作を確かめた版は 0.24.32。無いときは、スクリプトが、準備の案内を出して中止する。
- `pnpm install` と `pnpm cf-typegen` を済ませ、`pnpm -r --filter './packages/**' build` で共有パッケージを作っておく。
- `workers/*/.dev.vars` に、自分で作った本物の設定があるときは、何も書かずに中止する（退避してから実行する）。

先に `lsof -nP -iTCP:8787 -iTCP:8081 -iTCP:8082 -iTCP:8083 -iTCP:8084 -iTCP:9230 -sTCP:LISTEN` で待受が空なことを確かめてください。

リポジトリのルートで `node scripts/local-e2e/run.mjs` を実行します。実行のたびに招待コードと署名鍵を作り、`workers/api-gateway/.dev.vars` に書きます。値は標準出力に出ません。sqld を4つと `wrangler dev --local` を起動し、3人がログインして出品から完了までを通し、終わったら子プロセスを止めます。

`node scripts/local-e2e/run.mjs --serve` は、同じ起動のあと `GET /api/v1/health` が 200 になるまで待ち、招待コードを `/tmp/relay-e2e/invite-codes.json`（権限 0600）に書いて止まります。`SIGINT` または `SIGTERM` で、起動した子プロセスを止めて終わります。`apps/web/.open-next/worker.js` があるときは、Web も同じポートで出します。

成功すると終了コードは 0 です。ログと DB、Wrangler の状態は `/tmp/relay-e2e/` に残ります。
