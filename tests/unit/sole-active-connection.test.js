import { describe, it, expect } from "vitest";
import { isSoleActiveConnection } from "../../open-sse/services/accountFallback.js";

describe("isSoleActiveConnection", () => {
  it("returns true when the failing connection is the only active one", () => {
    const connections = [
      { id: "A", isActive: true },
    ];
    expect(isSoleActiveConnection(connections, "A")).toBe(true);
  });

  it("returns false when there is another active connection to fall back to", () => {
    const connections = [
      { id: "A", isActive: true },
      { id: "B", isActive: true },
    ];
    expect(isSoleActiveConnection(connections, "A")).toBe(false);
  });

  it("ignores the failing connection itself when counting others", () => {
    // Two connections but B is the failing one; A is the only other active.
    // Even though B is in the list, A alone remains — but A is a valid fallback,
    // so B is NOT sole. We're asking: from B's perspective, is there anyone else?
    const connections = [
      { id: "A", isActive: true },
      { id: "B", isActive: true },
    ];
    expect(isSoleActiveConnection(connections, "B")).toBe(false);
  });

  it("treats the failing connection as excluded, so disabled siblings count as sole", () => {
    // Failing connection B; only other connection A is inactive.
    // From B's perspective: no active fallback → sole active path.
    const connections = [
      { id: "A", isActive: false },
      { id: "B", isActive: true },
    ];
    expect(isSoleActiveConnection(connections, "B")).toBe(true);
  });

  it("returns false when the failing connection has another active sibling despite disabled ones", () => {
    const connections = [
      { id: "A", isActive: false }, // disabled, doesn't help
      { id: "B", isActive: true },  // failing (excluded)
      { id: "C", isActive: true },  // active fallback exists
    ];
    expect(isSoleActiveConnection(connections, "B")).toBe(false);
  });

  it("handles numeric isActive (0/1) the same as boolean", () => {
    const connections = [
      { id: "A", isActive: 0 }, // disabled (numeric)
      { id: "B", isActive: 1 }, // failing, only active
    ];
    expect(isSoleActiveConnection(connections, "B")).toBe(true);
  });

  it("returns false when there is no other connection at all", () => {
    // Edge: failing connection has no siblings. From its perspective there's
    // no active fallback → that IS sole. So expect true.
    expect(isSoleActiveConnection([{ id: "A", isActive: true }], "A")).toBe(true);
  });

  it("returns true for an empty connections list (no fallback possible)", () => {
    expect(isSoleActiveConnection([], "A")).toBe(true);
  });

  it("returns false when connectionId or connections is missing/invalid", () => {
    expect(isSoleActiveConnection([{ id: "A", isActive: true }], "")).toBe(false);
    expect(isSoleActiveConnection(null, "A")).toBe(false);
    expect(isSoleActiveConnection(undefined, "A")).toBe(false);
  });

  it("is robust to connections missing an isActive field (treated as active)", () => {
    // If isActive is undefined, the code uses `c?.isActive !== false && c?.isActive !== 0`.
    // So a connection with no isActive flag is considered active by default.
    const connections = [
      { id: "A" }, // no isActive flag → treated as active
      { id: "B", isActive: true },
    ];
    // From B's perspective: A is active → not sole.
    expect(isSoleActiveConnection(connections, "B")).toBe(false);
  });

  it("returns true when the only sibling has no isActive flag but is the failing one", () => {
    // From A's perspective: no other connection → sole.
    const connections = [{ id: "A" }];
    expect(isSoleActiveConnection(connections, "A")).toBe(true);
  });
});
