import { describe, expect, it } from "vitest";
import { boardInstanceKey, hashFor, parseHash } from "./App";

describe("application deep links", () => {
  it("round-trips project and global pages", () => {
    expect(parseHash(hashFor("board", "proj-1"))).toEqual({
      page: "board",
      projectId: "proj-1",
    });
    expect(parseHash(hashFor("settings", "proj-1"))).toEqual({ page: "settings" });
    expect(parseHash(hashFor("model-slugs", "proj-1"))).toEqual({
      page: "model-slugs",
    });
  });

  it("rejects unknown, incomplete, and non-linkable destinations", () => {
    expect(parseHash("#/p/proj-1/not-a-page")).toBeNull();
    expect(parseHash("#/p/proj-1")).toBeNull();
    expect(parseHash("#/welcome")).toBeNull();
    expect(parseHash("#/totally-unknown")).toBeNull();
    expect(parseHash("#/settings/extra")).toBeNull();
    expect(parseHash("#/p/proj-1/plan/task-1")).toBeNull();
    expect(parseHash("#/p/proj-1/board/task-1/more")).toBeNull();
    expect(parseHash("#/p/proj-1/board/")).toEqual({ page: "board", projectId: "proj-1" });
  });

  it("VW04: round-trips a task inspector deep link on the board only", () => {
    expect(hashFor("board", "proj-1", "task-1")).toBe("#/p/proj-1/board/task-1");
    expect(parseHash("#/p/proj-1/board/task-1")).toEqual({
      page: "board",
      projectId: "proj-1",
      taskId: "task-1",
    });
    expect(parseHash(hashFor("board", "proj-1", "id with/slash"))).toEqual({
      page: "board",
      projectId: "proj-1",
      taskId: "id with/slash",
    });
    expect(hashFor("board", "proj-1", null)).toBe("#/p/proj-1/board");
    expect(hashFor("costs", "proj-1", "task-1")).toBe("#/p/proj-1/costs");
    expect(parseHash("#/p/proj-1/board/%E0%A4%A")).toBeNull();
  });

  it("names the keyed Board independently from sibling project views", () => {
    expect(boardInstanceKey("proj-1")).toBe("board:proj-1");
    expect(boardInstanceKey("proj-1")).not.toBe("proj-1");
  });
});
