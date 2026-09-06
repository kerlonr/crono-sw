const express = require("express");
const fs = require("fs");
const helmet = require("helmet");
const http = require("http");
const path = require("path");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const config = require("./src/config");
const { triggerDeploy } = require("./src/deploy-client");
const {
  formatTimerMs,
  getLogFile,
  getRequestIp,
  logAccess,
  logEvent,
} = require("./src/logger");
const {
  getBranchFromRef,
  isAllowedOrigin,
  isValidWebhookSignature,
  parseWebhookPayload,
  tokensMatch,
} = require("./src/security");
const {
  createCredentials,
  sanitizeUsername,
  verifyCredentials,
} = require("./src/auth");
const { createSnapshotStore } = require("./src/persistence");
const { createSessionStore } = require("./src/sessions");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024,
  transports: ["websocket", "polling"],
  allowRequest(request, callback) {
    callback(
      null,
      isAllowedOrigin(
        request.headers.origin,
        request.headers.host,
        config.ALLOWED_ORIGIN,
      ),
    );
  },
});

const sessionStore = createSessionStore({
  adminTokenPattern: config.ADMIN_TOKEN_PATTERN,
  defaultTimerMs: config.DEFAULT_TIMER_MS,
  io,
  maxTimerMs: config.MAX_TIMER_MS,
  maxTimerNameLength: config.MAX_TIMER_NAME_LENGTH,
  maxTimersPerSession: config.MAX_TIMERS_PER_SESSION,
  minAccrualAddMs: config.MIN_ACCRUAL_ADD_MS,
  minAccrualEveryMs: config.MIN_ACCRUAL_EVERY_MS,
  sessionIdPattern: config.SESSION_ID_PATTERN,
  sessionTtlMs: config.SESSION_TTL_MS,
  timerIdPattern: config.TIMER_ID_PATTERN,
});

const snapshotStore = createSnapshotStore({
  filePath: config.STATE_FILE,
  intervalMs: config.STATE_SAVE_MS,
  logEvent,
});

const restauradas = sessionStore.importSessions(snapshotStore.load());
if (restauradas) {
  logEvent("sessions_restored", { sessions: restauradas });
}

snapshotStore.start(sessionStore.exportSessions);

// Grava uma ultima vez ao desligar, para nao perder os segundos entre o
// ultimo snapshot periodico e o encerramento.
for (const sinal of ["SIGINT", "SIGTERM"]) {
  process.once(sinal, () => {
    snapshotStore.stop();
    snapshotStore.save(sessionStore.exportSessions());
    logEvent("server_stopping", { signal: sinal });
    process.exit(0);
  });
}

const cspDirectives = buildCspDirectives(
  process.env.NODE_ENV,
  config.ALLOWED_ORIGIN,
);
const globalLimiter = createLimiter(15 * 60 * 1000, 250);
const createSessionLimiter = createLimiter(10 * 60 * 1000, 30);
const activeSessionsLimiter = createLimiter(60 * 1000, 120);
const webhookLimiter = createLimiter(15 * 60 * 1000, 20);
// Tentativas de login sao caras de propósito (scrypt) e limitadas por IP,
// para forca bruta nao valer a pena mesmo com senha curta.
const loginLimiter = createLimiter(15 * 60 * 1000, 15);

app.disable("x-powered-by");

if (config.TRUST_PROXY) {
  app.set("trust proxy", 1);
}

app.use((request, response, next) => {
  const startedAt = process.hrtime.bigint();
  response.on("finish", () => {
    logAccess(request, response, startedAt);
  });
  next();
});

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: {
      directives: cspDirectives,
    },
    hsts: process.env.NODE_ENV === "production",
    referrerPolicy: { policy: "no-referrer" },
  }),
);

app.use((request, response, next) => {
  response.setHeader("Permissions-Policy", "fullscreen=(self)");
  next();
});

app.use(globalLimiter);

