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
const RegexCoin = new RegExp(
  process.env.REGEX_COIN
    || "eth|btc|bitcoin|bit|long|short|buy|sell|close|exit|take.?profit|stop.?loss|\\btp\\b|\\bsl\\b|entry|usdt|dca|breakeven|partial",
  "i",
);

dotenv.config({ path: path.resolve(__dirname, ".env.local") });
dotenv.config();

type Action = "LONG" | "SHORT" | "NONE";

type TradeCommand =
  | "OPEN_LONG"
  | "OPEN_SHORT"
  | "CLOSE_FULL"
  | "CLOSE_PARTIAL"
  | "SET_TP"
  | "SET_SL"
  | "MOVE_TP"
  | "MOVE_SL"
  | "DCA"
  | "NONE";

type BinanceOrderType = "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET" | "NONE";

type BinancePayload = {
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT";
  type: Exclude<BinanceOrderType, "NONE">;
  price?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  closePosition?: boolean;
  workingType: "MARK_PRICE" | "CONTRACT_PRICE";
  timeInForce?: "GTC" | "IOC" | "FOK";
  /** The trade command that generated this payload */
  _command: TradeCommand;
  /** For CLOSE_PARTIAL: percentage of position to close (0-100) */
  _closePercent?: number;
  /** For DCA: ratio string e.g. "1:1" */
  _dcaRatio?: string;
};

type SignalAnalysis = {
  is_signal: boolean;
  action: Action;
  command: TradeCommand;
  symbol: string;
  entry: number[];
  stop_loss: number;
  take_profit: number[];
  close_percent: number;
  dca_ratio: string;
  confidence: number;
  reason: string;
  auto_trade: boolean;
  binance_order_type: BinanceOrderType;
};

type RecentMessageContext = {
  messageId: number;
  senderId: number;
  text: string;
  createdAt: Date | null;
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
const AUTO_TRADE_SETTING_ID = "auto_trade" as const;
const DISABLE_TELEGRAM_INGEST = /^(1|true|yes)$/i.test(process.env.DISABLE_TELEGRAM_INGEST ?? "");

const hasAuthKeyDuplicatedError = (error: unknown): boolean => {
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error ?? "");

  return /AUTH_KEY_DUPLICATED/i.test(detail);
};

