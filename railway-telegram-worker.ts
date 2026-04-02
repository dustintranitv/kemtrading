import dotenv from "dotenv";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Collection, MongoClient } from "mongodb";
import { TelegramClient } from "telegram";
import { EditedMessage } from "telegram/events/EditedMessage.js";
import { NewMessage } from "telegram/events/index.js";
import { StringSession } from "telegram/sessions/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RegexCoin = new RegExp(process.env.REGEX_COIN || "eth|btc|bitcoin|bit", "i");

dotenv.config({ path: path.resolve(__dirname, ".env.local") });
dotenv.config({ path: path.resolve(__dirname, "../web/.env.local") });
dotenv.config();

type Action = "LONG" | "SHORT" | "NONE";

type SignalAnalysis = {
  is_signal: boolean;
  action: Action;
  symbol: string;
  entry: number[];
  stop_loss: number;
  take_profit: number[];
  confidence: number;
  reason: string;
  auto_trade: boolean;
};

type TelegramTrackingSetting = {
  _id: "telegram_tracking";
  telegram_tracking_enabled: boolean;
  updated_at: Date;
  created_at: Date;
};

type MonitoredGroupSetting = {
  _id: "monitored_groups";
  groups: Array<{ id: number; name: string; enabled: boolean }>;
  updated_at: Date;
  created_at: Date;
};

const PORT = Number(process.env.PORT ?? 8080);
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME ?? "stitch";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL ?? "gpt-4o";
const WORKER_TEST_TOKEN = process.env.WORKER_TEST_TOKEN ?? "";
const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID ?? 0);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH ?? "";
const TELEGRAM_STRING_SESSION = process.env.TELEGRAM_STRING_SESSION ?? "";
const TELEGRAM_CONNECTION_RETRIES = Number(process.env.TELEGRAM_CONNECTION_RETRIES ?? 5);
const TELEGRAM_TRACKING_SETTING_ID = "telegram_tracking" as const;

const MONITORED_CHAT_IDS = new Set(
  (process.env.MONITORED_CHAT_IDS ?? process.env.MONITORED_GROUP_IDS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

if (!MONGODB_URI) {
  throw new Error("MONGODB_URI is required.");
}

if (!Number.isFinite(TELEGRAM_API_ID) || TELEGRAM_API_ID <= 0) {
  throw new Error("TELEGRAM_API_ID is required and must be a positive number.");
}

if (!TELEGRAM_API_HASH) {
  throw new Error("TELEGRAM_API_HASH is required.");
}

if (!TELEGRAM_STRING_SESSION) {
  throw new Error("TELEGRAM_STRING_SESSION is required. Run npm run telegram:session to create one.");
}

const mongo = new MongoClient(MONGODB_URI, {
  appName: "railway.telegram.worker",
  maxIdleTimeMS: 5000,
});

let connectPromise: Promise<MongoClient> | null = null;

const connectMongo = async () => {
  if (!connectPromise) {
    connectPromise = mongo.connect();
  }
  return connectPromise;
};

const toMongoSafeObject = (value: unknown): unknown => {
  const seen = new WeakSet<object>();

  return JSON.parse(
    JSON.stringify(value, (_key, current) => {
      if (typeof current === "bigint") {
        return current.toString();
      }

      if (current && typeof current === "object") {
        if (seen.has(current)) {
          return undefined;
        }
        seen.add(current);
      }

      return current;
    }),
  );
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
    // GramJS sometimes exposes IDs as BigInteger-like objects.
    const asString = String(value);
    if (asString && asString !== "[object Object]") {
      const parsed = Number(asString);
      return Number.isFinite(parsed) ? parsed : 0;
    }
  }

  return 0;
};

const resolveTelegramChatId = (message: any, event: any): number => {
  const directChatId = toSafeNumber(event.chatId);
  if (directChatId !== 0) {
    return directChatId;
  }

  const peerId = message?.peerId;
  if (peerId?.channelId !== undefined) {
    return toSafeNumber(`-100${String(peerId.channelId)}`);
  }
  if (peerId?.chatId !== undefined) {
    return -Math.abs(toSafeNumber(peerId.chatId));
  }
  if (peerId?.userId !== undefined) {
    return toSafeNumber(peerId.userId);
  }

  return 0;
};

const toNumberArray = (value: unknown): number[] => {
  if (Array.isArray(value)) {
    return value
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item));
  }

  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? [asNumber] : [];
};

