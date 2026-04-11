import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });
dotenv.config();

const PORT = Number(process.env.PORT ?? 8080);
const BASE_URL = process.env.WORKER_BASE_URL ?? `http://localhost:${PORT}`;
const WORKER_TEST_TOKEN = process.env.WORKER_TEST_TOKEN ?? "";

type AnalysisExpectation = {
  action?: string;
  command?: string;
  symbol?: string;
  close_percent?: number;
  dca_ratio?: string;
  binance_order_type?: string;
  is_signal?: boolean;
};

type ScenarioStep = {
  name: string;
  payload: {
    group_id: number;
    group_name: string;
    sender_id: number;
    message_id: number;
    text: string;
  };
  expect: AnalysisExpectation;
};

type IngestResponse = {
  ok: boolean;
  ignored?: string;
  error?: string;
  created_signal?: boolean;
  analysis?: {
    is_signal?: boolean;
    action?: string;
    command?: string;
    symbol?: string;
    close_percent?: number;
    dca_ratio?: string;
    binance_order_type?: string;
  };
};

const createStep = (
  offset: number,
  groupId: number,
  groupName: string,
  text: string,
  expect: AnalysisExpectation,
): ScenarioStep => ({
  name: text,
  payload: {
    group_id: groupId,
    group_name: groupName,
    sender_id: 900001,
    message_id: Date.now() + offset,
    text,
  },
  expect,
});

const signalScenarios = () => {
  const seed = Date.now();
  const longGroupId = -110000000001 - (seed % 10000);
  const shortGroupId = longGroupId - 1;
  const manageGroupId = longGroupId - 2;

  return [
    createStep(
      1,
      longGroupId,
      "Test_Long_Group",
      "BTCUSDT LONG entry 62000 62100 SL 61500 TP 63000 63500",
      {
        is_signal: true,
        action: "LONG",
        command: "OPEN_LONG",
        symbol: "BTCUSDT",
        binance_order_type: "LIMIT",
      },
    ),
    createStep(
      2,
      shortGroupId,
      "Test_Short_Group",
      "ETHUSDT SHORT entry 3200 SL 3260 TP 3120 3080",
      {
        is_signal: true,
        action: "SHORT",
        command: "OPEN_SHORT",
        symbol: "ETHUSDT",
        binance_order_type: "LIMIT",
      },
    ),
    createStep(
      3,
      manageGroupId,
      "Test_Manage_Group",
      "BTCUSDT LONG entry 62000 SL 61500 TP 63000",
      {
        is_signal: true,
        action: "LONG",
        command: "OPEN_LONG",
        symbol: "BTCUSDT",
      },
    ),
    createStep(
      4,
      manageGroupId,
      "Test_Manage_Group",
      "Set SL 61650 for current position",
      {
        is_signal: true,
        action: "LONG",
        command: "MOVE_SL",
        symbol: "BTCUSDT",
        binance_order_type: "STOP_MARKET",
      },
    ),
    createStep(
      5,
      manageGroupId,
      "Test_Manage_Group",
      "Move TP to 63200 and 63800",
      {
        is_signal: true,
        action: "LONG",
        command: "MOVE_TP",
        symbol: "BTCUSDT",
        binance_order_type: "TAKE_PROFIT_MARKET",
      },
    ),
    createStep(
      6,
      manageGroupId,
      "Test_Manage_Group",
      "Close 50% now",
      {
        is_signal: true,
        action: "LONG",
        command: "CLOSE_PARTIAL",
        symbol: "BTCUSDT",
        close_percent: 50,
        binance_order_type: "MARKET",
      },
    ),
    createStep(
      7,
      manageGroupId,
      "Test_Manage_Group",
      "DCA 1-1 at 61850",
      {
        is_signal: true,
        action: "LONG",
        command: "DCA",
        symbol: "BTCUSDT",
        dca_ratio: "1:1",
        binance_order_type: "LIMIT",
      },
    ),
  ];
};

const assertEqual = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
};

const runStep = async (step: ScenarioStep) => {
  const response = await fetch(`${BASE_URL}/test/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(WORKER_TEST_TOKEN ? { "x-worker-test-token": WORKER_TEST_TOKEN } : {}),
    },
    body: JSON.stringify(step.payload),
  });

  const body = (await response.json()) as IngestResponse;

  if (!response.ok || !body.ok) {
    throw new Error(`[${step.name}] request failed: ${body.error ?? JSON.stringify(body)}`);
  }

  if (body.ignored) {
    throw new Error(`[${step.name}] message was ignored: ${body.ignored}`);
  }

  const analysis = body.analysis;
  if (!analysis) {
    throw new Error(`[${step.name}] missing analysis payload.`);
  }

  for (const [key, expectedValue] of Object.entries(step.expect)) {
    const actualValue = analysis[key as keyof typeof analysis];
    assertEqual(`[${step.name}] ${key}`, actualValue, expectedValue);
  }

  console.log(`PASS ${step.name}`);
  console.log(JSON.stringify(analysis, null, 2));
};

const configureMonitoredGroups = async (steps: ScenarioStep[]) => {
  const groups = Array.from(
    new Map(
      steps.map((step) => [
        step.payload.group_id,
        {
          id: step.payload.group_id,
          name: step.payload.group_name,
          enabled: true,
        },
      ]),
    ).values(),
  );

  const response = await fetch(`${BASE_URL}/settings/monitored-groups`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(WORKER_TEST_TOKEN ? { "x-worker-test-token": WORKER_TEST_TOKEN } : {}),
    },
    body: JSON.stringify({ groups }),
  });

  const body = (await response.json()) as { ok?: boolean; error?: string };
  if (!response.ok || !body.ok) {
    throw new Error(`Failed to configure monitored groups: ${body.error ?? JSON.stringify(body)}`);
  }

  console.log(`Configured ${groups.length} monitored test groups.`);
};

async function run() {
  const steps = signalScenarios();

  console.log(`Running ${steps.length} Telegram signal test cases against ${BASE_URL}`);

  await configureMonitoredGroups(steps);

  for (const step of steps) {
    await runStep(step);
  }

  console.log("All Telegram signal test cases passed.");
}

run().catch((error) => {
  console.error("Telegram signal test cases failed:", error);
  process.exit(1);
});