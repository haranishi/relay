import console from "node:console";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { CliError, parseCliArgs, runCli } from "./cli.mjs";
import { defaultSecretsPath, gatewaySecrets } from "./pilot-secrets.mjs";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const usage = "使い方: node scripts/cloud/gen-secrets.mjs [出力先のパス]";

function generateSecrets() {
  const invites = new Set();
  while (invites.size < 3) {
    const code = Array.from(randomBytes(20), (byte) => alphabet[byte & 31]).join("");
    invites.add(code.match(/.{5}/g).join("-"));
  }
  const values = [randomBytes(32).toString("hex"), ...invites];
  return Object.fromEntries(gatewaySecrets.map((key, index) => [key, values[index]]));
}

export async function main(args, { log = console.log } = {}) {
  const { positionals } = parseCliArgs(args, {}, usage);
  if (positionals.length > 1) throw new CliError(usage);
  const file = resolve(positionals[0] ?? defaultSecretsPath());
  const parent = dirname(file);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await lstat(parent);
  if (!directory.isDirectory() || (directory.mode & 0o7777) !== 0o700) {
    throw new CliError("出力先の親ディレクトリの権限は 0700 にしてください。");
  }

  const handle = await open(file, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") throw new CliError("出力先のファイルが既にあります。");
    throw new CliError("Secret ファイルを作成できませんでした。");
  });
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(generateSecrets(), null, 2)}\n`);
  } catch {
    await unlink(file).catch(() => {});
    throw new CliError("Secret ファイルに書き込めませんでした。");
  } finally {
    await handle.close();
  }
  log(`${file} を作成しました（${gatewaySecrets.length}キー）。`);
}

await runCli(import.meta, main);
