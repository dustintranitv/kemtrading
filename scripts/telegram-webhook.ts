import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../../web/.env.local") });
dotenv.config();

type Command = "get" | "set" | "delete";

const command = (process.argv[2] ?? "get") as Command;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
const WORKER_BASE_URL = process.env.WORKER_BASE_URL ?? "";
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL ?? "";

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

const buildWebhookUrl = (): string => {
  if (TELEGRAM_WEBHOOK_URL) {
    return TELEGRAM_WEBHOOK_URL;
  }

  if (!WORKER_BASE_URL) {
    throw new Error("Set TELEGRAM_WEBHOOK_URL or WORKER_BASE_URL before running webhook:set.");
  }

  const baseUrl = trimTrailingSlash(WORKER_BASE_URL);
  return TELEGRAM_WEBHOOK_SECRET
    ? `${baseUrl}/webhook/telegram/${TELEGRAM_WEBHOOK_SECRET}`
    : `${baseUrl}/webhook/telegram`;
};

const validateCommand = (value: string): Command => {
  if (value === "get" || value === "set" || value === "delete") {
    return value;
  }
  throw new Error("Invalid command. Use: get | set | delete");
};

async function callTelegram(pathname: string, init?: RequestInit) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required.");
  }

  const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${pathname}`;
  const response = await fetch(endpoint, init);
  const text = await response.text();

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  console.log(JSON.stringify(payload, null, 2));

  if (!response.ok) {
    process.exit(1);
  }

  const telegramOk =
    typeof payload === "object" &&
    payload !== null &&
    "ok" in payload &&
    (payload as { ok?: boolean }).ok === true;

  if (!telegramOk) {
    process.exit(1);
  }
}

async function run() {
  const parsedCommand = validateCommand(command);

  if (parsedCommand === "get") {
    await callTelegram("getWebhookInfo");
    return;
  }

  if (parsedCommand === "delete") {
    await callTelegram("deleteWebhook", { method: "POST" });
    return;
  }

  const webhookUrl = buildWebhookUrl();
  const query = new URLSearchParams({ url: webhookUrl });
  await callTelegram(`setWebhook?${query.toString()}`, { method: "POST" });
}

run().catch((error) => {
  console.error("Telegram webhook command failed:", error);
  process.exit(1);
});
