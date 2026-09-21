import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, api } from "../api/client";
import { ToastProvider } from "../hooks/useToast";
import { projectFixture, settingsFixture } from "../test/fixtures";
import { PlanView } from "./PlanView";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: vi.fn(), apiUpload: vi.fn() };
});
vi.mock("../hooks/useWS", () => ({ useWS: () => {} }));

type ApiOptions = { params?: Record<string, string>; body?: unknown } | undefined;
type ChatBody = { revisionId: string; messages: Array<{ role: string; content: string }> };
type DraftBody = { revisionId: string; prdMarkdown: string; tasks: Array<{ title: string }> };

const apiMock = vi.mocked(api);
const project = { ...projectFixture, status: "paused" as const };
const revisionId = "11111111-1111-4111-8111-111111111111";
const draft = {
  title: "Build login",
  description: "Implement login.",
  difficulty: "medium" as const,
  acceptanceCriteria: ["Login works."],
  dependsOn: [],
  scopePaths: ["apps/web/**"],
  assignedModel: "codex",
};
const history = [
  { role: "user" as const, content: "Earlier request" },
  { role: "assistant" as const, content: "Earlier reply" },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function view(id = project.id) {
  return (
    <ToastProvider>
      <PlanView projectId={id} onDone={vi.fn()} saveDebounceMs={0} />
    </ToastProvider>
  );
}

function baseApi(key: string, options: ApiOptions, projects = [project]) {
  const id = options?.params?.id;
  if (key === "getProject") {
    return { project: projects.find((p) => p.id === id) ?? project };
  }
  if (key === "getSettings") return { settings: settingsFixture() };
  if (key === "listPlanAttachments") return { attachments: [] };
  if (key === "planSessionArchives") return { sessions: [] };
  throw new Error(`Unexpected API call: ${key}`);
}

function saveStatus() {
  return screen.getByTestId("draft-save-status");
}

async function sendMessage(text: string) {
  fireEvent.change(await screen.findByLabelText("Planning message"), {
    target: { value: text },
  });
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("VW02: planning chat survives send failures", () => {
  beforeEach(() => {
    apiMock.mockReset();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("keeps the failed turn, later typing, and history; retry sends once without duplicating", async () => {
    const chatBodies: ChatBody[] = [];
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") {
        return { revisionId, messages: history, planCostUsd: 0 };
      }
      if (key === "planChat") {
        chatBodies.push(options?.body as ChatBody);
        if (chatBodies.length === 1) throw new Error("planner chat failed: injected");
        return { reply: "Got it. [PLAN_COMPLETE]", costUsd: 0 };
      }
      return baseApi(key, options);
    });
    render(view());

    await sendMessage("Add tests");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Send failed: planner chat failed: injected");
    expect(screen.getByTestId("pending-turn")).toHaveTextContent("Add tests");
    expect(screen.getByText("Earlier reply")).toBeVisible();
    expect(screen.getByLabelText("Planning message")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Planning message"), {
      target: { value: "also docs" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Retry send" }));

    expect(await screen.findByText("Got it.")).toBeVisible();
    expect(screen.getByText(/is done planning/)).toBeVisible();
    expect(screen.queryByTestId("pending-turn")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Planning message")).toHaveValue("also docs");
    expect(screen.getAllByText("Add tests")).toHaveLength(1);
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[1]?.messages).toEqual([
      ...history,
      { role: "user", content: "Add tests" },
    ]);
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("retry adopts a turn the server already accepted instead of sending it twice", async () => {
    let chatCalls = 0;
    let sessionReads = 0;
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") {
        sessionReads += 1;
        if (sessionReads === 1) return { revisionId, messages: history, planCostUsd: 0 };
        return {
          revisionId,
          messages: [
            ...history,
            { role: "user", content: "Add tests" },
            { role: "assistant", content: "Server reply. [PLAN_COMPLETE]" },
          ],
          planCostUsd: 0.02,
        };
      }
      if (key === "planChat") {
        chatCalls += 1;
        throw new Error("response lost");
      }
      return baseApi(key, options);
    });
    render(view());

    await sendMessage("Add tests");
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Retry send" }));

    expect(await screen.findByText("Server reply.")).toBeVisible();
    expect(screen.getByText(/is done planning/)).toBeVisible();
    expect(screen.getByText("planning cost $0.02")).toBeVisible();
    expect(screen.getAllByText("Add tests")).toHaveLength(1);
    expect(screen.queryByTestId("pending-turn")).not.toBeInTheDocument();
    expect(chatCalls).toBe(1);
  });

  it.each(["unavailable", "new revision", "changed history"])("refuses a blind retry when reconciliation reports %s", async (failure) => {
    let reads = 0;
    let sends = 0;
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") {
        reads++;
        if (reads > 1 && failure === "unavailable") throw new Error("session unavailable");
        return {
          revisionId: reads > 1 && failure === "new revision" ? "new-revision" : revisionId,
          messages: reads > 1 && failure === "changed history"
            ? [history[0], { role: "assistant", content: "A different answer" }]
            : history,
          planCostUsd: 0,
        };
      }
      if (key === "planChat") { sends++; throw new Error("response lost"); }
      return baseApi(key, options);
    });
    render(view());
    await sendMessage("Keep this message");
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Retry send" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry send" })).toBeEnabled());
    expect(sends).toBe(1);
    expect(screen.getByTestId("pending-turn")).toHaveTextContent("Keep this message");
    expect(screen.getByRole("alert")).not.toHaveTextContent("response lost");
  });

  it("keeps composer text scoped to its project and ignores a previous project's generation", async () => {
    const generation = deferred<{ prdMarkdown: string; tasks: typeof draft[]; costUsd: number }>();
    const projectB = { ...project, id: "other-project" };
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") return { revisionId, messages: history, planCostUsd: 0 };
      if (key === "planDeconstruct") return generation.promise;
      return baseApi(key, options, [project, projectB]);
    });
    const { rerender } = render(view());
    fireEvent.change(await screen.findByLabelText("Planning message"), { target: { value: "Unsent for A" } });
    await userEvent.click(screen.getByRole("button", { name: /Generate task table/ }));
    rerender(view(projectB.id));
    expect(await screen.findByLabelText("Planning message")).toHaveValue("");
    await act(async () => { generation.resolve({ prdMarkdown: "A plan", tasks: [draft], costUsd: 1 }); });
    expect(screen.queryByDisplayValue("Build login")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate task table/ })).toBeEnabled();
    rerender(view());
    expect(await screen.findByLabelText("Planning message")).toHaveValue("Unsent for A");
  });

  it("adopts a reply completed while away without restoring a duplicate pending turn", async () => {
    const reply = deferred<{ reply: string; costUsd: number }>();
    const projectB = { ...project, id: "other-project" };
    let serverMessages = history;
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") return { revisionId, messages: serverMessages, planCostUsd: 0 };
      if (key === "planChat") return reply.promise;
      return baseApi(key, options, [project, projectB]);
    });
    const { rerender } = render(view());
    await sendMessage("Keep this turn");
    rerender(view(projectB.id));
    expect(await screen.findByLabelText("Planning message")).toHaveValue("");
    await act(async () => {
      serverMessages = [...history, { role: "user", content: "Keep this turn" }, { role: "assistant", content: "Accepted while away" }];
      reply.resolve({ reply: "Accepted while away", costUsd: 0 });
    });
    rerender(view());
    expect(await screen.findByText("Accepted while away")).toBeVisible();
    expect(screen.queryByTestId("pending-turn")).not.toBeInTheDocument();
    expect(screen.getAllByText("Keep this turn")).toHaveLength(1);
  });

  it("Edit message returns the failed turn to the composer without clobbering typed text", async () => {
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") return { revisionId, messages: [], planCostUsd: 0 };
      if (key === "planChat") throw new Error("offline");
      return baseApi(key, options);
    });
    render(view());

    await sendMessage("Add tests");
    await screen.findByRole("alert");
    fireEvent.change(screen.getByLabelText("Planning message"), {
      target: { value: "more context" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Edit message" }));

    expect(screen.getByLabelText("Planning message")).toHaveValue(
      "Add tests\n\nmore context",
    );
    expect(screen.queryByTestId("pending-turn")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });
});

