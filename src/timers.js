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
 *
 * Um cronometro pode ganhar tempo automaticamente de outro (`accrual`): a cada
 * X de contagem da fonte, soma Y ao seu proprio limite. O ganho vai para
 * `bonusMs`, separado de `totalTime`, para que a duracao configurada continue
 * visivel e o reset volte ao valor original sem precisar lembrar dele.
 *
 * O ganho e DERIVADO do decorrido da fonte, nunca somado passo a passo:
 *
 *     bonusMs = (floor(decorridoDaFonte / everyMs) - baseCount) * addMs
 *
 * `baseCount` e a contagem de concessoes em que o ganho vale zero, movida
 * apenas pelo Reset. Como a formula so le o estado atual, reaplicar a mesma
 * regra, perder um tick ou reconectar chega sempre ao mesmo numero - somar
 * incrementalmente duplicava o bonus a cada reenvio da regra.
 *
 * `offsetMs` e o tempo ja consumido fora deste cronometro: uma aula que ja
 * corre ha 5h15, ou um intervalo do qual ja se gastaram 30 minutos. Ele fica
 * separado de `elapsed` para que o Reset volte ao ponto de partida em vez de
 * zerar - zerar perderia a informacao.
 *
 * O consumo e guardado CRU, sem teto pelo total: um intervalo que ganha 5 min
 * por hora pode ter 30 minutos gastos quando so 25 foram concedidos. O excesso
 * fica visivel em `overspentMs` e e abatido sozinho conforme a regra concede
 * mais tempo. Limitar o consumo ao total no momento em que ele e informado
 * perderia essa divida e daria de presente um tempo que ja foi usado.
 */
const { randomBytes } = require("crypto");

const DIRECTIONS = new Set(["down", "up"]);

module.exports = {
  DIRECTIONS,
  buildTimerState,
  computeBonusMs,
  createTimer,
  getAccrualEarned,
  getElapsed,
  getOverspentMs,
  getRemaining,
  getStartElapsed,
  getTotalTime,
  isTimerFinished,
  pauseTimer,
  reanchorStartElapsed,
  resetAccrual,
  resetTimer,
  seekTimer,
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
    offsetMs: 0,
    bonusMs: 0,
    accrual: null,
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

  // Uma correcao de relogio para tras (NTP) deixa `startTime` no futuro. Sem o
  // piso em zero o decorrido ficaria negativo e o restante passaria do total,
  // emitindo `pct` acima de 1. O decorrido nunca anda para tras.
  return timer.elapsed + Math.max(0, Date.now() - timer.startTime);
}

/**
 * Limite efetivo: a duracao configurada mais o que foi ganho por regra.
 * @param {object} timer
 * @returns {number}
 */
function getTotalTime(timer) {
  return timer.totalTime + timer.bonusMs;
}

/**
 * Decorrido inicial: o consumo registrado, limitado ao total efetivo.
 *
 * O teto e aplicado AQUI, na leitura, e nao ao guardar: `offsetMs` mantem o
 * consumo real e este limite so impede que a contagem nasca estourada. Quando
 * a regra concede mais tempo, o teto sobe junto e a parte que estava excedendo
 * volta a ser contada - e assim que a divida se paga sozinha.
 *
 * @param {object} timer
 * @returns {number}
 */
function getStartElapsed(timer) {
  return Math.min(timer.offsetMs, getTotalTime(timer));
}

/**
 * Consumo registrado que ainda nao cabe no total efetivo.
 *
 * Um intervalo com 25 min ganhos e 30 min gastos esta 5 min no vermelho: o
 * cronometro mostra zero e este valor diz o quanto do proximo ganho ja esta
 * comprometido.
 *
 * @param {object} timer
 * @returns {number}
 */
function getOverspentMs(timer) {
  return Math.max(0, timer.offsetMs - getTotalTime(timer));
}

/**
 * Reposiciona um cronometro parado no seu ponto de partida atual.
 *
 * Chamado depois que o total efetivo cresce: o consumo que nao cabia passa a
 * caber e precisa entrar na contagem, senao o tempo recem-ganho apareceria
 * inteiro como disponivel mesmo ja tendo sido gasto.
 *
 * Nunca anda para tras (`elapsed` so cresce) e nao mexe em quem esta rodando -
 * um cronometro em andamento ja esta consumindo em tempo real.
 *
 * @param {object} timer
 * @returns {boolean} `true` se o decorrido mudou.
 */
function reanchorStartElapsed(timer) {
  if (timer.status === "running") return false;

  const start = getStartElapsed(timer);
  if (timer.elapsed >= start) return false;

  timer.elapsed = start;
  return true;
}

/**
 * Tempo que falta para o cronometro terminar, nunca negativo.
 * @param {object} timer
 * @returns {number}
 */
