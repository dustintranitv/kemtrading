import dotenv from "dotenv";
import path from "path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "url";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });
dotenv.config();

const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID ?? 0);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH ?? "";
const TELEGRAM_PHONE_NUMBER = process.env.TELEGRAM_PHONE_NUMBER ?? "";

if (!Number.isFinite(TELEGRAM_API_ID) || TELEGRAM_API_ID <= 0) {
  throw new Error("TELEGRAM_API_ID is required and must be a positive number.");
}

if (!TELEGRAM_API_HASH) {
  throw new Error("TELEGRAM_API_HASH is required.");
}

const ask = async (rl: readline.Interface, label: string, fallback?: string) => {
  const value = (await rl.question(label)).trim();
  return value || fallback || "";
};

async function run() {
  const rl = readline.createInterface({ input, output });

  try {
    const phoneNumber = await ask(
      rl,
      `Phone number (${TELEGRAM_PHONE_NUMBER || "e.g. +8490..."}): `,
      TELEGRAM_PHONE_NUMBER,
    );

    if (!phoneNumber) {
      throw new Error("Phone number is required.");
    }

    const client = new TelegramClient(new StringSession(""), TELEGRAM_API_ID, TELEGRAM_API_HASH, {
      connectionRetries: 5,
    });

    await client.start({
      phoneNumber: async () => phoneNumber,
      phoneCode: async () => ask(rl, "Telegram login code: "),
      password: async () => ask(rl, "2FA password (if enabled, else Enter): "),
      onError: (error) => {
        console.error("Telegram auth error:", error);
      },
    });

    const session = client.session.save();
    console.log("\nTELEGRAM_STRING_SESSION (copy into worker/.env.local):\n");
    console.log(session);

    await client.disconnect();
  } finally {
    rl.close();
  }
}

run().catch((error) => {
  console.error("Create Telegram session failed:", error);
  process.exit(1);
});
