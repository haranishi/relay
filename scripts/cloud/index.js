// node --test にディレクトリを渡すと、Node は index.js を読み込む。
void Promise.all([
  import("./apply-migrations.test.mjs"),
  import("./gen-secrets.test.mjs"),
  import("./provision-secrets.test.mjs"),
  import("./reset-pilot-data.test.mjs"),
  import("./smoke.test.mjs")
]);
