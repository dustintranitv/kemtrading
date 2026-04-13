import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME ?? "stitch";
const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID ?? 0);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH ?? "";
const TELEGRAM_STRING_SESSION = process.env.TELEGRAM_STRING_SESSION ?? "";

const MONITORED_GROUPS_ID = "monitored_groups" as const;
const applyMode = process.argv.includes("--apply");

const getMongoUri = (): string => {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is required.");
  }
  return MONGODB_URI;
};

const toSafeNumber = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (value && typeof value === "object") {
    const asString = String(value);
    if (asString && asString !== "[object Object]") {
      const parsed = Number(asString);
      return Number.isFinite(parsed) ? parsed : 0;
    }
  }

  return 0;
};

const resolveDialogChatId = (dialog: any): number => {
  const entity = dialog?.entity as any;

  if (entity?.className === "Channel" || entity?.className === "ChannelForbidden") {
    return -Number(`100${toSafeNumber(entity.id)}`);
  }

  if (entity?.className === "Chat" || entity?.className === "ChatForbidden") {
    return -Math.abs(toSafeNumber(entity.id));
  }

  return toSafeNumber(dialog?.id);
};

async function run() {
  if (!Number.isFinite(TELEGRAM_API_ID) || TELEGRAM_API_ID <= 0) {
    throw new Error("TELEGRAM_API_ID is required and must be a positive number.");
  }

  if (!TELEGRAM_API_HASH) {
    throw new Error("TELEGRAM_API_HASH is required.");
  }

  if (!TELEGRAM_STRING_SESSION) {
    throw new Error("TELEGRAM_STRING_SESSION is required.");
  }

  const mongo = new MongoClient(getMongoUri(), {
    appName: "railway.telegram.worker.sync-groups",
  });

  const telegram = new TelegramClient(
    new StringSession(TELEGRAM_STRING_SESSION),
    TELEGRAM_API_ID,
    TELEGRAM_API_HASH,
    { connectionRetries: 5 },
  );

  try {
    await Promise.all([mongo.connect(), telegram.connect()]);

    const authorized = await telegram.checkAuthorization();
    if (!authorized) {
      throw new Error("Telegram user session is not authorized. Regenerate TELEGRAM_STRING_SESSION.");
    }

    const dialogs = await telegram.getDialogs({});
    const groups = dialogs
      .filter((dialog: any) => dialog.isGroup || dialog.isChannel)
      .map((dialog: any) => ({
        id: resolveDialogChatId(dialog),
        name: String(dialog.name || dialog.title || "Unknown"),
        enabled: true,
      }))
      .filter((item) => Number.isFinite(item.id) && item.id !== 0)
      .sort((a, b) => a.name.localeCompare(b.name));

    console.log(`Fetched groups/channels from Telegram: ${groups.length}`);
    for (const group of groups) {
      console.log(`- ${group.id} | ${group.name} | enabled=${group.enabled}`);
    }

    if (!applyMode) {
      console.log("Dry-run mode. Re-run with --apply to write groups into MongoDB settings.");
      return;
    }

    const settings = mongo.db(DB_NAME).collection("settings");
    const now = new Date();

    await settings.updateOne(
      { _id: MONITORED_GROUPS_ID as any },
      {
        $set: {
          groups,
          updated_at: now,
        },
        $setOnInsert: {
          _id: MONITORED_GROUPS_ID,
          created_at: now,
        },
      },
      { upsert: true },
    );

    console.log(`Saved ${groups.length} groups/channels into settings.${MONITORED_GROUPS_ID}.groups`);
  } finally {
    await Promise.all([telegram.disconnect(), mongo.close()]);
  }
}

run().catch((error) => {
  console.error("Sync monitored groups failed:", error);
  process.exit(1);
});
