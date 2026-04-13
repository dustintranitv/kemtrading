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
const MONITORED_GROUPS_ID = "monitored_groups" as const;
const applyMode = process.argv.includes("--apply");

const getMongoUri = (): string => {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is required.");
  }
  return MONGODB_URI;
};

const toSafeGroups = (value: unknown): Array<{ id: number; name: string; enabled: boolean }> => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => ({
    id: Number((item as any)?.id ?? 0),
    name: String((item as any)?.name ?? "Unknown"),
    enabled: Boolean((item as any)?.enabled),
  }));
};

async function run() {
  const client = new MongoClient(getMongoUri(), {
    appName: "railway.telegram.worker.reset-groups",
  });

  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const settings = db.collection("settings");

    const current = await settings.findOne({ _id: MONITORED_GROUPS_ID as any });
    const currentGroups = toSafeGroups((current as any)?.groups);

    console.log(`Current monitored groups: ${currentGroups.length}`);
    if (currentGroups.length > 0) {
      for (const group of currentGroups) {
        console.log(`- ${group.id} | ${group.name} | enabled=${group.enabled}`);
      }
    }

    if (!applyMode) {
      console.log("Dry-run mode. Re-run with --apply to clear monitored groups.");
      return;
    }

    const now = new Date();
    await settings.updateOne(
      { _id: MONITORED_GROUPS_ID as any },
      {
        $set: {
          groups: [],
          updated_at: now,
        },
        $setOnInsert: {
          _id: MONITORED_GROUPS_ID,
          created_at: now,
        },
      },
      { upsert: true },
    );

    const after = await settings.findOne({ _id: MONITORED_GROUPS_ID as any });
    const afterGroups = toSafeGroups((after as any)?.groups);
    console.log(`Reset complete. Current monitored groups: ${afterGroups.length}`);
  } finally {
    await client.close();
  }
}

run().catch((error) => {
  console.error("Reset monitored groups failed:", error);
  process.exit(1);
});
