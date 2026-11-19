import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { CliError } from "./cli.mjs";

export const gatewaySecrets = ["RELAY_SESSION_KEY", "RELAY_INVITE_GIVER", "RELAY_INVITE_A", "RELAY_INVITE_B"];

export function defaultSecretsPath() {
  return join(homedir(), ".config/relay/pilot-secrets.json");
}

export async function readPilotSecrets(file = defaultSecretsPath()) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(() => { throw new CliError("Secret ファイルを開けませんでした。"); });
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o7777) !== 0o600) {
      throw new CliError("Secret ファイルの権限は 0600 にしてください。");
    }
    const secrets = JSON.parse(await handle.readFile("utf8"));
    if (!gatewaySecrets.every((key) => typeof secrets?.[key] === "string" && secrets[key].trim())) {
      throw new CliError("Secret ファイルに必要な4つのキーを設定してください。");
    }
    return Object.fromEntries(gatewaySecrets.map((key) => [key, secrets[key]]));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("Secret ファイルを読み取れませんでした。");
  } finally {
    await handle.close();
  }
}