const normalizeAction = (value: unknown): Action => {
  const raw = String(value ?? "NONE").toUpperCase().trim();
  if (raw === "LONG" || raw === "BUY") {
    return "LONG";
  }
  if (raw === "SHORT" || raw === "SELL") {
    return "SHORT";
  }
  return "NONE";
};

const normalizeSymbol = (value: unknown): string => {
  const raw = String(value ?? "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[\/_-]/g, "");
  return raw;
};

const normalizeConfidence = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(1, parsed));
};

const normalizeAnalysis = (input: Partial<SignalAnalysis> | null | undefined): SignalAnalysis => {
  const action = normalizeAction(input?.action);
  const isSignal = Boolean(input?.is_signal) && action !== "NONE";

  return {
    is_signal: isSignal,
    action,
    symbol: normalizeSymbol(input?.symbol),
    entry: toNumberArray(input?.entry),
    stop_loss: Number(input?.stop_loss ?? 0) || 0,
    take_profit: toNumberArray(input?.take_profit),
    confidence: normalizeConfidence(input?.confidence),
    reason: String(input?.reason ?? ""),
    auto_trade: Boolean(input?.auto_trade),
  };
};

const heuristicAnalysis = (text: string): SignalAnalysis => {
  const upper = text.toUpperCase();
  const hasBuy = /\b(BUY|LONG)\b/.test(upper);
  const hasSell = /\b(SELL|SHORT)\b/.test(upper);
  const action: Action = hasBuy ? "LONG" : hasSell ? "SHORT" : "NONE";

  const symbolMatch = upper.match(/\b([A-Z]{2,10})\s*\/?\s*(USDT|USD|BTC|ETH)\b/);
  const symbol = symbolMatch ? `${symbolMatch[1]}${symbolMatch[2]}` : "";

  return {
    is_signal: action !== "NONE",
    action,
    symbol,
    entry: [],
    stop_loss: 0,
    take_profit: [],
    confidence: action === "NONE" ? 0.2 : 0.55,
    reason: action === "NONE" ? "No clear action command found." : "Detected explicit action keyword.",
    auto_trade: false,
  };
};

// ─── Image OCR via OpenAI Vision ────────────────────────────────────────────

const downloadTelegramPhoto = async (client: TelegramClient, message: any): Promise<Buffer | null> => {
  try {
    // GramJS stores photo as a single Photo object, not an array
    const photo = message.photo;
    if (!photo) return null;

    const buffer = await client.downloadMedia(message, {
      progressCallback: undefined,
    }) as Buffer | null;

    return buffer;
  } catch (err) {
    console.error("[image:download] failed:", err);
    return null;
  }
};

const extractImageTextWithOpenAI = async (imageBuffer: Buffer): Promise<string> => {
  if (!OPENAI_API_KEY) {
    console.warn("[image:ocr] OPENAI_API_KEY not set, skipping OCR.");
    return "";
  }

  const base64Image = imageBuffer.toString("base64");

  const payload = {
    model: OPENAI_VISION_MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Extract ALL text visible in this image exactly as written.",
              "Include numbers, symbols, percentages, and labels.",
              "Return plain text only, no markdown formatting.",
              "If no text is found, return an empty string.",
            ].join(" "),
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${base64Image}`,
              detail: "high",
            },
          },
        ],
      },
    ],
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI Vision API failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content ?? "";
  return content.trim();
};

// ─── Signal analysis ─────────────────────────────────────────────────────────

const analyzeWithOpenAI = async (text: string, groupName: string): Promise<SignalAnalysis> => {
  if (!OPENAI_API_KEY) {
    return heuristicAnalysis(text);
  }

  const systemPrompt = [
    "You are a crypto signal parser.",
    "Return only JSON with fields:",
    "is_signal (boolean), action (LONG|SHORT|NONE), symbol (string),",
    "entry (number[]), stop_loss (number), take_profit (number[]),",
    "confidence (0..1), reason (string), auto_trade (boolean).",
    "Set action=NONE when message is not an actionable command.",
    "If action is NONE then is_signal must be false.",
  ].join(" ");

  const payload = {
    model: OPENAI_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Group: ${groupName}\nMessage: ${text}`,
      },
    ],
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI returned empty content.");
  }

  const parsed = JSON.parse(content) as Partial<SignalAnalysis>;
  return normalizeAnalysis(parsed);
};

