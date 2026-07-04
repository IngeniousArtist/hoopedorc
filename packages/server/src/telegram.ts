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
  /** A human tapped Approve/Reject on an approval message. */
  onApproval: (notificationId: string, choice: string) => Promise<void> | void;
  /** A slash command arrived; return the reply text. */
  onCommand: (cmd: string, args: string[]) => Promise<string> | string;
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

/** Outbound surface the engine pushes to. No-ops when Telegram is disabled. */
export interface ServerNotifier {
  approvalRequested(n: Notification): void;
  taskStatus(digest: TaskDigest): void;
  info(text: string): void;
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

  private async tg<T = unknown>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T | null> {
    try {
      const res = await fetch(`${API}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      const json = (await res.json()) as { ok: boolean; result?: T };
      return json.ok ? (json.result ?? null) : null;
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.log(`[telegram] ${method} failed: ${(err as Error).message}`);
      }
      return null;
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
      const updates = await this.tg<TgUpdate[]>(
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
      // callback_data: "appr:<notificationId>:<choice>"
      const data = cq.data ?? "";
      if (this.allowed(cq.message?.chat.id) && data.startsWith("appr:")) {
        const [, notificationId, choice] = data.split(":");
        if (notificationId && choice) {
          await this.handlers.onApproval(notificationId, choice);
          await this.tg("answerCallbackQuery", {
            callback_query_id: cq.id,
            text: `Recorded: ${choice}`,
          });
          if (cq.message) {
            await this.tg("editMessageText", {
              chat_id: cq.message.chat.id,
              message_id: cq.message.message_id,
              text: `✅ ${choice.toUpperCase()} recorded.`,
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

  approvalRequested(n: Notification): void {
    if (!this.chatId) return;
    const options = n.options ?? ["approve", "reject"];
    void this.tg("sendMessage", {
      chat_id: this.chatId,
      text: `🔔 *Approval needed*\n${n.title}\n\n${n.message}`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          options.map((opt) => ({
            text: opt,
            callback_data: `appr:${n.id}:${opt}`,
          })),
        ],
      },
    });
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
}
