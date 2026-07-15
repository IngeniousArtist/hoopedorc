import { describe, expect, it } from "vitest";
import { hashFor, parseHash } from "./App";

describe("application deep links", () => {
  it("round-trips project and global pages", () => {
    expect(parseHash(hashFor("board", "proj-1"))).toEqual({
      page: "board",
      projectId: "proj-1",
    });
    expect(parseHash(hashFor("settings", "proj-1"))).toEqual({ page: "settings" });
  });

  it("rejects unknown, incomplete, and non-linkable destinations", () => {
    expect(parseHash("#/p/proj-1/not-a-page")).toBeNull();
    expect(parseHash("#/p/proj-1")).toBeNull();
    expect(parseHash("#/welcome")).toBeNull();
    expect(parseHash("#/totally-unknown")).toBeNull();
  });
});
