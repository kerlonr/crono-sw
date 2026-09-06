const path = require("path");

const ROOT_DIR = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

const PORT = parsePositiveInt(process.env.PORT, 3000);
const ENABLE_WEBHOOK = process.env.ENABLE_WEBHOOK === "true";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const WEBHOOK_DEPLOY_BRANCH = process.env.WEBHOOK_DEPLOY_BRANCH || "main";
const DEPLOYER_URL = process.env.DEPLOYER_URL || "http://deployer:8081/deploy";
const DEPLOYER_TIMEOUT_MS = parsePositiveInt(process.env.DEPLOYER_TIMEOUT_MS, 5000);
const SESSION_TTL_MS =
  parsePositiveInt(process.env.SESSION_TTL_MINUTES, 24 * 60) * 60 * 1000;
const SESSION_CLEANUP_MS =
  parsePositiveInt(process.env.SESSION_CLEANUP_MINUTES, 5) * 60 * 1000;
const MAX_TIMER_MS = 100 * 60 * 60 * 1000;
const DEFAULT_TIMER_MS = 5 * 60 * 1000;
const MAX_TIMERS_PER_SESSION = 12;
// Piso da regra de ganho: evita uma regra de 1s concedendo milhares de
// vezes ao longo de uma aula de 80 horas.
const MIN_ACCRUAL_EVERY_MS = 60 * 1000;
const MIN_ACCRUAL_ADD_MS = 1000;
const STATE_FILE = process.env.STATE_FILE || path.join(ROOT_DIR, "logs", "sessions.json");
const STATE_SAVE_MS =
  parsePositiveInt(process.env.STATE_SAVE_SECONDS, 5) * 1000;
const MAX_TIMER_NAME_LENGTH = 24;
const SESSION_ID_PATTERN = /^[a-f0-9]{8}$/i;
const ADMIN_TOKEN_PATTERN = /^[a-f0-9]{36}$/i;
const TIMER_ID_PATTERN = /^[a-f0-9]{6}$/i;
const ALLOWED_ORIGIN = normalizeOrigin(process.env.APP_ORIGIN);
const TRUST_PROXY = process.env.TRUST_PROXY === "true";

if (ENABLE_WEBHOOK && !WEBHOOK_SECRET) {
  throw new Error("ENABLE_WEBHOOK=true requires WEBHOOK_SECRET.");
}

module.exports = {
  ADMIN_TOKEN_PATTERN,
  ALLOWED_ORIGIN,
  DEFAULT_TIMER_MS,
  DEPLOYER_TIMEOUT_MS,
  DEPLOYER_URL,
  ENABLE_WEBHOOK,
  MAX_TIMER_MS,
  MAX_TIMER_NAME_LENGTH,
  MAX_TIMERS_PER_SESSION,
  MIN_ACCRUAL_ADD_MS,
  MIN_ACCRUAL_EVERY_MS,
  PORT,
  PUBLIC_DIR,
  SESSION_CLEANUP_MS,
  SESSION_ID_PATTERN,
  SESSION_TTL_MS,
  STATE_FILE,
  STATE_SAVE_MS,
  TIMER_ID_PATTERN,
  TRUST_PROXY,
  WEBHOOK_DEPLOY_BRANCH,
  WEBHOOK_SECRET,
};

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeOrigin(value) {
  if (!value) return null;

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