const processTelegramMessage = async (
  input: {
    updateId: number;
    messageId: number;
    date: Date;
    chatId: number;
    groupName: string;
    senderId: number;
    text: string;
    hasImage: boolean;
    imageExtractedText?: string;
    rawData: unknown;
    editedAt?: Date;
  },
  messages: Collection,
  signals: Collection,
  settings: Collection,
) => {
  const text = String(input.text ?? "").trim();
  if (!text) {
    console.log(`[ingest:skip] reason=no_text chat=${input.chatId} msg=${input.messageId}`);
    return { ok: true, ignored: "No text/caption to parse." };
  }

  const chatId = Number(input.chatId);
  if (chatId === 0) {
    console.log(`[ingest:warn] unresolved_chat_id chat=0 msg=${input.messageId}, writing to DB`);
  }

  const monitoredIds = await getMonitoredChatIds(settings);
  if (monitoredIds.size > 0 && chatId !== 0 && !monitoredIds.has(String(chatId))) {
    console.log(`[ingest:skip] reason=chat_filter chat=${chatId} msg=${input.messageId}`);
    return { ok: true, ignored: "Chat is not in monitored groups." };
  }

  let groupName = String(input.groupName ?? "Unknown Chat");
  if (groupName === "Unknown Chat" && chatId !== 0) {
    const monitoredDoc = await settings.findOne({ _id: "monitored_groups" as any });
    if (monitoredDoc && Array.isArray((monitoredDoc as any).groups)) {
      const match = (monitoredDoc as any).groups.find((g: any) => Number(g.id) === chatId);
      if (match?.name) {
        groupName = String(match.name);
      }
    }
  }
  const senderId = Number(input.senderId ?? 0);
  const tgMessageId = Number(input.messageId ?? 0);

  const messageDoc = {
    group_id: chatId,
    group_name: groupName,
    sender_id: senderId,
    ai_checked: Boolean(input.imageExtractedText) || RegexCoin.test(input.text),
    text,
    has_image: Boolean(input.hasImage),
    image_extracted_text: input.imageExtractedText ?? null,
    image_url: null,
    raw_tg_data: input.rawData,
    tg_chat_id: chatId,
    tg_message_id: tgMessageId,
    tg_update_id: Number(input.updateId ?? 0),
    updated_at: new Date(),
    ...(input.editedAt ? { edited_at: input.editedAt } : {}),
  };

  const dedupeFilter = {
    tg_chat_id: chatId,
    tg_message_id: tgMessageId,
  };

  const writeResult = await messages.updateOne(
    dedupeFilter,
    {
      $set: messageDoc,
      $setOnInsert: {
        created_at: input.date,
      },
    },
    { upsert: true },
  );

  console.log(
    `[ingest:db] chat=${chatId} msg=${tgMessageId} matched=${writeResult.matchedCount} modified=${writeResult.modifiedCount} upserted=${writeResult.upsertedCount}`,
  );

  const savedMessage = await messages.findOne(dedupeFilter);
  if (!savedMessage) {
    throw new Error("Message insert failed.");
  }

  let analysis: SignalAnalysis;
  // Image messages with extracted text always go through AI analysis.
  // For text-only messages, apply the RegexCoin keyword filter.
  const hasImageText = Boolean(input.imageExtractedText);
  const rawTextForFilter = input.imageExtractedText
    ? `${input.text} ${input.imageExtractedText}`
    : input.text;
  if (!hasImageText && !RegexCoin.test(rawTextForFilter)) {
    console.log(`[ingest:skip] reason=no_keyword chat=${chatId} msg=${tgMessageId}`);
    return { ok: true, ignored: "Message does not contain relevant keywords." };
  }
  try {
    analysis = await analyzeWithOpenAI(text, groupName);
  } catch (error) {
    console.error("OpenAI parse failed, fallback heuristic used:", error);
    analysis = heuristicAnalysis(text);
  }

  if (analysis.action !== "NONE") {
    await signals.insertOne({
      message_id: savedMessage._id,
      group_id: chatId,
      group_name: groupName,
      symbol: analysis.symbol,
      action: analysis.action,
      entry: analysis.entry,
      stop_loss: analysis.stop_loss,
      take_profit: analysis.take_profit,
      confidence: analysis.confidence,
      reason: analysis.reason,
      is_signal: true,
      auto_trade: analysis.auto_trade,
      status: "PENDING",
      created_at: new Date(),
    });
  }

  return {
    ok: true,
    message_id: String(savedMessage._id),
    created_signal: analysis.action !== "NONE",
    analysis,
  };
};

