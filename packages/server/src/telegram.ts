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

/**
 * Send a single message without starting the polling bot. Used by the "send
 * test message" button so the user can confirm token + chat id before enabling.
 */
export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const json = (await res.json()) as { ok: boolean; description?: string };
    return json.ok ? { ok: true } : { ok: false, error: json.description ?? "send failed" };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
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
  onCommand: (cmd: string, args: string[]) => Promise<string> | string;
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
  event: "rate_limit_wait" | "fallback" | "exhausted";
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

interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number }; message_id: number };
    from?: { id: number };
  };
}

export class TelegramBot implements ServerNotifier {
  private offset = 0;
  private running = false;
  private abort?: AbortController;

  constructor(
    private readonly token: string,
    /** Numeric chat id allowed to drive the bot. */
    private readonly chatId: string,
    private readonly handlers: TelegramHandlers,
    private readonly log: (msg: string) => void = () => {},
  ) {}

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
    try {
      const res = await fetch(`${API}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      const json = (await res.json()) as {
        ok: boolean;
        result?: T;
        description?: string;
      };
      if (json.ok) return { ok: true, result: json.result ?? null };
      return { ok: false, result: null, error: json.description ?? "request failed" };
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.log(`[telegram] ${method} failed: ${(err as Error).message}`);
      }
      return { ok: false, result: null, error: (err as Error).message };
    }
  }

  /** Begin the long-poll loop. Safe to call once; idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    void this.loop();
    this.log("[telegram] bot started");
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
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
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      for (const u of updates) {
        this.offset = u.update_id + 1;
        try {
          await this.handleUpdate(u);
        } catch (err) {
          this.log(`[telegram] update error: ${(err as Error).message}`);
        }
      }
    }
  }

  private allowed(id: number | undefined): boolean {
    return id !== undefined && String(id) === this.chatId;
  }

  private async handleUpdate(u: TgUpdate): Promise<void> {
    if (u.callback_query) {
      const cq = u.callback_query;
      const data = cq.data ?? "";
      // callback_data: "appr:<notificationId>:<choice>"
      if (this.allowed(cq.message?.chat.id) && data.startsWith("appr:")) {
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
        this.allowed(cq.message?.chat.id) &&
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
    if (!this.allowed(msg.chat.id)) return;

    const text = msg.text.trim();
    if (!text.startsWith("/")) return;
    const [raw, ...args] = text.slice(1).split(/\s+/);
    const cmd = (raw ?? "").toLowerCase();
    const reply = await this.handlers.onCommand(cmd, args);
    if (reply) await this.send(reply);
  }

  /** Send a plain message to the configured chat (or an explicit chat). */
  async send(text: string, chatId?: string | number): Promise<void> {
    const to = chatId ?? this.chatId;
    if (!to) return;
    await this.tg("sendMessage", { chat_id: to, text });
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
    const first = await this.tg("sendMessage", {
      chat_id: this.chatId,
      text,
      parse_mode: "Markdown",
      reply_markup: replyMarkup,
    });
    if (first.ok) return;

    this.log(
      `[telegram] approval ${notificationId} Markdown send failed (${first.error}) — resending as plain text`,
    );
    const retry = await this.tg("sendMessage", {
      chat_id: this.chatId,
      text,
      reply_markup: replyMarkup,
    });
    if (!retry.ok) {
      this.log(
        `[telegram] approval ${notificationId} plain-text resend also failed: ${retry.error}`,
      );
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