const MONITORED_CHAT_IDS = new Set(
  (process.env.MONITORED_CHAT_IDS ?? process.env.MONITORED_GROUP_IDS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

if (!MONGODB_URI) {
  throw new Error("MONGODB_URI is required.");
}

if (!DISABLE_TELEGRAM_INGEST && (!Number.isFinite(TELEGRAM_API_ID) || TELEGRAM_API_ID <= 0)) {
  throw new Error("TELEGRAM_API_ID is required and must be a positive number.");
}

if (!DISABLE_TELEGRAM_INGEST && !TELEGRAM_API_HASH) {
  throw new Error("TELEGRAM_API_HASH is required.");
}

if (!DISABLE_TELEGRAM_INGEST && !TELEGRAM_STRING_SESSION) {
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

const stripDiacritics = (value: string): string => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const truncateText = (value: string, maxLength = 280): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
};

const shouldAnalyzeText = (value: string): boolean => {
  const raw = String(value ?? "");
  const normalized = stripDiacritics(raw).toLowerCase();
  return RegexCoin.test(raw) || RegexCoin.test(normalized);
};

const extractSymbolFromText = (value: string): string => {
  const upper = String(value ?? "").toUpperCase();
  const symbolMatch = upper.match(/\b([A-Z]{2,12})(USDT|USD|BTC|ETH|BNB)\b/)
    || upper.match(/\b([A-Z]{2,12})\s*\/?\s*(USDT|USD|BTC|ETH|BNB)\b/);

  if (!symbolMatch) {
    return "";
  }

  return `${symbolMatch[1]}${symbolMatch[2]}`;
};

const detectActionFromText = (value: string): Action => {
  const upper = String(value ?? "").toUpperCase();
  if (/\b(LONG|BUY)\b/.test(upper)) {
    return "LONG";
  }
  if (/\b(SHORT|SELL)\b/.test(upper)) {
    return "SHORT";
  }
  return "NONE";
};

const getContextSignalHints = (recentMessages: RecentMessageContext[]): { symbol: string; action: Action } => {
  for (const message of [...recentMessages].reverse()) {
    const symbol = extractSymbolFromText(message.text);
    const action = detectActionFromText(message.text);
    if (symbol || action !== "NONE") {
      return {
        symbol,
        action,
      };
    }
  }

  return { symbol: "", action: "NONE" };
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

const normalizeCommand = (value: unknown): TradeCommand => {
  const raw = String(value ?? "NONE").toUpperCase().trim().replace(/[\s-]+/g, "_");

  if (["OPEN_LONG", "LONG", "BUY"].includes(raw)) {
    return "OPEN_LONG";
  }
  if (["OPEN_SHORT", "SHORT", "SELL"].includes(raw)) {
    return "OPEN_SHORT";
  }
  if (["CLOSE", "CLOSE_FULL", "EXIT", "CLOSE_ALL"].includes(raw)) {
    return "CLOSE_FULL";
  }
  if (["CLOSE_PARTIAL", "PARTIAL_CLOSE", "TAKE_PARTIAL"].includes(raw)) {
    return "CLOSE_PARTIAL";
  }
  if (["SET_TP", "TAKE_PROFIT", "SET_TAKE_PROFIT"].includes(raw)) {
    return "SET_TP";
  }
  if (["SET_SL", "STOP_LOSS", "SET_STOP_LOSS"].includes(raw)) {
    return "SET_SL";
  }
  if (["MOVE_TP", "UPDATE_TP", "CHANGE_TP", "EDIT_TP"].includes(raw)) {
    return "MOVE_TP";
  }
  if (["MOVE_SL", "UPDATE_SL", "CHANGE_SL", "EDIT_SL", "BREAKEVEN", "BE"].includes(raw)) {
    return "MOVE_SL";
  }
  if (raw === "DCA") {
    return "DCA";
  }
  return "NONE";
};

const normalizeBinanceOrderType = (value: unknown): BinanceOrderType => {
  const raw = String(value ?? "NONE").toUpperCase().trim().replace(/[\s-]+/g, "_");
  if (raw === "MARKET" || raw === "LIMIT" || raw === "STOP_MARKET" || raw === "TAKE_PROFIT_MARKET") {
    return raw;
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

const normalizeDcaRatio = (value: unknown): string => {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }

  const match = raw.match(/(\d+(?:\.\d+)?)\s*[-:/]\s*(\d+(?:\.\d+)?)/);
  if (!match) {
    return raw;
  }

  return `${match[1]}:${match[2]}`;
};

const inferBinanceOrderType = (
  command: TradeCommand,
  entry: number[],
  stopLoss: number,
  takeProfit: number[],
): BinanceOrderType => {
  if (command === "SET_SL" || command === "MOVE_SL") {
    return "STOP_MARKET";
  }

  if (command === "SET_TP" || command === "MOVE_TP") {
    return "TAKE_PROFIT_MARKET";
  }

  if (command === "OPEN_LONG" || command === "OPEN_SHORT" || command === "DCA") {
    return entry.length > 0 ? "LIMIT" : "MARKET";
  }

  if (command === "CLOSE_FULL" || command === "CLOSE_PARTIAL") {
    return "MARKET";
  }

  if (stopLoss > 0) {
    return "STOP_MARKET";
  }

  if (takeProfit.length > 0) {
    return "TAKE_PROFIT_MARKET";
  }

  return "NONE";
};

const calculateConfidence = (
  command: TradeCommand,
  action: Action,
  symbol: string,
  entry: number[],
  stopLoss: number,
  takeProfit: number[],
  closePercent: number,
  dcaRatio: string,
  hasImage: boolean,
): { confidence: number; reason: string } => {
  if (command === "NONE") {
    return { confidence: 0, reason: "No actionable trading command detected." };
  }

  let score = 0.2;
  const factors = [`Command: ${command}`];

  if (symbol) {
    score += 0.2;
    factors.push(`Symbol: ${symbol}`);
  } else {
    factors.push("Missing: Symbol");
  }

  if (action !== "NONE") {
    score += 0.15;
    factors.push(`Side: ${action}`);
  }

  if (entry.length > 0) {
    score += 0.15;
    factors.push(`Entry: ${entry.join(", ")}`);
  }

  if (stopLoss > 0) {
    score += 0.1;
    factors.push(`SL: ${stopLoss}`);
  }

  if (takeProfit.length > 0) {
    score += 0.1;
    factors.push(`TP: ${takeProfit.join(", ")}`);
  }

  if (closePercent > 0) {
    score += 0.05;
    factors.push(`Close: ${closePercent}%`);
  }

  if (dcaRatio) {
    score += 0.05;
    factors.push(`DCA: ${dcaRatio}`);
  }

  if (hasImage) {
    score += 0.05;
    factors.push("Source: image OCR");
  }

  return {
    confidence: Math.min(1, Math.round(score * 100) / 100),
    reason: factors.join(" | "),
  };
};

const normalizeAnalysis = (input: Partial<SignalAnalysis> | null | undefined, hasImage = false): SignalAnalysis => {
  let action = normalizeAction(input?.action);
  let command = normalizeCommand(input?.command);
  const symbol = normalizeSymbol(input?.symbol);
  const entry = toNumberArray(input?.entry);
  const stopLoss = Number(input?.stop_loss ?? 0) || 0;
  const takeProfit = toNumberArray(input?.take_profit);
  const closePercent = Math.max(0, Math.min(100, Number(input?.close_percent ?? 0) || 0));
  const dcaRatio = normalizeDcaRatio(input?.dca_ratio);

  if (command === "NONE" && action === "LONG") {
    command = "OPEN_LONG";
  }
  if (command === "NONE" && action === "SHORT") {
    command = "OPEN_SHORT";
  }
  if (action === "NONE" && command === "OPEN_LONG") {
    action = "LONG";
  }
  if (action === "NONE" && command === "OPEN_SHORT") {
    action = "SHORT";
  }

  const isSignal = Boolean(input?.is_signal ?? command !== "NONE") && command !== "NONE";
  const generatedConfidence = calculateConfidence(
    command,
    action,
    symbol,
    entry,
    stopLoss,
    takeProfit,
    closePercent,
    dcaRatio,
    hasImage,
  );
  const normalizedOrderType = normalizeBinanceOrderType(input?.binance_order_type);
  const binanceOrderType = normalizedOrderType !== "NONE"
    ? normalizedOrderType
    : inferBinanceOrderType(command, entry, stopLoss, takeProfit);

  return {
    is_signal: isSignal,
    action,
    command,
    symbol,
    entry,
    stop_loss: stopLoss,
    take_profit: takeProfit,
    close_percent: closePercent,
    dca_ratio: dcaRatio,
    confidence: normalizeConfidence(input?.confidence ?? generatedConfidence.confidence),
    reason: String(input?.reason ?? generatedConfidence.reason),
    auto_trade: Boolean(input?.auto_trade),
    binance_order_type: binanceOrderType,
  };
};

const buildBinancePayload = (signal: SignalAnalysis): BinancePayload | null => {
  if (!signal.symbol || signal.command === "NONE") {
    return null;
  }

  const isLong = signal.action === "LONG";
  const side = isLong ? ("BUY" as const) : ("SELL" as const);
  const oppositeSide = isLong ? ("SELL" as const) : ("BUY" as const);
  const positionSide = isLong ? ("LONG" as const) : ("SHORT" as const);

  switch (signal.command) {
    case "OPEN_LONG":
    case "OPEN_SHORT": {
      const hasEntry = signal.entry.length > 0;
      const payload: BinancePayload = {
        symbol: signal.symbol,
        side: signal.command === "OPEN_LONG" ? "BUY" : "SELL",
        positionSide: signal.command === "OPEN_LONG" ? "LONG" : "SHORT",
        type: hasEntry ? "LIMIT" : "MARKET",
        workingType: "MARK_PRICE",
        _command: signal.command,
      };
      if (hasEntry) {
        payload.price = signal.entry[0];
        payload.timeInForce = "GTC";
      }
      return payload;
    }

    case "CLOSE_FULL": {
      return {
        symbol: signal.symbol,
        side: oppositeSide,
        positionSide,
        type: "MARKET",
        closePosition: true,
        workingType: "MARK_PRICE",
        _command: signal.command,
      };
    }

    case "CLOSE_PARTIAL": {
      return {
        symbol: signal.symbol,
        side: oppositeSide,
        positionSide,
        type: "MARKET",
        reduceOnly: true,
        workingType: "MARK_PRICE",
        _command: signal.command,
        _closePercent: signal.close_percent > 0 ? signal.close_percent : 50,
      };
    }

    case "SET_TP":
    case "MOVE_TP": {
      if (signal.take_profit.length === 0) {
        return null;
      }
      return {
        symbol: signal.symbol,
        side: oppositeSide,
        positionSide,
        type: "TAKE_PROFIT_MARKET",
        stopPrice: signal.take_profit[0],
        reduceOnly: true,
        workingType: "MARK_PRICE",
        _command: signal.command,
      };
    }

    case "SET_SL":
    case "MOVE_SL": {
      if (signal.stop_loss <= 0) {
        return null;
      }
      return {
        symbol: signal.symbol,
        side: oppositeSide,
        positionSide,
        type: "STOP_MARKET",
        stopPrice: signal.stop_loss,
        reduceOnly: true,
        workingType: "MARK_PRICE",
        _command: signal.command,
      };
    }

    case "DCA": {
      const hasEntry = signal.entry.length > 0;
      const payload: BinancePayload = {
        symbol: signal.symbol,
        side,
        positionSide,
        type: hasEntry ? "LIMIT" : "MARKET",
        workingType: "MARK_PRICE",
        _command: signal.command,
        ...(signal.dca_ratio ? { _dcaRatio: signal.dca_ratio } : {}),
      };
      if (hasEntry) {
        payload.price = signal.entry[0];
        payload.timeInForce = "GTC";
      }
      return payload;
    }

    default:
      return null;
  }
};

const heuristicAnalysis = (text: string, recentMessages: RecentMessageContext[] = []): SignalAnalysis => {
  const normalizedText = stripDiacritics(text).toLowerCase();
  const currentAction = detectActionFromText(text);
  const currentSymbol = extractSymbolFromText(text);
  const contextHints = getContextSignalHints(recentMessages);

  let command: TradeCommand = "NONE";
  let action: Action = currentAction !== "NONE" ? currentAction : contextHints.action;
  const symbol = currentSymbol || contextHints.symbol;

  if (/\b(long|buy)\b/i.test(text)) {
    command = "OPEN_LONG";
  } else if (/\b(short|sell)\b/i.test(text)) {
    command = "OPEN_SHORT";
  } else if (/(close all|close|exit|dong lenh|thoat lenh)/i.test(normalizedText)) {
    command = "CLOSE_FULL";
  }

  const partialCloseMatch = normalizedText.match(/(?:chot|close)\s*(\d{1,3})\s*%/i);
  if (partialCloseMatch) {
    command = "CLOSE_PARTIAL";
  }

  if (/\bdca\b/i.test(normalizedText)) {
    command = "DCA";
  }

  if (/(move|doi|change|update|edit)\s*(tp|take profit)|\bbe\b|breakeven/.test(normalizedText)) {
    command = /(tp|take profit)/.test(normalizedText) ? "MOVE_TP" : "MOVE_SL";
  } else if (/(move|doi|change|update|edit)\s*(sl|stop loss)/.test(normalizedText)) {
    command = "MOVE_SL";
  } else if (/\b(tp|take profit)\b/.test(normalizedText) && command === "NONE") {
    command = "SET_TP";
  } else if (/\b(sl|stop loss)\b/.test(normalizedText) && command === "NONE") {
    command = "SET_SL";
  }

  if (action === "NONE") {
    if (command === "OPEN_LONG") {
      action = "LONG";
    } else if (command === "OPEN_SHORT") {
      action = "SHORT";
    }
  }

  const entryMatches = [...text.matchAll(/(?:entry|gia vao lenh|vao lenh)[:\s]*([0-9]+(?:\.[0-9]+)?)/gi)];
  const entry = entryMatches.map((match) => Number(match[1])).filter((value) => Number.isFinite(value));

  const slMatches = [...text.matchAll(/(?:stop[_\s-]?loss|\bsl\b)[:\s]*([0-9]+(?:\.[0-9]+)?)/gi)];
  const stopLoss = slMatches.length > 0 ? Number(slMatches[slMatches.length - 1][1]) : 0;

  const tpMatches = [...text.matchAll(/(?:take[_\s-]?profit|\btp\b)[:\s]*([0-9]+(?:\.[0-9]+)?)/gi)];
  const takeProfit = tpMatches.map((match) => Number(match[1])).filter((value) => Number.isFinite(value));

  const dcaRatioMatch = normalizedText.match(/\bdca\b[^\n\r\d]{0,12}(\d+(?:\.\d+)?)\s*[-:/]\s*(\d+(?:\.\d+)?)/i);
  const closePercent = partialCloseMatch ? Number(partialCloseMatch[1]) : 0;

  return normalizeAnalysis(
    {
      is_signal: command !== "NONE",
      action,
      command,
      symbol,
      entry,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      close_percent: closePercent,
      dca_ratio: dcaRatioMatch ? `${dcaRatioMatch[1]}:${dcaRatioMatch[2]}` : "",
      reason: command === "NONE" ? "No clear action command found." : "Heuristic parser matched a trading command.",
      auto_trade: false,
    },
    false,
  );
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

const analyzeWithOpenAI = async (
  text: string,
  groupName: string,
  recentMessages: RecentMessageContext[],
  hasImage = false,
): Promise<SignalAnalysis> => {
  if (!OPENAI_API_KEY) {
    return heuristicAnalysis(text, recentMessages);
  }

  const recentMessagesContext = recentMessages.length > 0
    ? recentMessages
        .map((message, index) => {
          const dateLabel = message.createdAt ? message.createdAt.toISOString() : "unknown_time";
          return `${index + 1}. [${dateLabel}] sender=${message.senderId} msg=${message.messageId}: ${truncateText(message.text, 220)}`;
        })
        .join("\n")
    : "No recent message context.";

  const systemPrompt = [
    "You are a crypto futures signal parser for Binance.",
    "Use the current message plus the 10 most recent messages from the same Telegram group to infer intent.",
    "Many follow-up messages depend on context, for example: close order, set TP, set SL, move TP, move SL, partial close 50%, DCA 1-1.",
    "Infer the symbol and side from recent context when the current message omits them.",
    "Return only JSON with fields:",
    "is_signal (boolean), action (LONG|SHORT|NONE), command (OPEN_LONG|OPEN_SHORT|CLOSE_FULL|CLOSE_PARTIAL|SET_TP|SET_SL|MOVE_TP|MOVE_SL|DCA|NONE),",
    "symbol (string), entry (number[]), stop_loss (number), take_profit (number[]), close_percent (number), dca_ratio (string),",
    "confidence (0..1), reason (string), auto_trade (boolean), binance_order_type (MARKET|LIMIT|STOP_MARKET|TAKE_PROFIT_MARKET|NONE).",
    "Rules:",
    "- OPEN_LONG or OPEN_SHORT is for a new entry order.",
    "- CLOSE_FULL is for closing the active position completely.",
    "- CLOSE_PARTIAL is for partial close, for example 'close 50%' or 'chot 50%'.",
    "- SET_TP or SET_SL is for assigning take-profit or stop-loss to the current position.",
    "- MOVE_TP or MOVE_SL is for updating an existing TP/SL, including breakeven or BE instructions.",
    "- DCA is for averaging into the current position. If the message says '1-1' or similar, store it in dca_ratio.",
    "- For Binance order types: OPEN or DCA with entry price => LIMIT, otherwise MARKET; SL => STOP_MARKET; TP => TAKE_PROFIT_MARKET; CLOSE => MARKET unless an explicit exit price is given.",
    "- If there is no actionable trading instruction, set command=NONE, action=NONE, is_signal=false.",
    "- If command is not NONE, is_signal must be true.",
  ].join(" ");

  const payload = {
    model: OPENAI_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Group: ${groupName}\nRecent context:\n${recentMessagesContext}\n\nCurrent message:\n${text}`,
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
  return normalizeAnalysis(parsed, hasImage);
};

const getRecentGroupMessages = async (
  messages: Collection,
  chatId: number,
  currentMessageId: number,
  limit = 10,
): Promise<RecentMessageContext[]> => {
  if (!Number.isFinite(chatId) || chatId === 0) {
    return [];
  }

  const docs = await messages
    .find({
      tg_chat_id: chatId,
      tg_message_id: { $ne: currentMessageId },
    })
    .sort({ created_at: -1, tg_message_id: -1 })
    .limit(limit)
    .toArray();

  return docs
    .map((doc: any) => ({
      messageId: Number(doc?.tg_message_id ?? 0),
      senderId: Number(doc?.sender_id ?? 0),
      text: String(doc?.text ?? "").trim(),
      createdAt: doc?.created_at instanceof Date ? doc.created_at : null,
    }))
    .filter((doc) => doc.messageId !== 0 && doc.text)
    .reverse();
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
    ai_checked: Boolean(input.imageExtractedText) || shouldAnalyzeText(input.text),
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
  if (!hasImageText && !shouldAnalyzeText(rawTextForFilter)) {
    console.log(`[ingest:skip] reason=no_keyword chat=${chatId} msg=${tgMessageId}`);
    return { ok: true, ignored: "Message does not contain relevant keywords." };
  }

  const recentMessages = await getRecentGroupMessages(messages, chatId, tgMessageId, 10);

  try {
    analysis = await analyzeWithOpenAI(text, groupName, recentMessages, hasImageText);
  } catch (error) {
    console.error("OpenAI parse failed, fallback heuristic used:", error);
    analysis = heuristicAnalysis(text, recentMessages);
  }

  const binancePayload = buildBinancePayload(analysis);

  if (analysis.command !== "NONE") {
    await signals.insertOne({
      message_id: savedMessage._id,
      source_message: {
        text,
        has_image: Boolean(input.hasImage),
        image_extracted_text: input.imageExtractedText ?? null,
        tg_chat_id: chatId,
        tg_message_id: tgMessageId,
        sender_id: senderId,
        created_at: input.date,
      },
      group_id: chatId,
      group_name: groupName,
      symbol: analysis.symbol,
      action: analysis.action,
      command: analysis.command,
      entry: analysis.entry,
      stop_loss: analysis.stop_loss,
      take_profit: analysis.take_profit,
      close_percent: analysis.close_percent,
      dca_ratio: analysis.dca_ratio,
      confidence: analysis.confidence,
      reason: analysis.reason,
      is_signal: true,
      auto_trade: analysis.auto_trade,
      binance_order_type: analysis.binance_order_type,
      binance_payload: binancePayload,
      context_messages: recentMessages.map((message) => ({
        message_id: message.messageId,
        sender_id: message.senderId,
        text: truncateText(message.text, 220),
        created_at: message.createdAt,
      })),
      status: "PENDING",
      created_at: new Date(),
    });
  }

  return {
    ok: true,
    message_id: String(savedMessage._id),
    created_signal: analysis.command !== "NONE",
    analysis,
    binance_payload: binancePayload,
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

  let telegramClient: TelegramClient | null = null;
  let telegramIngestDisabled = DISABLE_TELEGRAM_INGEST;

  if (!telegramIngestDisabled) {
    try {
      telegramClient = await startTelegramIngest(messages, signals, settings);
    } catch (error) {
      if (!hasAuthKeyDuplicatedError(error)) {
        throw error;
      }

      telegramIngestDisabled = true;
      console.error("Telegram startup skipped because AUTH_KEY_DUPLICATED was returned by Telegram.");
      console.error("Resolve by stopping other active clients and re-generating TELEGRAM_STRING_SESSION (npm run telegram:session).");
      console.error("Worker will continue with HTTP endpoints enabled and Telegram ingest disabled.");
    }
  }

  if (telegramIngestDisabled) {
    if (DISABLE_TELEGRAM_INGEST) {
      console.log("Telegram ingest disabled via DISABLE_TELEGRAM_INGEST. HTTP test endpoints are still available.");
    } else {
      console.log("Telegram ingest disabled after startup failure. HTTP endpoints are still available.");
    }
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "railway-telegram-worker",
      time: new Date().toISOString(),
      telegram_connected: telegramClient?.connected ?? false,
      telegram_ingest_disabled: telegramIngestDisabled,
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
      if (!telegramClient) {
        return res.status(503).json({
          ok: false,
          error: "Telegram ingest is disabled. Enable Telegram startup to fetch dialogs.",
        });
      }

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

  app.get("/settings/auto-trade", async (_req, res) => {
    try {
      const doc = await settings.findOne({ _id: AUTO_TRADE_SETTING_ID as any });
      const enabled = doc ? Boolean((doc as any).auto_trade_enabled) : false;
      return res.json({ ok: true, auto_trade_enabled: enabled });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ ok: false, error: message });
    }
  });

  app.post("/settings/auto-trade", async (req, res) => {
    try {
      const enabled = Boolean(req.body?.auto_trade_enabled);
      await settings.updateOne(
        { _id: AUTO_TRADE_SETTING_ID as any },
        {
          $set: {
            auto_trade_enabled: enabled,
            updated_at: new Date(),
          },
          $setOnInsert: {
            _id: AUTO_TRADE_SETTING_ID as any,
            created_at: new Date(),
          },
        },
        { upsert: true },
      );
      return res.json({ ok: true, auto_trade_enabled: enabled });
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
    if (telegramClient) {
      await telegramClient.disconnect();
    }
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
