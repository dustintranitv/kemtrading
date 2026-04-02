import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../../web/.env.local") });
dotenv.config();

const PORT = Number(process.env.PORT ?? 8080);
const BASE_URL = process.env.WORKER_BASE_URL ?? `http://localhost:${PORT}`;
const WORKER_TEST_TOKEN = process.env.WORKER_TEST_TOKEN ?? "";

const payload = {
  group_id: -1001001,
  group_name: "Manual_Test_Group",
  message_id: Date.now(),
  text: "BTC/USDT LONG 62000-62200 SL 61500 TP 64000 65000",
};

async function run() {
  const response = await fetch(`${BASE_URL}/test/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(WORKER_TEST_TOKEN ? { "x-worker-test-token": WORKER_TEST_TOKEN } : {}),
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  console.log(`POST ${BASE_URL}/test/ingest -> ${response.status}`);
  console.log(bodyText);

  if (!response.ok) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error("Test ingest failed:", error);
  process.exit(1);
});