function getRemaining(timer) {
  return Math.max(0, getTotalTime(timer) - getElapsed(timer));
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
 * Volta ao inicio mantendo nome, direcao, total configurado e a regra de
 * ganho. O tempo ja ganho e descartado: reset e recomeco limpo, senao o
 * bonus da rodada anterior entraria somado na proxima.
 *
 * O consumo registrado tambem cai para o que a duracao configurada consegue
 * bancar. Sem isso, um intervalo com 30 min gastos sobre 25 min ganhos sairia
 * do Reset devendo esses 25 min - e a rodada nova ja comecaria zerada, o
 * oposto de recomeco limpo. O consumo que a propria duracao banca continua de
 * pe, porque `Reset` volta ao ponto de partida, nao a zero.
 *
 * @param {object} timer
 * @param {number} sourceElapsed decorrido atual da fonte da regra de ganho.
 */
function resetTimer(timer, sourceElapsed = 0) {
  resetAccrual(timer, sourceElapsed);
  timer.offsetMs = Math.min(timer.offsetMs, getTotalTime(timer));
  timer.elapsed = getStartElapsed(timer);
  timer.startTime = null;
  timer.status = "stopped";
}

/**
 * Reposiciona a contagem no ponto de partida informado, PRESERVANDO o tempo
 * ja ganho por regra.
 *
 * Informar quanto de um intervalo ja foi consumido nao pode apagar os minutos
 * que ele acumulou - sao coisas diferentes. So o Reset descarta o ganho.
 *
 * @param {object} timer
 * @param {number} offsetMs
 */
function seekTimer(timer, offsetMs) {
  timer.offsetMs = offsetMs;
  timer.elapsed = getStartElapsed(timer);
  timer.startTime = null;
  timer.status = "stopped";
}

/**
 * Descarta o tempo ganho comecando uma rodada nova.
 *
 * Como o bonus e derivado do decorrido da fonte, zerar `bonusMs` sozinho nao
 * bastaria: o proximo tick recalcularia tudo de volta. O que zera de verdade e
 * mover `baseCount` para a contagem de concessoes de agora, o novo zero da
 * regra.
 *
 * @param {object} timer
 * @param {number} sourceElapsed decorrido atual da fonte da regra.
 */
function resetAccrual(timer, sourceElapsed = 0) {
  timer.bonusMs = 0;
  if (timer.accrual) {
    timer.accrual.baseCount = getAccrualEarned(timer.accrual, sourceElapsed);
    timer.accrual.grantedCount = 0;
  }
}

/**
 * Quantas vezes a fonte ja completou o periodo da regra.
 * @param {object} rule
 * @param {number} sourceElapsed
 * @returns {number}
 */
function getAccrualEarned(rule, sourceElapsed) {
  if (!rule || rule.everyMs <= 0) return 0;
  return Math.floor(Math.max(0, sourceElapsed) / rule.everyMs);
}

/**
 * Tempo ganho a que o cronometro tem direito AGORA, do zero.
 *
 * Formula fechada em vez de soma incremental: o resultado depende so do estado
 * atual, entao reaplicar a regra, perder ticks ou reconectar nao muda nada.
 *
 * @param {object} timer
 * @param {number} sourceElapsed decorrido da fonte da regra.
 * @param {number} maxTimerMs teto absoluto de um cronometro.
 * @returns {number}
 */
function computeBonusMs(timer, sourceElapsed, maxTimerMs) {
  const rule = timer.accrual;
  if (!rule) return 0;

  const grants = Math.max(
    0,
    getAccrualEarned(rule, sourceElapsed) - rule.baseCount,
  );
  const teto = Math.max(0, maxTimerMs - timer.totalTime);

  return Math.min(grants * rule.addMs, teto);
}

/**
 * Estado enviado ao cliente. `elapsed` e `remaining` vao juntos para que a
 * tela escolha o que mostrar pela direcao, sem repetir a conta no servidor.
 * @param {object} timer
 * @returns {object}
 */
function buildTimerState(timer) {
  const totalTime = getTotalTime(timer);
  const remaining = getRemaining(timer);

  return {
    id: timer.id,
    name: timer.name,
    direction: timer.direction,
    status: timer.status,
    // `totalTime` vai efetivo porque e o que a tela mede; `baseTotalTime` e
    // `bonusMs` acompanham para a tela poder mostrar "25min + 15min ganhos".
    totalTime,
    baseTotalTime: timer.totalTime,
    bonusMs: timer.bonusMs,
    // `offsetMs` e o consumo cru; `startElapsed` e o quanto dele ja cabe no
    // total e `overspentMs` o que sobrou para o proximo ganho abater.
    offsetMs: timer.offsetMs,
    startElapsed: getStartElapsed(timer),
    overspentMs: getOverspentMs(timer),
    elapsed: Math.min(totalTime, getElapsed(timer)),
    remaining,
    pct: totalTime > 0 ? remaining / totalTime : 1,
    accrual: timer.accrual
      ? {
          sourceTimerId: timer.accrual.sourceTimerId,
          everyMs: timer.accrual.everyMs,
          addMs: timer.accrual.addMs,
          grantedCount: timer.accrual.grantedCount,
        }
      : null,
  };
}