app.post(
  "/webhook",
  webhookLimiter,
  express.raw({ type: "application/json", limit: "32kb" }),
  async (request, response) => {
    if (!config.ENABLE_WEBHOOK) {
      return response.status(404).send("Not Found");
    }

    const signature = request.headers["x-hub-signature-256"];
    if (
      !isValidWebhookSignature(signature, request.body, config.WEBHOOK_SECRET)
    ) {
      return response.status(401).send("Unauthorized");
    }

    const eventName = request.headers["x-github-event"];
    if (eventName && eventName !== "push") {
      return response.status(202).send("Ignored");
    }

    const payload = parseWebhookPayload(request.body);
    if (!payload) {
      return response.status(400).send("Invalid payload");
    }

    const pushedBranch = getBranchFromRef(payload.ref);
    if (!pushedBranch || pushedBranch !== config.WEBHOOK_DEPLOY_BRANCH) {
      logEvent("webhook_ignored", {
        branch: pushedBranch || "unknown",
        expectedBranch: config.WEBHOOK_DEPLOY_BRANCH,
      });
      return response.status(202).send("Ignored");
    }

    const repository = payload.repository?.full_name || "unknown";
    logEvent("webhook_accepted", { branch: pushedBranch, repository });

    const deployStarted = await triggerDeploy({
      branch: pushedBranch,
      deployerUrl: config.DEPLOYER_URL,
      logEvent,
      repository,
      timeoutMs: config.DEPLOYER_TIMEOUT_MS,
    });

    if (!deployStarted) {
      return response.status(502).send("Deploy trigger failed");
    }

    return response.status(202).send("Accepted");
  },
);

app.use(express.json({ limit: "16kb" }));

app.use(
  "/assets",
  express.static(path.join(config.PUBLIC_DIR, "assets"), {
    fallthrough: false,
    etag: true,
    immutable: false,
    maxAge: 0,
  }),
);

app.get(["/", "/index.html"], (request, response) => {
  sendHtmlPage(request, response, "index.html", "/");
});

app.get("/admin.html", (request, response) => {
  sendHtmlPage(request, response, "admin.html", "/admin.html");
});

app.get("/viewer.html", (request, response) => {
  sendHtmlPage(request, response, "viewer.html", "/viewer.html");
});

app.get("/overview.html", (request, response) => {
  sendHtmlPage(request, response, "overview.html", "/overview");
});

app.get("/admin/:id", (request, response) => {
  if (!sessionStore.isValidSessionId(request.params.id)) {
    return response.status(404).send("Not Found");
  }
  return sendHtmlPage(request, response, "admin.html", `/admin/${request.params.id}`);
});

app.get("/view/:id", (request, response) => {
  if (!sessionStore.isValidSessionId(request.params.id)) {
    return response.status(404).send("Not Found");
  }
  return sendHtmlPage(request, response, "viewer.html", `/view/${request.params.id}`);
});

app.get("/overview", (request, response) => {
  sendHtmlPage(request, response, "overview.html", "/overview");
});

app.use(
  express.static(config.PUBLIC_DIR, {
    fallthrough: true,
    index: false,
    maxAge: 0,
  }),
);

app.post(
  "/api/session/new",
  createSessionLimiter,
  async (request, response) => {
    const session = sessionStore.createSession();

    // Usuario e senha sao opcionais: sem eles a sessao segue funcionando
    // apenas pelo link com o token, como antes.
    const { username, password } = request.body || {};
    let credentials = null;

    if (username || password) {
      credentials = await createCredentials(username, password);
      if (!credentials) {
        sessionStore.deleteSession(session.id);
        return response.status(400).json({ error: "invalid_credentials" });
      }
      sessionStore.setSessionAuth(session, credentials);
    }

    logEvent("session_created", {
      sessionId: session.id,
      totalTime: formatTimerMs(sessionStore.getPrimaryTimer(session)?.totalTime),
      withLogin: Boolean(credentials),
      ip: getRequestIp(request),
      userAgent: request.get("user-agent") || "unknown",
    });

    return response.status(201).json({
      id: session.id,
      adminToken: session.adminToken,
    });
  },
);

