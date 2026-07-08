import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

/* Netlify Identity can't reach a backend in jsdom; mock it so the app
   settles into signed-out mode immediately instead of waiting on the
   production init-timeout fallback. */
vi.mock("netlify-identity-widget", () => {
  const handlers = {};
  return {
    default: {
      on: (ev, cb) => { handlers[ev] = cb; if (ev === "init") setTimeout(() => cb(null), 0); },
      init: () => {}, open: () => {}, close: () => {}, logout: () => {}, currentUser: () => null,
    },
  };
});

import Planner from "../src/App.jsx";

beforeEach(() => { cleanup(); localStorage.clear(); });

describe("Rollover app", () => {
  it("mounts and shows the header without runtime errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Planner />);
    await waitFor(() => expect(screen.getByText("Rollover")).toBeTruthy(), { timeout: 3000 });
    const real = spy.mock.calls.filter((c) => !String(c[0]).includes("not wrapped in act"));
    expect(real).toHaveLength(0);
    spy.mockRestore();
  });

  it("adds a quick task and schedules it onto the calendar", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Planner />);
    await waitFor(() => screen.getByPlaceholderText(/Quick task/i));
    const input = screen.getByPlaceholderText(/Quick task/i);
    fireEvent.change(input, { target: { value: "Write report" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByText("Write report").length).toBeGreaterThan(0));
    const real = spy.mock.calls.filter((c) => !String(c[0]).includes("not wrapped in act"));
    expect(real).toHaveLength(0);
    spy.mockRestore();
  });

  it("switches views (day/week/month) without crashing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Planner />);
    await waitFor(() => screen.getByText("month"));
    fireEvent.click(screen.getByText("month"));
    await waitFor(() => screen.getByText("Sun"));
    fireEvent.click(screen.getByText("day"));
    await waitFor(() => screen.getByText("week"));
    fireEvent.click(screen.getByText("week"));
    const real = spy.mock.calls.filter((c) => !String(c[0]).includes("not wrapped in act"));
    expect(real).toHaveLength(0);
    spy.mockRestore();
  });

  it("opens the new-event modal with both Event and Task options", async () => {
    render(<Planner />);
    await waitFor(() => screen.getByText("＋ New"));
    fireEvent.click(screen.getByText("＋ New"));
    await waitFor(() => expect(screen.getByText("New Event")).toBeTruthy());
    /* segmented control offers both types */
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toContain("Event");
    expect(buttons).toContain("Task");
  });
});

describe("mobile layout", () => {
  it("hides the task sidebar behind a drawer on narrow screens", async () => {
    window.innerWidth = 390;
    window.dispatchEvent(new Event("resize"));
    render(<Planner />);
    await waitFor(() => screen.getByLabelText("Open tasks"));
    /* quick-add lives in the drawer, so it should not be visible yet */
    expect(screen.queryByPlaceholderText(/Quick task/i)).toBeNull();
    fireEvent.click(screen.getByLabelText("Open tasks"));
    await waitFor(() => expect(screen.getByPlaceholderText(/Quick task/i)).toBeTruthy());
    window.innerWidth = 1024;
  });
});