const ensureTelegramTrackingSetting = async (settings: Collection<TelegramTrackingSetting>) => {
  await settings.updateOne(
    { _id: TELEGRAM_TRACKING_SETTING_ID },
    {
      $setOnInsert: {
        _id: TELEGRAM_TRACKING_SETTING_ID,
        telegram_tracking_enabled: true,
        created_at: new Date(),
      },
      $set: {
        updated_at: new Date(),
      },
    },
    { upsert: true },
  );
};

const isTelegramTrackingEnabled = async (settings: Collection<TelegramTrackingSetting>) => {
  const doc = await settings.findOne({ _id: TELEGRAM_TRACKING_SETTING_ID });
  if (!doc) {
    return true;
  }
  return doc.telegram_tracking_enabled !== false;
};

const getMonitoredChatIds = async (settings: Collection): Promise<Set<string>> => {
  const doc = await settings.findOne({ _id: "monitored_groups" as any });
  if (doc && Array.isArray((doc as any).groups)) {
    const enabledIds = (doc as any).groups
      .filter((g: any) => g.enabled)
      .map((g: any) => String(g.id));
    if (enabledIds.length > 0) {
      return new Set(enabledIds);
    }
  }
  return MONITORED_CHAT_IDS;
};

const toDate = (value: unknown): Date => {
  const parsed = toSafeNumber(value);
  if (parsed > 0) {
    return new Date(parsed * 1000);
  }
  return new Date();
};

const buildIncomingMessage = async (event: any, telegramClient?: TelegramClient) => {
  const message = event?.message;
  if (!message) {
    return null;
  }

  const caption = String(message.message ?? "").trim();
  const hasPhoto = Boolean(message.photo);

  // Must have text OR a photo to be worth processing
  if (!caption && !hasPhoto) {
    return null;
  }

  const chat = await event.getChat();
  const groupName =
    String(chat?.title ?? chat?.username ?? "").trim() ||
    String(chat?.firstName ?? chat?.lastName ?? "").trim() ||
    "Unknown Chat";

  let finalText = caption;
  let imageExtractedText = "";

  // OCR: extract text from image
  if (hasPhoto && telegramClient) {
    try {
      console.log(`[image:ocr] Attempting OCR for msg=${toSafeNumber(message.id)}`);
      const imageBuffer = await downloadTelegramPhoto(telegramClient, message);
      if (imageBuffer && imageBuffer.length > 0) {
        imageExtractedText = await extractImageTextWithOpenAI(imageBuffer);
        if (imageExtractedText) {
          console.log(`[image:ocr] Extracted ${imageExtractedText.length} chars from image`);
          // Prepend with [IMAGE_TEXT] label so it's distinguishable in DB and UI
          const labeledImageText = `[IMAGE_TEXT]\n${imageExtractedText}`;
          finalText = caption
            ? `${caption}\n\n${labeledImageText}`
            : labeledImageText;
        } else {
          console.log(`[image:ocr] No text found in image for msg=${toSafeNumber(message.id)}`);
        }
      }
    } catch (err) {
      console.error(`[image:ocr] OCR failed for msg=${toSafeNumber(message.id)}:`, err);
    }
  }

  // If still no text (image had no extractable text and no caption), skip
  if (!finalText) {
    console.log(`[ingest:skip] reason=no_text_or_image_content msg=${toSafeNumber(message.id)}`);
    return null;
  }

  return {
    updateId: toSafeNumber(message.id),
    messageId: toSafeNumber(message.id),
    date: toDate(message.date),
    chatId: resolveTelegramChatId(message, event),
    groupName,
    senderId: toSafeNumber(event?.senderId),
    text: finalText,
    hasImage: hasPhoto,
    imageExtractedText: imageExtractedText || undefined,
    rawData: toMongoSafeObject(message),
    editedAt: message?.editDate ? toDate(message.editDate) : undefined,
  };
};

