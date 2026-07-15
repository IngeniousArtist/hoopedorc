import type { Notification } from "@orc/types";

// Dependency-free Telegram bot over the raw Bot API with long-polling
// (getUpdates). No public webhook, so it works behind Tailscale on EC2.
//
// Security: the token is either read from an env var named by
// settings.telegram.botTokenRef, or stored raw in settings.telegram.botToken
// (index.ts prefers the raw value when set). GET/PUT /api/settings redact
// botToken to a sentinel so it never round-trips over the wire — see
// redactSettings in index.ts. All commands + approvals are restricted to the
// single configured chat id — approvals merge real code.

const API = "https://api.telegram.org";
export const TELEGRAM_MESSAGE_LIMIT = 4_000;
export const TELEGRAM_COMMANDS = [
  { command: "status", description: "Project status and controls" },
  { command: "projects", description: "List projects and controls" },
  { command: "start", description: "Start a project by name/id prefix" },
  { command: "pause", description: "Pause a project by name/id prefix" },
  { command: "pending", description: "Re-send pending approvals" },
  { command: "stopall", description: "Stop every active project" },
  { command: "cost", description: "Monthly spend" },
  { command: "health", description: "Model and delivery health" },
  { command: "help", description: "Show all commands" },
] as const;

export interface TelegramDeliveryHealth {
  enabled: boolean;
  running: boolean;
  state: "disabled" | "starting" | "healthy" | "degraded" | "stopped";
  lastSuccessAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

export interface TelegramCommandReply {
  text: string;
  inlineKeyboard?: Array<Array<{ text: string; callbackData: string }>>;
}

export function splitTelegramMessage(
  text: string,
  limit = TELEGRAM_MESSAGE_LIMIT,
): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit / 2)) cut = remaining.lastIndexOf(" ", limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Send a single message without starting the polling bot. Used by the "send
 * test message" button so the user can confirm token + chat id before enabling.
 */
export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  options: TelegramBotOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  const bot = new TelegramBot(
    token,
    chatId,
    { onApproval: () => false, onCommand: () => "" },
    () => {},
    options,
  );
  const ok = await bot.send(text);
  return ok ? { ok: true } : { ok: false, error: bot.health.lastError ?? "send failed" };
}

/** What the server wires the bot up to (engine + db live in index.ts). */
export interface TelegramHandlers {
  /**
   * A human tapped Approve/Reject on an approval message. Returns false when
   * nothing was actually waiting on this approval anymore (B10 — e.g. the
   * server restarted since the message was sent) so the bot can tell the
   * human it expired instead of claiming their tap took effect.
   */
  onApproval: (
    notificationId: string,
    choice: string,
  ) => Promise<boolean> | boolean;
  /** A slash command arrived; return the reply text. */
  onCommand: (
    cmd: string,
    args: string[],
  ) => Promise<string | TelegramCommandReply> | string | TelegramCommandReply;
  /** Inline Start/Pause/Status control from a project row. */
  onProjectAction?: (
    action: "start" | "pause" | "status",
    projectId: string,
  ) => Promise<string | TelegramCommandReply> | string | TelegramCommandReply;
  /** Permanent approval delivery failure after bounded retry/fallback. */
  onApprovalDeliveryFailure?: (notificationId: string, error: string) => void;
  /**
   * F40: the human tapped Yes/No on a /stopall confirmation
   * (confirmStopAll below). Returns the text to edit into that message —
   * optional so a bot wired up without it just answers the tap silently.
   */
  onStopAllConfirm?: (confirmed: boolean) => Promise<string> | string;
}

/** Everything worth telling a human about a task that just finished. */
export interface TaskDigest {
  title: string;
  status: string;
  difficulty?: string;
  assignedModel?: string;
  attempts?: number;
  maxAttempts?: number;
  /** One-line summary — the task's own description, or a failure reason. */
  summary?: string;
  costUsd?: number;
  prNumber?: number;
  prUrl?: string;
}

/**
 * Extra context for an approval message so the user can decide from the
 * phone alone, without opening the app — the PR to look at and why the
 * validator flagged it.
 */
