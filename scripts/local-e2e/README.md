# ローカル通し検証

クラウドへはつなぎません。先に `lsof -nP -iTCP:8787 -iTCP:8081 -iTCP:8082 -iTCP:8083 -iTCP:8084 -iTCP:9230 -sTCP:LISTEN` で待受が空なことを確かめてください。

リポジトリのルートで `node scripts/local-e2e/run.mjs` を実行します。実行のたびに招待コードと署名鍵を作り、`workers/api-gateway/.dev.vars` に書きます。値は標準出力に出ません。sqld を4つと `wrangler dev --local` を起動し、3人がログインして出品から完了までを通し、終わったら子プロセスを止めます。

`node scripts/local-e2e/run.mjs --serve` は、同じ起動のあと `GET /api/v1/health` が 200 になるまで待ち、招待コードを `/tmp/relay-e2e/invite-codes.json`（権限 0600）に書いて止まります。`SIGINT` または `SIGTERM` で、起動した子プロセスを止めて終わります。`apps/web/.open-next/worker.js` があるときは、Web も同じポートで出します。

成功すると終了コードは 0 です。ログと DB、Wrangler の状態は `/tmp/relay-e2e/` に残ります。