const logRawIncomingText = (
  eventType: "new" | "edited",
  incoming: {
    chatId: number;
    messageId: number;
    senderId: number;
    groupName: string;
    text: string;
  },
) => {
  const rawText = JSON.stringify(incoming.text);
  console.log(
    `[raw:${eventType}] chat=${incoming.chatId} msg=${incoming.messageId} sender=${incoming.senderId} group=${incoming.groupName} text=${rawText}`,
  );
};

const startTelegramIngest = async (
  messages: Collection,
  signals: Collection,
  settings: Collection<TelegramTrackingSetting>,
) => {
  const client = new TelegramClient(
    new StringSession(TELEGRAM_STRING_SESSION),
    TELEGRAM_API_ID,
    TELEGRAM_API_HASH,
    { connectionRetries: TELEGRAM_CONNECTION_RETRIES },
  );

  await client.connect();
  const authorized = await client.checkAuthorization();
  if (!authorized) {
    throw new Error("Telegram user session is not authorized. Re-generate TELEGRAM_STRING_SESSION.");
  }

  const me = await client.getMe();
  const username = String(me?.username ?? "").trim();
  const who = username || String(me?.id ?? "unknown");
  console.log(`Telegram user account connected: ${who}`);

  client.addEventHandler(
    async (event: any) => {
      try {
        const trackingEnabled = await isTelegramTrackingEnabled(settings);
        if (!trackingEnabled) {
          console.log("[ingest:skip] reason=tracking_disabled");
          return;
        }

        // Pass client so buildIncomingMessage can download photos for OCR
        const incoming = await buildIncomingMessage(event, client);
        if (!incoming) {
          return;
        }

        logRawIncomingText("new", incoming);

        const result = await processTelegramMessage(incoming, messages, signals, settings as unknown as Collection);
        if (result.created_signal) {
          console.log(
            `[signal] chat=${incoming.chatId} msg=${incoming.messageId} action=${result.analysis?.action} symbol=${result.analysis?.symbol}`,
          );
        }
      } catch (error) {
        console.error("Telegram event processing failed:", error);
      }
    },
    new NewMessage({ incoming: true, outgoing: true }),
  );

  client.addEventHandler(
    async (event: any) => {
      try {
        const trackingEnabled = await isTelegramTrackingEnabled(settings);
        if (!trackingEnabled) {
          console.log("[ingest:skip] reason=tracking_disabled");
          return;
        }

        // Pass client so buildIncomingMessage can download photos for OCR
        const incoming = await buildIncomingMessage(event, client);
        if (!incoming) {
          return;
        }

        logRawIncomingText("edited", incoming);

        const result = await processTelegramMessage(incoming, messages, signals, settings as unknown as Collection);
        if (result.created_signal) {
          console.log(
            `[signal] chat=${incoming.chatId} msg=${incoming.messageId} action=${result.analysis?.action} symbol=${result.analysis?.symbol}`,
          );
        }
      } catch (error) {
        console.error("Telegram edited-event processing failed:", error);
      }
    },
    new EditedMessage({ incoming: true, outgoing: true }),
  );

  return client;
};