export interface ApprovalContext {
  prUrl?: string;
  /** Top validator reasons from the most recent review, if any. */
  reasons?: string[];
}

/**
 * F32: what EngineRunner forwards from the engine's `onModelTrouble` event —
 * the project name added here (the engine's own payload has no project
 * concept), everything else passed straight through.
 */
export interface ModelTroubleNotification {
  projectName: string;
  taskTitle: string;
  model: string;
  event: "rate_limit_wait" | "fallback" | "exhausted" | "quota_wait";
  detail: string;
}

/** Outbound surface the engine pushes to. No-ops when Telegram is disabled. */
export interface ServerNotifier {
  approvalRequested(n: Notification, context?: ApprovalContext): void;
  taskStatus(digest: TaskDigest): void;
  info(text: string): void;
  /** F32: gated by `Settings.telegram.modelAlerts` (default true) at the call site. */
  modelTrouble(n: ModelTroubleNotification): void;
}

export interface TgUpdate {
  update_id: number;
  message?: {
    chat: { id: number; type?: string };
    from?: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number; type?: string }; message_id: number };
    from?: { id: number };
  };
}

export interface TelegramBotOptions {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  pollRequestTimeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("aborted", "AbortError"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class TelegramBot implements ServerNotifier {
  private offset = 0;
  private running = false;
  private abort?: AbortController;
  private healthValue: TelegramDeliveryHealth = {
    enabled: true,
    running: false,
    state: "stopped",
  };
  private lastErrorMethod?: string;

  constructor(
    private readonly token: string,
    /** Numeric chat id allowed to drive the bot. */
    private readonly chatId: string,
    private readonly handlers: TelegramHandlers,
    private readonly log: (msg: string) => void = () => {},
    private readonly options: TelegramBotOptions = {},
  ) {}

  get health(): TelegramDeliveryHealth {
    return { ...this.healthValue };
  }

  private deliverySucceeded(method: string): void {
    const preserveOutboundFailure =
      method === "getUpdates" &&
      this.lastErrorMethod !== undefined &&
      this.lastErrorMethod !== "getUpdates";
    this.healthValue = {
      ...this.healthValue,
      running: this.running,
      state: preserveOutboundFailure
        ? "degraded"
        : this.running
          ? "healthy"
          : "stopped",
      lastSuccessAt: new Date().toISOString(),
      lastError: preserveOutboundFailure ? this.healthValue.lastError : undefined,
      lastErrorAt: preserveOutboundFailure ? this.healthValue.lastErrorAt : undefined,
    };
    if (!preserveOutboundFailure) this.lastErrorMethod = undefined;
  }

  private deliveryFailed(error: string, method?: string): void {
    const safeError = error.split(this.token).join("[redacted]");
    this.healthValue = {
      ...this.healthValue,
      running: this.running,
      state: "degraded",
      lastError: safeError.slice(0, 300),
      lastErrorAt: new Date().toISOString(),
    };
    this.lastErrorMethod = method;
  }

  /**
   * Returns `error` (Telegram's own description, e.g. "Bad Request: can't
   * parse entities") instead of swallowing it, so callers that need to know
   * *why* a send failed — not just that it did — can react (see
   * approvalRequested's Markdown-then-plain-text retry below).
   */
  private async tg<T = unknown>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; result: T | null; error?: string }> {
    const effectiveSignal = signal ?? this.abort?.signal;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const sleep = this.options.sleep ?? abortableSleep;
    const maxRetries = this.options.maxRetries ?? 2;
    let lastError = "request failed";
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutMs = method === "getUpdates"
        ? (this.options.pollRequestTimeoutMs ?? 35_000)
        : (this.options.requestTimeoutMs ?? 10_000);
      const timer = setTimeout(
        () => controller.abort(new DOMException("request deadline exceeded", "TimeoutError")),
        timeoutMs,
      );
      const onAbort = () => controller.abort(effectiveSignal?.reason);
      if (effectiveSignal?.aborted) onAbort();
      else effectiveSignal?.addEventListener("abort", onAbort, { once: true });
      let retryAfterMs = 0;
      let transient = false;
      try {
        const res = await fetchImpl(`${API}/bot${this.token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const json = (await res.json()) as {
          ok: boolean;
          result?: T;
          description?: string;
          parameters?: { retry_after?: number };
        };
        if (json.ok) {
          this.deliverySucceeded(method);
          return { ok: true, result: json.result ?? null };
        }
        lastError = json.description ?? `HTTP ${res.status}`;
        retryAfterMs = Math.min(
          Math.max(0, json.parameters?.retry_after ?? 0) * 1_000,
          30_000,
        );
        transient = res.status === 429 || res.status >= 500;
      } catch (err) {
        if (effectiveSignal?.aborted) {
          return { ok: false, result: null, error: "aborted" };
        }
        lastError = controller.signal.aborted
          ? `request timed out after ${timeoutMs}ms`
          : (err as Error).message;
        transient = true;
      } finally {
        clearTimeout(timer);
        effectiveSignal?.removeEventListener("abort", onAbort);
      }
      if (!transient || attempt === maxRetries) break;
      const delayMs = retryAfterMs || Math.min(500 * 2 ** attempt, 4_000);
      try {
        await sleep(delayMs, effectiveSignal);
      } catch {
        return { ok: false, result: null, error: "aborted" };
      }
    }
    const safeError = lastError.split(this.token).join("[redacted]");
    this.deliveryFailed(safeError, method);
    this.log(`[telegram] ${method} failed after retry: ${safeError}`);
    return { ok: false, result: null, error: safeError };
  }

  /** Begin the long-poll loop. Safe to call once; idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.healthValue = { ...this.healthValue, running: true, state: "starting" };
    void this.bootstrap();
    this.log("[telegram] bot started");
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
    this.healthValue = { ...this.healthValue, running: false, state: "stopped" };
  }

  private async bootstrap(): Promise<void> {
    await this.tg("setMyCommands", { commands: TELEGRAM_COMMANDS }, this.abort?.signal);
    if (this.running) await this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const { result: updates } = await this.tg<TgUpdate[]>(
        "getUpdates",
        { offset: this.offset, timeout: 30 },
        this.abort?.signal,
      );
      if (!updates) {
        // network hiccup — back off briefly so we don't hot-loop
        try {
          await (this.options.sleep ?? abortableSleep)(2_000, this.abort?.signal);
        } catch {
          break;
        }
        continue;
      }
      for (const u of updates) {
        this.offset = u.update_id + 1;
        try {
          await this.processUpdate(u);
        } catch (err) {
          this.log(`[telegram] update error: ${(err as Error).message}`);
        }
      }
    }
  }

  private allowed(
    chatId: number | undefined,
    fromId: number | undefined,
    chatType?: string,
  ): boolean {
    return (
      chatType === "private" &&
      chatId !== undefined &&
      fromId !== undefined &&
      String(chatId) === this.chatId &&
      String(fromId) === this.chatId
    );
  }

  /** Public for deterministic transport/identity integration tests. */
  async processUpdate(u: TgUpdate): Promise<void> {
    if (u.callback_query) {
      const cq = u.callback_query;
      const data = cq.data ?? "";
      const authorized = this.allowed(
        cq.message?.chat.id,
        cq.from?.id,
        cq.message?.chat.type,
      );
      if (!authorized) {
        await this.tg("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "Unauthorized",
          show_alert: true,
        });
        return;
      }
      // callback_data: "appr:<notificationId>:<choice>"
      if (data.startsWith("appr:")) {
        const [, notificationId, choice] = data.split(":");
        if (notificationId && choice) {
          const resolved = await this.handlers.onApproval(notificationId, choice);
          await this.tg("answerCallbackQuery", {
            callback_query_id: cq.id,
            text: resolved
              ? `Recorded: ${choice}`
              : "Expired — no longer pending",
          });
          if (cq.message) {
            await this.tg("editMessageText", {
              chat_id: cq.message.chat.id,
              message_id: cq.message.message_id,
              text: resolved
                ? `✅ ${choice.toUpperCase()} recorded.`
                : `⚠️ Expired — the task will re-request approval if it's still needed.`,
            });
          }
        }
        // F40: callback_data "stopall:yes" | "stopall:no" from confirmStopAll below.
      } else if (
        data.startsWith("stopall:") &&
        this.handlers.onStopAllConfirm
      ) {
        const confirmed = data === "stopall:yes";
        const resultText = await this.handlers.onStopAllConfirm(confirmed);
        await this.tg("answerCallbackQuery", { callback_query_id: cq.id });
        if (cq.message) {
          await this.tg("editMessageText", {
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: resultText,
          });
        }
      } else if (data.startsWith("proj:") && this.handlers.onProjectAction) {
        const [, action, projectId] = data.split(":");
        if (
          (action === "start" || action === "pause" || action === "status") &&
          projectId
        ) {
          try {
            const reply = await this.handlers.onProjectAction(action, projectId);
            await this.tg("answerCallbackQuery", { callback_query_id: cq.id });
            await this.sendReply(reply);
          } catch (err) {
            await this.tg("answerCallbackQuery", {
              callback_query_id: cq.id,
              text: `Failed: ${(err as Error).message}`.slice(0, 180),
              show_alert: true,
            });
          }
        }
      } else {
        await this.tg("answerCallbackQuery", { callback_query_id: cq.id });
      }
      return;
    }

    const msg = u.message;
    if (!msg?.text) return;

    // Discovery helper: if no chat id is configured yet, tell the user theirs.
    if (!this.chatId) {
      await this.send(
        `Your chat id is ${msg.chat.id}. Add it to Settings → Telegram (chatId) to enable approvals + commands.`,
        msg.chat.id,
      );
      return;
    }
    if (!this.allowed(msg.chat.id, msg.from?.id, msg.chat.type)) return;

    const text = msg.text.trim();
    if (!text.startsWith("/")) return;
    const [raw, ...args] = text.slice(1).split(/\s+/);
    const cmd = (raw ?? "").toLowerCase();
    try {
      const reply = await this.handlers.onCommand(cmd, args);
      await this.sendReply(reply);
    } catch (err) {
      await this.send(`Command failed: ${(err as Error).message}`);
    }
  }

  private async sendReply(reply: string | TelegramCommandReply): Promise<void> {
    if (typeof reply === "string") {
      if (reply) await this.send(reply);
      return;
    }
    if (!reply.text) return;
    const replyMarkup = reply.inlineKeyboard
      ? {
          inline_keyboard: reply.inlineKeyboard.map((row) =>
            row.map((button) => ({
              text: button.text,
              callback_data: button.callbackData,
            })),
          ),
        }
      : undefined;
    await this.send(reply.text, undefined, replyMarkup);
  }

  /** Send a plain message to the configured chat (or an explicit chat). */
  async send(
    text: string,
    chatId?: string | number,
    replyMarkup?: Record<string, unknown>,
  ): Promise<boolean> {
    const to = chatId ?? this.chatId;
    if (!to) return false;
    const chunks = splitTelegramMessage(text);
    for (const [index, chunk] of chunks.entries()) {
      const result = await this.tg("sendMessage", {
        chat_id: to,
        text: chunk,
        ...(replyMarkup && index === chunks.length - 1
          ? { reply_markup: replyMarkup }
          : {}),
      });
      if (!result.ok) return false;
    }
    return true;
  }

  // ── ServerNotifier ──

  approvalRequested(n: Notification, context?: ApprovalContext): void {
    if (!this.chatId) return;
    const options = n.options ?? ["approve", "reject"];
    const replyMarkup = {
      inline_keyboard: [
        options.map((opt) => ({
          text: opt,
          callback_data: `appr:${n.id}:${opt}`,
        })),
      ],
    };
    const lines = [`🔔 *Approval needed*`, n.title, "", n.message];
    if (context?.reasons?.length) {
      lines.push(
        "",
        "Validator reasons:",
        ...context.reasons.slice(0, 3).map((r) => `- ${r}`),
      );
    }
    if (context?.prUrl) {
      lines.push("", context.prUrl);
    }
    void this.sendApproval(lines.join("\n"), replyMarkup, n.id);
  }

  /**
   * F40: /stopall's confirmation prompt — mirrors approvalRequested's inline-
   * keyboard shape but with its own "stopall:" callback prefix (handled in
   * handleUpdate above) since this isn't tied to any one notification id.
   */
  confirmStopAll(text: string): void {
    if (!this.chatId) return;
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "Yes, stop everything", callback_data: "stopall:yes" },
          { text: "No", callback_data: "stopall:no" },
        ],
      ],
    };
    void this.tg("sendMessage", {
      chat_id: this.chatId,
      text,
      reply_markup: replyMarkup,
    });
  }

  /**
   * A title/message containing an unescaped Markdown metacharacter (`_`,
   * `*`, `[`, a backtick…) makes the Bot API reject the whole message when
   * sent with parse_mode: "Markdown" — silently, from the caller's point of
   * view, since nothing awaited the old fire-and-forget send. That left an
   * unattended run stalled waiting for an approval the user never saw. Retry
   * once as plain text (no parse_mode, so metacharacters can't break
   * parsing) instead of just giving up.
   */
  private async sendApproval(
    text: string,
    replyMarkup: Record<string, unknown>,
    notificationId: string,
  ): Promise<void> {
    const chunks = splitTelegramMessage(text);
    for (const chunk of chunks.slice(0, -1)) {
      const preceding = await this.tg("sendMessage", {
        chat_id: this.chatId,
        text: chunk,
      });
      if (!preceding.ok) {
        const error = preceding.error ?? "approval delivery failed";
        this.handlers.onApprovalDeliveryFailure?.(notificationId, error);
        return;
      }
    }
    const finalText = chunks.at(-1) ?? text;
    const first = await this.tg("sendMessage", {
      chat_id: this.chatId,
      text: finalText,
      parse_mode: "Markdown",
      reply_markup: replyMarkup,
    });
    if (first.ok) return;

    this.log(
      `[telegram] approval ${notificationId} Markdown send failed (${first.error}) — resending as plain text`,
    );
    const retry = await this.tg("sendMessage", {
      chat_id: this.chatId,
      text: finalText,
      reply_markup: replyMarkup,
    });
    if (!retry.ok) {
      const error = retry.error ?? "approval delivery failed";
      this.log(
        `[telegram] approval ${notificationId} plain-text resend also failed: ${error}`,
      );
      this.handlers.onApprovalDeliveryFailure?.(notificationId, error);
    }
  }

  taskStatus(d: TaskDigest): void {
    const icon = d.status === "done" ? "✅" : d.status === "failed" ? "❌" : "•";
    const lines = [`${icon} ${d.title} → ${d.status}`];

    const meta: string[] = [];
    if (d.assignedModel) meta.push(d.difficulty ? `${d.assignedModel} (${d.difficulty})` : d.assignedModel);
    if (d.attempts != null && d.maxAttempts != null) meta.push(`${d.attempts}/${d.maxAttempts} attempts`);
    if (d.costUsd != null) meta.push(`$${d.costUsd.toFixed(4)}`);
    if (meta.length > 0) lines.push(meta.join(" · "));

    if (d.summary) lines.push(d.summary);
    if (d.prUrl) lines.push(d.prUrl);
    else if (d.prNumber) lines.push(`PR #${d.prNumber}`);

    void this.send(lines.join("\n"));
  }

  info(text: string): void {
    void this.send(text);
  }

  modelTrouble(n: ModelTroubleNotification): void {
    const icon =
      n.event === "exhausted" ? "🛑" : n.event === "fallback" ? "🔀" : "⏳";
    const lines = [
      `${icon} ${n.projectName} — ${n.taskTitle}`,
      `${n.model}: ${n.detail}`,
    ];
    void this.send(lines.join("\n"));
  }
}
