/**
 * Modelo de um cronometro individual dentro de uma sessao.
 *
 * Uma sessao passou a conter varios cronometros (aula, tempo decorrido,
 * intervalo...), entao a logica de um cronometro isolado vive aqui e o
 * `sessions.js` cuida apenas da colecao e do broadcast.
 *
 * Regressivo e progressivo compartilham a mesma matematica: `elapsed` sempre
 * cresce e `remaining = totalTime - elapsed`. A direcao muda apenas qual dos
 * dois valores a tela exibe e o rotulo do total ("duracao" x "meta"), o que
 * evita dois caminhos de calculo e mantem o termino no mesmo ponto.
 */
const { randomBytes } = require("crypto");

const DIRECTIONS = new Set(["down", "up"]);

module.exports = {
  DIRECTIONS,
  buildTimerState,
  createTimer,
  getElapsed,
  getRemaining,
  isTimerFinished,
  pauseTimer,
  resetTimer,
  sanitizeDirection,
  sanitizeTimerName,
  startTimer,
};

/**
 * @param {object} options
 * @param {string[]} options.existingIds ids ja usados na sessao.
 * @param {number} options.totalTime duracao (regressivo) ou meta (progressivo).
 * @param {string} [options.name]
 * @param {string} [options.direction]
 * @param {number} options.maxNameLength
 * @returns {object} cronometro parado, pronto para uso.
 */
function createTimer({
  direction,
  existingIds,
  maxNameLength,
  name,
  totalTime,
}) {
  return {
    id: createTimerId(existingIds),
    name: sanitizeTimerName(name, maxNameLength),
    direction: sanitizeDirection(direction),
    status: "stopped",
    elapsed: 0,
    startTime: null,
    totalTime,
  };
}

function createTimerId(existingIds) {
  const taken = new Set(existingIds);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = randomBytes(3).toString("hex");
    if (!taken.has(id)) {
      return id;
    }
  }

  throw new Error("Unable to allocate a unique timer id.");
}

/**
 * Remove controles, corta no limite e cai para "" quando o nome nao serve.
 * Quem chama decide o rotulo padrao, porque ele depende da posicao na lista.
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string}
 */
function sanitizeTimerName(value, maxLength) {
  if (typeof value !== "string") return "";

  return value
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxLength);
}

/**
 * @param {unknown} value
 * @returns {"down"|"up"} "down" e o padrao para qualquer entrada invalida.
 */
function sanitizeDirection(value) {
  return DIRECTIONS.has(value) ? value : "down";
}

/**
 * Tempo decorrido incluindo o trecho em andamento.
 * @param {object} timer
 * @returns {number}
 */
function getElapsed(timer) {
  if (timer.status !== "running" || timer.startTime === null) {
    return timer.elapsed;
  }

  return timer.elapsed + (Date.now() - timer.startTime);
}

/**
 * Tempo que falta para o cronometro terminar, nunca negativo.
 * @param {object} timer
 * @returns {number}
 */
function getRemaining(timer) {
  return Math.max(0, timer.totalTime - getElapsed(timer));
}

/**
 * @param {object} timer
 * @returns {boolean} `true` quando ja atingiu o total.
 */
function isTimerFinished(timer) {
  return getRemaining(timer) <= 0;
}

/**
 * @param {object} timer
 * @returns {boolean} `true` se o cronometro passou a rodar agora.
 */
function startTimer(timer) {
  if (timer.status === "running" || isTimerFinished(timer)) {
    return false;
  }

  timer.startTime = Date.now();
  timer.status = "running";
  return true;
}

/**
 * @param {object} timer
 * @returns {boolean} `true` se o cronometro passou a pausar agora.
 */
function pauseTimer(timer) {
  if (timer.status !== "running") {
    return false;
  }

  timer.elapsed = getElapsed(timer);
  timer.startTime = null;
  timer.status = "paused";
  return true;
}

/**
 * Volta ao inicio mantendo nome, direcao e total.
 * @param {object} timer
 */
function resetTimer(timer) {
  timer.elapsed = 0;
  timer.startTime = null;
  timer.status = "stopped";
}

/**
 * Estado enviado ao cliente. `elapsed` e `remaining` vao juntos para que a
 * tela escolha o que mostrar pela direcao, sem repetir a conta no servidor.
 * @param {object} timer
 * @returns {object}
 */
function buildTimerState(timer) {
  const remaining = getRemaining(timer);

  return {
    id: timer.id,
    name: timer.name,
    direction: timer.direction,
    status: timer.status,
    totalTime: timer.totalTime,
    elapsed: Math.min(timer.totalTime, getElapsed(timer)),
    remaining,
    pct: timer.totalTime > 0 ? remaining / timer.totalTime : 1,
  };
}