async function bootstrap() {
  const client = await connectMongo();
  const db = client.db(DB_NAME);
  const messages = db.collection("messages");
  const signals = db.collection("signals");
  const settings = db.collection<TelegramTrackingSetting>("settings");

  await Promise.all([
    messages.createIndex({ created_at: -1 }),
    messages.createIndex(
      { tg_chat_id: 1, tg_message_id: 1 },
      {
        unique: true,
        partialFilterExpression: {
          tg_chat_id: { $type: "number" },
          tg_message_id: { $type: "number" },
        },
      },
    ),
    signals.createIndex({ created_at: -1 }),
  ]);

  await ensureTelegramTrackingSetting(settings);

  const telegramClient = await startTelegramIngest(messages, signals, settings);

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "railway-telegram-worker",
      time: new Date().toISOString(),
      telegram_connected: telegramClient.connected,
    });
  });

  app.get("/settings/telegram-tracking", async (_req, res) => {
    try {
      const enabled = await isTelegramTrackingEnabled(settings);
      return res.json({ ok: true, telegram_tracking_enabled: enabled });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ ok: false, error: message });
    }
  });

  app.post("/settings/telegram-tracking", async (req, res) => {
    try {
      const enabled = Boolean(req.body?.telegram_tracking_enabled);
      await settings.updateOne(
        { _id: TELEGRAM_TRACKING_SETTING_ID },
        {
          $set: {
            telegram_tracking_enabled: enabled,
            updated_at: new Date(),
          },
          $setOnInsert: {
            _id: TELEGRAM_TRACKING_SETTING_ID,
            created_at: new Date(),
          },
        },
        { upsert: true },
      );
      return res.json({ ok: true, telegram_tracking_enabled: enabled });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ ok: false, error: message });
    }
  });

  app.post("/test/ingest", async (req, res) => {
    try {
      if (WORKER_TEST_TOKEN) {
        const token = String(req.headers["x-worker-test-token"] ?? "");
        if (token !== WORKER_TEST_TOKEN) {
          return res.status(401).json({ ok: false, error: "Invalid test token." });
        }
      }

      const body = req.body ?? {};
      const now = Math.floor(Date.now() / 1000);
      const mockUpdate = {
        updateId: Number(body.update_id ?? Date.now()),
        messageId: Number(body.message_id ?? Date.now()),
        date: new Date(Number(body.date ?? now) * 1000),
        chatId: Number(body.group_id ?? body.chat_id ?? -1000000000000),
        groupName: String(body.group_name ?? "Manual_Test_Group"),
        senderId: Number(body.sender_id ?? 0),
        text: String(body.text ?? ""),
        hasImage: false,
        rawData: body,
      };

      const result = await processTelegramMessage(mockUpdate, messages, signals, settings as unknown as Collection);
      return res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Test ingest failed:", error);
      return res.status(500).json({ ok: false, error: message });
    }
  });

  app.get("/telegram/dialogs", async (_req, res) => {
    try {
      const dialogs = await telegramClient.getDialogs({});
      const result = dialogs
        .filter((d: any) => d.isGroup || d.isChannel)
        .map((d: any) => {
          let chatId: number;
          const entity = d.entity as any;
          if (entity?.className === "Channel" || entity?.className === "ChannelForbidden") {
            chatId = -Number(`100${toSafeNumber(entity.id)}`);
          } else if (entity?.className === "Chat" || entity?.className === "ChatForbidden") {
            chatId = -Math.abs(toSafeNumber(entity.id));
          } else {
            chatId = toSafeNumber(d.id);
          }
          const name = String(d.name || d.title || "Unknown");
          return {
            id: chatId,
            name,
            isGroup: Boolean(d.isGroup),
            isChannel: Boolean(d.isChannel),
          };
        });
      return res.json({ ok: true, data: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ ok: false, error: message });
    }
  });

  app.get("/settings/monitored-groups", async (_req, res) => {
    try {
      const doc = await settings.findOne({ _id: "monitored_groups" as any });
      const groups = doc && Array.isArray((doc as any).groups) ? (doc as any).groups : [];
      return res.json({ ok: true, data: { groups } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ ok: false, error: message });
    }
  });

  app.post("/settings/monitored-groups", async (req, res) => {
    try {
      const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];
      const sanitized = groups.map((g: any) => ({
        id: Number(g.id),
        name: String(g.name ?? "Unknown"),
        enabled: Boolean(g.enabled),
      }));

      await settings.updateOne(
        { _id: "monitored_groups" as any },
        {
          $set: {
            groups: sanitized,
            updated_at: new Date(),
          },
          $setOnInsert: {
            created_at: new Date(),
          },
        },
        { upsert: true },
      );

      return res.json({ ok: true, data: { groups: sanitized } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ ok: false, error: message });
    }
  });

  app.listen(PORT, () => {
    console.log(`Railway Telegram user worker listening on port ${PORT}`);
  });

  const shutdown = async () => {
    console.log("Shutting down worker...");
    await telegramClient.disconnect();
    await mongo.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

bootstrap().catch((error) => {
  console.error("Worker failed to start:", error);
  process.exit(1);
});
