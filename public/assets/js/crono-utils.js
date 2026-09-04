/**
 * Utilidades compartilhadas entre as telas (admin, viewer e overview).
 *
 * Concentra a formatacao de tempo, a sanitizacao do estado recebido do
 * servidor e as validacoes de identidade, evitando que cada tela mantenha sua
 * propria copia dessas funcoes.
 *
 * Exposto em `window.CronoUtils` porque o projeto carrega scripts simples
 * (IIFE, sem bundler) e mantem CSP `script-src 'self'`.
 */
(() => {
  const SESSION_ID_PATTERN = /^[a-f0-9]{8}$/i;
  const ADMIN_TOKEN_PATTERN = /^[a-f0-9]{36}$/i;
  const TIMER_ID_PATTERN = /^[a-f0-9]{6}$/i;
  const TIMER_STATUSES = new Set(["stopped", "running", "paused", "finished"]);
  const MAX_TIMER_NAME_LENGTH = 24;
  const MAX_TIMER_MS = 100 * 60 * 60 * 1000;
  // Espelham os limites de src/config.js: o cliente precisa deles para
  // validar antes de emitir e para desabilitar controles no limite.
  const MAX_TIMERS_PER_SESSION = 12;

  /**
   * Formata milissegundos como `HH:MM:SS`, arredondando para cima para que o
   * ultimo segundo so desapareca quando o tempo realmente zera. Horas nao sao
   * truncadas em duas casas: uma aula de 80 horas exibe `80:00:00`.
   * @param {number} ms
   * @returns {string}
   */
  function formatTime(ms) {
    const totalSeconds = Math.ceil(Math.max(0, sanitizeMs(ms)) / 1000);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);

    return [hours, minutes, seconds]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
  }

  /**
   * Versao curta usada em chips e legendas ("80h", "25 min", "1h 30m").
   * @param {number} ms
   * @returns {string}
   */
  function formatCompactDuration(ms) {
    const totalSeconds = Math.floor(sanitizeMs(ms) / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
    if (minutes > 0 && seconds > 0) return `${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes} min`;
    return `${seconds}s`;
  }

  /**
   * Quebra uma duracao nos campos do formulario de tempo.
   * @param {number} ms
   * @returns {{hours: number, minutes: number, seconds: number}}
   */
  function splitDuration(ms) {
    const totalSeconds = Math.floor(sanitizeMs(ms) / 1000);

    return {
      hours: Math.floor(totalSeconds / 3600),
      minutes: Math.floor((totalSeconds % 3600) / 60),
      seconds: totalSeconds % 60,
    };
  }

  /**
   * Converte um valor desconhecido em milissegundos validos (inteiro >= 0).
   * @param {unknown} value
   * @returns {number}
   */
  function sanitizeMs(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.trunc(parsed));
  }

  /**
   * Limita um percentual ao intervalo [0, 1]; usa 1 como padrao seguro.
   * @param {unknown} value
   * @returns {number}
   */
  function sanitizePct(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 1;
    return Math.min(1, Math.max(0, parsed));
  }

  /**
   * Mapeia o percentual restante para a fase visual do cronometro. Vale para
   * as duas direcoes: um progressivo tambem "esquenta" ao chegar na meta.
   * @param {number} pct
   * @returns {"blink"|"red"|"yellow"|"green"}
   */
  function getPhase(pct) {
    const safePct = sanitizePct(pct);
    if (safePct <= 0.1) return "blink";
    if (safePct <= 0.2) return "red";
    if (safePct <= 0.4) return "yellow";
    return "green";
  }

  /**
   * Normaliza o nome digitado pelo usuario, no mesmo formato que o servidor
   * aplica, para que a tela nao mostre um valor que sera recusado.
   * @param {unknown} value
   * @returns {string}
   */
  function sanitizeTimerName(value) {
    if (typeof value !== "string") return "";

    return value
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .trim()
      .slice(0, MAX_TIMER_NAME_LENGTH);
  }

  /**
   * Converte um cronometro recebido pelo socket em um objeto confiavel.
   * @param {unknown} raw
   * @param {number} index posicao na lista, usada no rotulo padrao.
   * @returns {object}
   */
  function sanitizeTimer(raw, index) {
    const source = raw && typeof raw === "object" ? raw : {};
    const totalTime = sanitizeMs(source.totalTime);
    const remaining = Math.min(totalTime, sanitizeMs(source.remaining));

    return {
      id: isValidTimerId(source.id) ? source.id : "",
      name: sanitizeTimerName(source.name),
      direction: source.direction === "up" ? "up" : "down",
      status: TIMER_STATUSES.has(source.status) ? source.status : "stopped",
      totalTime,
      remaining,
      elapsed: Math.min(totalTime, sanitizeMs(source.elapsed)),
      pct: sanitizePct(source.pct),
      index,
    };
  }

  /**
   * Normaliza o payload de `session:state`, garantindo lista e destaque validos.
   * @param {unknown} raw
   * @returns {{timers: object[], primaryTimerId: string|null}}
   */
  function sanitizeSessionState(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const timers = (Array.isArray(source.timers) ? source.timers : [])
      .map((timer, index) => sanitizeTimer(timer, index))
      .filter((timer) => timer.id);

    const hasPrimary = timers.some(
      (timer) => timer.id === source.primaryTimerId,
    );

    return {
      timers,
      primaryTimerId: hasPrimary
        ? source.primaryTimerId
        : (timers[0]?.id ?? null),
    };
  }

  /**
   * Tempo que a tela exibe: o progressivo mostra quanto ja passou, o
   * regressivo mostra quanto falta.
   * @param {object} timer
   * @returns {number}
   */
  function getDisplayMs(timer) {
    return timer.direction === "up" ? timer.elapsed : timer.remaining;
  }

  /**
   * Rotulo do cronometro, com um padrao quando o usuario ainda nao nomeou.
   * @param {object} timer
   * @returns {string}
   */
  function getTimerLabel(timer) {
    return timer.name || `Cronômetro ${timer.index + 1}`;
  }

  /**
   * Legenda do total, que muda de sentido conforme a direcao.
   * @param {object} timer
   * @returns {string}
   */
  function getTimerMetaLabel(timer) {
    const total = formatTime(timer.totalTime);
    return timer.direction === "up"
      ? `Progressivo · meta ${total}`
      : `Regressivo · duração ${total}`;
  }

  /**
   * @param {unknown} value
   * @returns {boolean} `true` se for um id de sessao valido.
   */
  function isValidSessionId(value) {
    return typeof value === "string" && SESSION_ID_PATTERN.test(value);
  }

  /**
   * @param {unknown} value
   * @returns {boolean} `true` se for um token de admin valido.
   */
  function isValidAdminToken(value) {
    return typeof value === "string" && ADMIN_TOKEN_PATTERN.test(value);
  }

  /**
   * @param {unknown} value
   * @returns {boolean} `true` se for um id de cronometro valido.
   */
  function isValidTimerId(value) {
    return typeof value === "string" && TIMER_ID_PATTERN.test(value);
  }

  window.CronoUtils = Object.freeze({
    MAX_TIMERS_PER_SESSION,
    MAX_TIMER_MS,
    MAX_TIMER_NAME_LENGTH,
    formatCompactDuration,
    formatTime,
    getDisplayMs,
    getPhase,
    getTimerLabel,
    getTimerMetaLabel,
    isValidAdminToken,
    isValidSessionId,
    isValidTimerId,
    sanitizeMs,
    sanitizePct,
    sanitizeSessionState,
    sanitizeTimer,
    sanitizeTimerName,
    splitDuration,
  });
})();
