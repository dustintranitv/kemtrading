import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME ?? "stitch";

const getMongoUri = (): string => {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is required.");
  }
  return MONGODB_URI;
};

const applyMode = process.argv.includes("--apply");

const invalidKeyFilter = {
  $or: [
    { tg_chat_id: { $exists: false } },
    { tg_message_id: { $exists: false } },
    { tg_chat_id: null },
    { tg_message_id: null },
    { tg_chat_id: { $type: "string" } },
    { tg_message_id: { $type: "string" } },
  ],
};

async function run() {
  const client = new MongoClient(getMongoUri(), { appName: "railway.telegram.worker.cleanup" });

  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const messages = db.collection("messages");

    const invalidCount = await messages.countDocuments(invalidKeyFilter);
    console.log(`Invalid message rows matching cleanup filter: ${invalidCount}`);

    if (!applyMode) {
      console.log("Dry-run mode. Re-run with --apply to delete invalid rows.");
      return;
    }

    const result = await messages.deleteMany(invalidKeyFilter);
    console.log(`Deleted rows: ${result.deletedCount}`);
  } finally {
    await client.close();
  }
}

run().catch((error) => {
  console.error("Cleanup failed:", error);
  process.exit(1);
});
