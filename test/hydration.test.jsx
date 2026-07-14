import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import Planner from "../src/App.jsx";

describe("offline-first startup", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("planner-data-v1", JSON.stringify({
      tasks: [{ id: "t1", title: "Offline task", duration: 60, priority: 2, category: "work", done: false, createdAt: 1 }],
      events: [], waiting: [], holidayCals: [], holidayCache: {}, country: "GB", icsCals: [], userCals: [],
    }));
    /* network completely dead — hydration must not need it */
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  });
  it("renders from the local mirror without waiting for the network", async () => {
    render(<Planner />);
    /* synchronous hydration: content visible on the very first paint cycle */
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.textContent).toContain("Offline task");
    expect(document.body.textContent).not.toContain("Loading Rollover");
  });
});