/**
 * Recupera o token de admin com usuario e senha - o caminho para quem perdeu
 * o link. A resposta nao distingue usuario errado de senha errada, e sessao
 * sem login configurado responde igual, para nao virar um mapa de quais
 * sessoes tem credencial.
 */
app.post("/api/session/:id/login", loginLimiter, async (request, response) => {
  const sessionId = request.params.id;
  const { username, password } = request.body || {};
  const negar = () =>
    response.status(401).json({ error: "invalid_credentials" });

  if (!sessionStore.isValidSessionId(sessionId)) return negar();

  const session = sessionStore.getSession(sessionId);
  if (!session) return negar();

  const credentials = sessionStore.getSessionAuth(session);
  const ok = await verifyCredentials(credentials, username, password);

  logEvent(ok ? "login_ok" : "login_denied", {
    sessionId,
    username: sanitizeUsername(username) || "unknown",
    ip: getRequestIp(request),
  });

  if (!ok) return negar();

  sessionStore.touchSession(session);
  return response.json({ adminToken: session.adminToken });
});

app.get("/api/sessions/active", activeSessionsLimiter, (_request, response) => {
  sessionStore.cleanupExpiredSessions();
  response.json({ sessions: sessionStore.listActiveSessions() });
});

app.delete("/api/sessions/:id", activeSessionsLimiter, (request, response) => {
  const sessionId = request.params.id;
  if (!sessionStore.isValidSessionId(sessionId)) {
    return response.status(404).json({ error: "session_not_found" });
  }

  const closed = sessionStore.closeSession(sessionId);
  if (!closed) {
    return response.status(404).json({ error: "session_not_found" });
  }

  logEvent("session_closed", {
    sessionId,
    ip: getRequestIp(request),
    userAgent: request.get("user-agent") || "unknown",
  });

  return response.json({ success: true });
});

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