describe("VW02: draft saves are truthful", () => {
  beforeEach(() => {
    apiMock.mockReset();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("does not save on load, shows Saved only after acknowledgement, and recovers from a failed save", async () => {
    const saveBodies: DraftBody[] = [];
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") {
        return { revisionId, messages: [], prd: "# Plan", draftTasks: [draft], planCostUsd: 0 };
      }
      if (key === "planSaveDraft") {
        saveBodies.push(options?.body as DraftBody);
        if (saveBodies.length === 1) throw new Error("disk full");
        return { ok: true };
      }
      return baseApi(key, options);
    });
    render(view());

    expect(await screen.findByDisplayValue("Build login")).toBeVisible();
    expect(saveStatus()).toHaveTextContent("Edits are saved automatically.");
    await act(async () => {
      await Promise.resolve();
    });
    expect(saveBodies).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Task 1 title"), {
      target: { value: "Build login (edited)" },
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Draft save failed: disk full");
    expect(saveStatus()).toHaveTextContent("Save failed");
    expect(screen.getByDisplayValue("Build login (edited)")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(saveStatus()).toHaveTextContent("Saved"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(saveBodies).toHaveLength(2);
    expect(saveBodies[1]?.tasks[0]?.title).toBe("Build login (edited)");
    expect(saveBodies[1]?.revisionId).toBe(revisionId);
  });

  it("serializes saves so the server cannot apply an older edit after a newer one", async () => {
    const saves: Array<{ body: DraftBody; control: ReturnType<typeof deferred<{ ok: true }>> }> = [];
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") {
        return { revisionId, messages: [], prd: "# Plan", draftTasks: [draft], planCostUsd: 0 };
      }
      if (key === "planSaveDraft") {
        const control = deferred<{ ok: true }>();
        saves.push({ body: options?.body as DraftBody, control });
        return control.promise;
      }
      return baseApi(key, options);
    });
    render(view());
    expect(await screen.findByDisplayValue("Build login")).toBeVisible();

    fireEvent.change(screen.getByLabelText("Task 1 title"), { target: { value: "A" } });
    await waitFor(() => expect(saves).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("Task 1 title"), { target: { value: "AB" } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(saves).toHaveLength(1);
    expect(saves[0]?.body.tasks[0]?.title).toBe("A");
    expect(saveStatus()).toHaveTextContent("Saving…");

    await act(async () => {
      saves[0]!.control.resolve({ ok: true });
      await saves[0]!.control.promise;
    });
    expect(saveStatus()).toHaveTextContent("Saving…");
    expect(saveStatus()).not.toHaveTextContent("Saved");
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]?.body.tasks[0]?.title).toBe("AB");

    await act(async () => {
      saves[1]!.control.reject(new Error("newer save lost"));
      await saves[1]!.control.promise.catch(() => {});
    });
    expect(saveStatus()).toHaveTextContent("Save failed");
    expect(screen.getByRole("alert")).toHaveTextContent("newer save lost");

    await userEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(saves).toHaveLength(3));
    expect(saves[2]?.body.tasks[0]?.title).toBe("AB");
    await act(async () => {
      saves[2]!.control.resolve({ ok: true });
      await saves[2]!.control.promise;
    });
    await waitFor(() => expect(saveStatus()).toHaveTextContent("Saved"));
  });

  it("clears an older save error when the queued newer draft is acknowledged", async () => {
    const first = deferred<{ ok: true }>();
    let saveCalls = 0;
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") return { revisionId, messages: [], prd: "# Plan", draftTasks: [draft], planCostUsd: 0 };
      if (key === "planSaveDraft") {
        saveCalls++;
        return saveCalls === 1 ? first.promise : { ok: true };
      }
      return baseApi(key, options);
    });
    render(view());
    fireEvent.change(await screen.findByLabelText("Task 1 title"), { target: { value: "First" } });
    await waitFor(() => expect(saveCalls).toBe(1));
    fireEvent.change(screen.getByLabelText("Task 1 title"), { target: { value: "Newest" } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await act(async () => { first.reject(new Error("First save failed")); });
    await waitFor(() => expect(saveStatus()).toHaveTextContent("Saved"));
    expect(saveCalls).toBe(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a stale revision offers a reload that restores the server's acknowledged draft", async () => {
    let sessionReads = 0;
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") {
        sessionReads += 1;
        return {
          revisionId: sessionReads === 1 ? revisionId : "22222222-2222-4222-8222-222222222222",
          messages: [],
          prd: "# Plan",
          draftTasks: [sessionReads === 1 ? draft : { ...draft, title: "Server copy" }],
          planCostUsd: 0,
        };
      }
      if (key === "planSaveDraft") {
        throw new ApiRequestError(
          "planning revision is stale — reload the planning session",
          409,
        );
      }
      return baseApi(key, options);
    });
    render(view());
    expect(await screen.findByDisplayValue("Build login")).toBeVisible();

    fireEvent.change(screen.getByLabelText("Task 1 title"), {
      target: { value: "Local edit" },
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/stale/);
    expect(alert).toHaveTextContent(/Reload the session/);
    expect(screen.getByDisplayValue("Local edit")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Reload session" }));
    expect(await screen.findByDisplayValue("Server copy")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(saveStatus()).toHaveTextContent("Edits are saved automatically.");
  });

  it("switching projects flushes the old project's edits, never shows them as the new project's, and restores them on return", async () => {
    const projectA = { ...project, id: "plan-a", name: "Plan A" };
    const projectB = { ...project, id: "plan-b", name: "Plan B" };
    const saves: Array<{ id: string; body: DraftBody; control: ReturnType<typeof deferred<{ ok: true }>> }> = [];
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") {
        const id = options?.params?.id;
        return {
          revisionId,
          messages: [],
          prd: `# ${id}`,
          draftTasks: [{ ...draft, title: id === projectA.id ? "A task" : "B task" }],
          planCostUsd: 0,
        };
      }
      if (key === "planSaveDraft") {
        const control = deferred<{ ok: true }>();
        saves.push({ id: options?.params?.id ?? "", body: options?.body as DraftBody, control });
        return control.promise;
      }
      return baseApi(key, options, [projectA, projectB]);
    });
    const { rerender } = render(view(projectA.id));
    expect(await screen.findByDisplayValue("A task")).toBeVisible();

    fireEvent.change(screen.getByLabelText("Task 1 title"), {
      target: { value: "A edit" },
    });
    await waitFor(() => expect(saves).toHaveLength(1));
    rerender(view(projectB.id));
    expect(await screen.findByDisplayValue("B task")).toBeVisible();

    // The switch flushed a final save for A; nothing was sent for B.
    expect(saves.every((save) => save.id === projectA.id)).toBe(true);
    expect(saves.at(-1)?.body.tasks[0]?.title).toBe("A edit");
    const flushed = saves.length;
    expect(flushed).toBeGreaterThanOrEqual(1);

    // The cleanup flush is serialized behind the in-flight write.
    await act(async () => { saves[0]!.control.reject(new Error("A save failed")); });
    await waitFor(() => expect(saves).toHaveLength(2));
    await act(async () => { saves[1]!.control.reject(new Error("A flush failed")); });
    expect(saveStatus()).toHaveTextContent("Edits are saved automatically.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(view(projectA.id));
    expect(await screen.findByDisplayValue("A edit")).toBeVisible();
    await waitFor(() => expect(saves.length).toBeGreaterThan(flushed));
    expect(saves.at(-1)?.id).toBe(projectA.id);
    expect(saves.at(-1)?.body.tasks[0]?.title).toBe("A edit");
    await act(async () => {
      saves.at(-1)!.control.resolve({ ok: true });
      await saves.at(-1)!.control.promise;
    });
    await waitFor(() => expect(saveStatus()).toHaveTextContent("Saved"));
  });

  it("commit waits for the previous save to settle and sends the exact visible draft", async () => {
    const pendingSave = deferred<{ ok: true }>();
    let commitBody: DraftBody | undefined;
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") {
        return { revisionId, messages: [], prd: "# Plan", draftTasks: [draft], planCostUsd: 0 };
      }
      if (key === "planSaveDraft") return pendingSave.promise;
      if (key === "planCommit") {
        commitBody = options?.body as DraftBody;
        return {
          revisionId,
          project: { ...project, status: "planned" },
          tasks: [{ title: "Final" }],
          prdMarkdown: "# Plan",
        };
      }
      return baseApi(key, options);
    });
    render(view());
    expect(await screen.findByDisplayValue("Build login")).toBeVisible();

    fireEvent.change(screen.getByLabelText("Task 1 title"), {
      target: { value: "Final" },
    });
    await waitFor(() => expect(saveStatus()).toHaveTextContent("Saving…"));
    await userEvent.click(
      screen.getByRole("button", { name: "Approve & Create Tasks" }),
    );
    expect(commitBody).toBeUndefined();
    expect(screen.getByLabelText("Task 1 title")).toBeDisabled();
    await act(async () => {
      pendingSave.reject(new Error("late save failed"));
      await pendingSave.promise.catch(() => {});
    });
    expect(await screen.findByText("1 tasks created")).toBeVisible();
    expect(commitBody?.revisionId).toBe(revisionId);
    expect(commitBody?.tasks[0]?.title).toBe("Final");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/late save failed/)).not.toBeInTheDocument();
  });

  it.each([true, false])("switch-time flush preserves the right draft when generation success is %s", async (succeeds) => {
    const generation = deferred<{ prdMarkdown: string; tasks: typeof draft[]; costUsd: number }>();
    const projectB = { ...project, id: "other-project" };
    let serverTitle = draft.title;
    const writes: string[] = [];
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") return { revisionId, messages: history, prd: "# Plan", draftTasks: [{ ...draft, title: serverTitle }], planCostUsd: 0 };
      if (key === "planDeconstruct") return generation.promise;
      if (key === "planSaveDraft") {
        serverTitle = (options?.body as DraftBody).tasks[0]!.title;
        writes.push(serverTitle);
        return { ok: true };
      }
      return baseApi(key, options, [project, projectB]);
    });
    const slowView = (id: string) => <ToastProvider><PlanView projectId={id} onDone={vi.fn()} saveDebounceMs={60_000} /></ToastProvider>;
    const { rerender } = render(slowView(project.id));
    fireEvent.change(await screen.findByLabelText("Task 1 title"), { target: { value: "Unsaved edit" } });
    await userEvent.click(screen.getByRole("button", { name: /Re-generate task table/ }));
    expect(screen.getByLabelText("Task 1 title")).toBeDisabled();
    rerender(slowView(projectB.id));
    await screen.findByLabelText("Task 1 title");
    await act(async () => {
      if (succeeds) {
        serverTitle = "Generated replacement";
        generation.resolve({ prdMarkdown: "# New", tasks: [{ ...draft, title: serverTitle }], costUsd: 0 });
      } else generation.reject(new Error("generation failed"));
    });
    rerender(slowView(project.id));
    expect(await screen.findByLabelText("Task 1 title")).toHaveValue(succeeds ? "Generated replacement" : "Unsaved edit");
    expect(writes).toEqual(succeeds ? [] : ["Unsaved edit"]);
  });

  it("guards reload/close only while work is unsaved", async () => {
    const pendingSave = deferred<{ ok: true }>();
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") {
        return { revisionId, messages: [], prd: "# Plan", draftTasks: [draft], planCostUsd: 0 };
      }
      if (key === "planSaveDraft") return pendingSave.promise;
      return baseApi(key, options);
    });
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    render(view());
    expect(await screen.findByDisplayValue("Build login")).toBeVisible();
    const guardAdds = () => added.mock.calls.filter(([type]) => type === "beforeunload").length;
    const guardRemoves = () => removed.mock.calls.filter(([type]) => type === "beforeunload").length;
    expect(guardAdds()).toBe(0);

    fireEvent.change(screen.getByLabelText("Task 1 title"), {
      target: { value: "Guarded" },
    });
    await waitFor(() => expect(guardAdds()).toBe(1));
    await act(async () => {
      pendingSave.resolve({ ok: true });
      await pendingSave.promise;
    });
    await waitFor(() => expect(saveStatus()).toHaveTextContent("Saved"));
    expect(guardRemoves()).toBe(1);
    added.mockRestore();
    removed.mockRestore();
  });
});
