/**
 * Credenciais de admin da sessao.
 *
 * A senha nunca e guardada: fica apenas o resultado de `scrypt` com um sal
 * aleatorio por senha. `scrypt` vem do proprio Node, entao nao entra
 * dependencia nova nem compilacao nativa, e e deliberadamente caro - um
 * ataque de forca bruta paga esse custo a cada tentativa.
 *
 * A comparacao usa `timingSafeEqual` para o tempo de resposta nao denunciar
 * quantos bytes do hash bateram.
 */
const { randomBytes, scrypt, timingSafeEqual } = require("crypto");

const SALT_BYTES = 16;
const KEY_BYTES = 64;
const MAX_USERNAME_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 1;
const MAX_PASSWORD_LENGTH = 200;

module.exports = {
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  createCredentials,
  sanitizeUsername,
  verifyCredentials,
};

/**
 * @param {unknown} value
 * @returns {string} usuario normalizado, ou "" se nao servir.
 */
function sanitizeUsername(value) {
  if (typeof value !== "string") return "";

  return value
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, MAX_USERNAME_LENGTH);
}

function isUsablePassword(value) {
  return (
    typeof value === "string" &&
    value.length >= MIN_PASSWORD_LENGTH &&
    value.length <= MAX_PASSWORD_LENGTH
  );
}

/**
 * @param {string} username
 * @param {string} password
 * @returns {Promise<object|null>} `{username, salt, hash}` ou `null` se os
 * dados nao servirem. O objeto nunca contem a senha.
 */
async function createCredentials(username, password) {
  const safeUsername = sanitizeUsername(username);
  if (!safeUsername || !isUsablePassword(password)) return null;

  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt);

  return {
    username: safeUsername,
    salt: salt.toString("hex"),
    hash: hash.toString("hex"),
  };
}

/**
 * @param {object|null} credentials
 * @param {unknown} username
 * @param {unknown} password
 * @returns {Promise<boolean>}
 */
async function verifyCredentials(credentials, username, password) {
  if (!credentials || !isUsablePassword(password)) return false;

  const safeUsername = sanitizeUsername(username);
  // Usuario nao e segredo, mas comparar sem diferenciar maiuscula evita o
  // suporte de "meu login parou de funcionar" por causa de Caps Lock.
  if (safeUsername.toLowerCase() !== credentials.username.toLowerCase()) {
    // Ainda assim derivamos a chave, para uma resposta rapida nao revelar
    // que o usuario nao existe.
    await derive(password, Buffer.from(credentials.salt, "hex")).catch(() => null);
    return false;
  }

  let esperado;
  let obtido;
  try {
    esperado = Buffer.from(credentials.hash, "hex");
    obtido = await derive(password, Buffer.from(credentials.salt, "hex"));
  } catch {
    return false;
  }

  if (esperado.length !== obtido.length) return false;
  return timingSafeEqual(esperado, obtido);
}

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}