io.on("connection", (socket) => {
  socket.currentSession = null;
  socket.isAdmin = false;

  socket.on(
    "session:join",
    (sessionId, role, tokenOrCallback, maybeCallback) => {
      const callback =
        typeof tokenOrCallback === "function" ? tokenOrCallback : maybeCallback;
      const adminToken =
        typeof tokenOrCallback === "string" ? tokenOrCallback : null;

      if (
        !sessionStore.isValidSessionId(sessionId) ||
        !sessionStore.isValidRole(role)
      ) {
        logEvent(
          "session_join_denied",
          buildSocketLogDetails(socket, {
            sessionId: normalizeSessionId(sessionId),
            role: normalizeRole(role),
            reason: "invalid_request",
          }),
        );
        if (callback) callback({ success: false, reason: "invalid_request" });
        return;
      }

      const currentSession = sessionStore.getSession(sessionId);
      if (!currentSession) {
        sessionStore.deleteSession(sessionId);
        logEvent(
          "session_join_denied",
          buildSocketLogDetails(socket, {
            sessionId,
            role,
            reason: "not_found",
          }),
        );
        if (callback) callback({ success: false, reason: "not_found" });
        return;
      }

      const wantsAdmin = role === "admin";
      if (
        wantsAdmin &&
        !tokensMatch(
          currentSession.adminToken,
          adminToken,
          sessionStore.isValidAdminToken,
        )
      ) {
        logEvent(
          "session_join_denied",
          buildSocketLogDetails(socket, {
            sessionId,
            role,
            reason: "unauthorized",
          }),
        );
        if (callback) callback({ success: false, reason: "unauthorized" });
        return;
      }

      if (socket.currentSession && socket.currentSession !== sessionId) {
        socket.leave(socket.currentSession);
      }

      sessionStore.touchSession(currentSession);
      socket.join(sessionId);
      socket.currentSession = sessionId;
      socket.isAdmin = wantsAdmin;

      sessionStore.emitSessionState(socket, currentSession);
      logEvent(
        "session_joined",
        buildSocketLogDetails(socket, {
          sessionId,
          role,
          timers: currentSession.timers.length,
          remaining: formatTimerMs(getPrimaryRemaining(currentSession)),
          userAgent: getSocketUserAgent(socket),
        }),
      );

      if (callback) callback({ success: true });
    },
  );

  socket.on("session:setAuth", async (payload, callback) => {
    const session = sessionStore.getAdminSession(socket);
    const responder = (resultado) => {
      if (typeof callback === "function") callback(resultado);
    };

    if (!session) return responder({ success: false, reason: "unauthorized" });

    const { username, password } = payload || {};

    if (!username && !password) {
      sessionStore.setSessionAuth(session, null);
      logEvent(
        "auth_cleared",
        buildSocketLogDetails(socket, { sessionId: session.id }),
      );
      return responder({ success: true, hasAuth: false });
    }

    const credentials = await createCredentials(username, password);
    if (!credentials) {
      return responder({ success: false, reason: "invalid_credentials" });
    }

    sessionStore.setSessionAuth(session, credentials);
    logEvent(
      "auth_set",
      buildSocketLogDetails(socket, {
        sessionId: session.id,
        username: credentials.username,
      }),
    );

    return responder({ success: true, hasAuth: true });
  });

  socket.on("timer:add", (payload, callback) => {
    const session = sessionStore.getAdminSession(socket);
    if (!session) {
      if (typeof callback === "function") {
        callback({ success: false, reason: "unauthorized" });
      }
      return;
    }

    const timer = sessionStore.addTimer(session, readTimerPayload(payload));
    if (!timer) {
      if (typeof callback === "function") {
        callback({ success: false, reason: "limit_reached" });
      }
      return;
    }

    logEvent(
      "timer_added",
      buildSocketLogDetails(socket, {
        sessionId: session.id,
        timerId: timer.id,
        direction: timer.direction,
        totalTime: formatTimerMs(timer.totalTime),
      }),
    );

    sessionStore.broadcastSession(session.id);
    if (typeof callback === "function") {
      callback({ success: true, timerId: timer.id });
    }
  });

  socket.on("timer:remove", (timerId) => {
    withAdminSession(socket, (session) =>
      sessionStore.removeTimer(session, timerId),
    );
  });

  socket.on("timer:update", (timerId, payload) => {
    withAdminSession(socket, (session) =>
      sessionStore.updateTimer(session, timerId, readTimerPayload(payload)),
    );
  });

  socket.on("timer:setPrimary", (timerId) => {
    withAdminSession(socket, (session) =>
      sessionStore.setPrimaryTimer(session, timerId),
    );
  });

  socket.on("timer:move", (timerId, offset) => {
    withAdminSession(socket, (session) =>
      sessionStore.moveTimer(session, timerId, Number(offset) < 0 ? -1 : 1),
    );
  });

  socket.on("timers:bulk", (action) => {
    withAdminSession(socket, (session) =>
      sessionStore.bulkTimerAction(session, action),
    );
  });

  socket.on("timer:start", (timerId) => {
    withAdminSession(socket, (session) =>
      sessionStore.startSessionTimer(session, resolveTimerId(session, timerId)),
    );
  });

  socket.on("timer:pause", (timerId) => {
    withAdminSession(socket, (session) =>
      sessionStore.pauseSessionTimer(session, resolveTimerId(session, timerId)),
    );
  });

  socket.on("timer:reset", (timerId) => {
    withAdminSession(socket, (session) =>
      sessionStore.resetSessionTimer(session, resolveTimerId(session, timerId)),
    );
  });

  // Evento do formato antigo (um cronometro por sessao): aplica o tempo ao
  // cronometro em destaque para nao quebrar abas abertas antes do deploy.
  socket.on("timer:setTime", (ms) => {
    withAdminSession(socket, (session) =>
      sessionStore.updateTimer(session, resolveTimerId(session), {
        totalTime: ms,
      }),
    );
  });
});

setInterval(
  sessionStore.cleanupExpiredSessions,
  config.SESSION_CLEANUP_MS,
).unref();

server.listen(config.PORT, () => {
  logEvent("server_started", {
    port: config.PORT,
    url: `http://localhost:${config.PORT}`,
    file: getLogFile(),
  });
});

