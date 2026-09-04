/**
 * Snapshot das sessoes em disco.
 *
 * As sessoes vivem em memoria, entao um reinicio do processo levava tudo
 * junto - inaceitavel numa contagem de 80 horas. Este modulo grava o estado
 * periodicamente e no desligamento, e recarrega no boot.
 *
 * Os cronometros que estavam rodando voltam rodando com o `startTime`
 * original: `elapsed + (agora - startTime)` inclui o tempo em que o processo
 * esteve fora, que e exatamente o que se espera de um cronometro de parede -
 * a aula nao parou porque o servidor reiniciou.
 */
const fs = require("fs");
const path = require("path");

const VERSION = 1;

module.exports = {
  createSnapshotStore,
};

/**
 * @param {object} options
 * @param {string} options.filePath arquivo do snapshot.
 * @param {number} options.intervalMs periodo entre gravacoes.
 * @param {Function} options.logEvent
 */
function createSnapshotStore({ filePath, intervalMs, logEvent }) {
  let timer = null;

  return { load, save, start, stop };

  /**
   * @returns {object[]} sessoes lidas do disco, ou lista vazia.
   */
  function load() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        logEvent("snapshot_read_failed", { message: error.message });
      }
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version !== VERSION || !Array.isArray(parsed.sessions)) {
        logEvent("snapshot_ignored", { reason: "formato_incompativel" });
        return [];
      }

      logEvent("snapshot_loaded", {
        sessions: parsed.sessions.length,
        savedAt: new Date(parsed.savedAt || 0).toISOString(),
      });
      return parsed.sessions;
    } catch (error) {
      logEvent("snapshot_parse_failed", { message: error.message });
      return [];
    }
  }

  /**
   * Grava de forma atomica: escreve em um temporario e renomeia, para um
   * desligamento no meio da escrita nao deixar um arquivo truncado.
   * @param {object[]} sessions
   */
  function save(sessions) {
    const payload = JSON.stringify({
      version: VERSION,
      savedAt: Date.now(),
      sessions,
    });

    const tempPath = `${filePath}.tmp`;

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tempPath, payload);
      fs.renameSync(tempPath, filePath);
      return true;
    } catch (error) {
      logEvent("snapshot_write_failed", { message: error.message });
      return false;
    }
  }

  function start(collect) {
    stop();
    timer = setInterval(() => save(collect()), intervalMs);
    timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }
}
