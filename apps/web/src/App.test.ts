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
  });

  it("names the keyed Board independently from sibling project views", () => {
    expect(boardInstanceKey("proj-1")).toBe("board:proj-1");
    expect(boardInstanceKey("proj-1")).not.toBe("proj-1");
  });
});