function sendHtmlPage(request, response, fileName, pagePath) {
  const filePath = path.join(config.PUBLIC_DIR, fileName);

  fs.readFile(filePath, "utf8", (error, html) => {
    if (error) {
      logEvent("html_read_failed", {
        fileName,
        message: error.message,
      });
      return response.status(500).send("Internal Server Error");
    }

    const origin = getRequestOrigin(request);
    const canonicalUrl = new URL(pagePath, `${origin}/`).toString();
    const ogImageUrl = new URL("/assets/img/icon-512.png", `${origin}/`).toString();

    response.setHeader("Cache-Control", "no-cache");
    response.type("html").send(
      html
        .replaceAll("__CANONICAL_URL__", escapeHtmlAttribute(canonicalUrl))
        .replaceAll("__OG_IMAGE_URL__", escapeHtmlAttribute(ogImageUrl)),
    );
  });
}

function getRequestOrigin(request) {
  if (config.ALLOWED_ORIGIN) return config.ALLOWED_ORIGIN;

  const forwardedProto = request.get("x-forwarded-proto");
  const protocol = forwardedProto
    ? forwardedProto.split(",")[0].trim()
    : request.protocol;
  const host = request.get("host") || `localhost:${config.PORT}`;

  return `${protocol}://${host}`;
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildCspDirectives(nodeEnv, allowedOrigin) {
  const directives = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "https://fonts.googleapis.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
    connectSrc: buildConnectSrc(allowedOrigin),
    imgSrc: ["'self'", "data:"],
    frameSrc: ["'self'", "https://open.spotify.com"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
  };

  if (nodeEnv === "production") {
    directives.upgradeInsecureRequests = [];
  }

  return directives;
}

// O Socket.IO conecta sempre na mesma origem da pagina, entao "'self'" ja
// cobre o WebSocket. Quando APP_ORIGIN esta definido, adicionamos o seu
// equivalente ws/wss explicitamente, em vez de liberar os curingas "ws:"
// e "wss:" (que permitiriam conexao a qualquer host).
function buildConnectSrc(allowedOrigin) {
  const connectSrc = ["'self'"];

  if (allowedOrigin) {
    connectSrc.push(allowedOrigin.replace(/^http/, "ws"));
  }

  return connectSrc;
}

function createLimiter(windowMs, max) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
}

function buildSocketLogDetails(socket, extra = {}) {
  return {
    socketId: socket.id,
    ip: getRequestIp(socket.request),
    ...extra,
  };
}

function getSocketUserAgent(socket) {
  return socket.request?.headers?.["user-agent"] || "unknown";
}

/**
 * Executa uma mutacao que exige papel de admin e retransmite o estado quando
 * algo realmente mudou, evitando broadcast a cada evento ignorado.
 */
function withAdminSession(socket, mutate) {
  const session = sessionStore.getAdminSession(socket);
  if (!session) return;

  if (mutate(session)) {
    sessionStore.broadcastSession(session.id);
  }
}

/**
 * Um id ausente cai no cronometro em destaque, que e o comportamento esperado
 * tanto do cliente antigo (que nao enviava id) quanto dos atalhos de teclado.
 */
function resolveTimerId(session, timerId) {
  if (timerId === undefined || timerId === null) {
    return sessionStore.getPrimaryTimer(session)?.id ?? null;
  }

  return timerId;
}

function readTimerPayload(payload) {
  if (!payload || typeof payload !== "object") return {};

  const { accrual, direction, name, offsetMs, totalTime } = payload;
  return { accrual, direction, name, offsetMs, totalTime };
}

function getPrimaryRemaining(session) {
  const primary = sessionStore.getPrimaryTimer(session);
  return primary ? sessionStore.getRemaining(primary) : 0;
}

function normalizeSessionId(value) {
  return typeof value === "string" && value ? value : "unknown";
}

function normalizeRole(value) {
  return value === "admin" || value === "viewer" ? value : "unknown";
}

