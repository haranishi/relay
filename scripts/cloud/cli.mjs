import console from "node:console";
import process from "node:process";
import { parseArgs } from "node:util";

export class CliError extends Error {}

export function parseCliArgs(args, options, usage) {
  try {
    return parseArgs({ args, options, allowPositionals: true });
  } catch {
    throw new CliError(usage);
  }
}

export async function runCli(meta, main) {
  if (!(meta.main ?? (meta.filename === process.argv[1]))) return;
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof CliError ? error.message : "処理を完了できませんでした。");
    process.exitCode = 1;
  }
}
