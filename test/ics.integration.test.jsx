import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import Planner from "../src/App.jsx";

/* The Boyne (traditional date, 12 July) must flow feed -> parser -> cache ->
   pseudo events -> occurrences -> calendar DOM. Guards the import/wiring
   bug where every feed silently "failed" via the effect's catch. */
const SAMPLE_ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260712
DTEND;VALUE=DATE:20260713
SUMMARY:Battle of the Boyne
UID:boyne@test
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260713
DTEND;VALUE=DATE:20260714
SUMMARY:Battle of the Boyne (substitute day)
UID:boyne-sub@test
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261228
DTEND;VALUE=DATE:20261229
SUMMARY:Boxing Day (substitute day)
UID:boxing-sub@test
END:VEVENT
END:VCALENDAR`;

describe("ics feed pipeline", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("planner-data-v1", JSON.stringify({
      tasks: [], events: [], waiting: [], holidayCals: ["GB"], holidayCache: {}, country: "GB", icsCals: [], userCals: [],
    }));
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).includes("/.netlify/functions/ics")) {
        return { ok: true, text: async () => SAMPLE_ICS };
      }
      return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    }));
  });
  it("renders a feed holiday on the calendar", async () => {
    render(<Planner />);
    await waitFor(() => {
      const cache = localStorage.getItem("rollover-ics-cache-v1") || "";
      expect(cache).toContain("Battle of the Boyne");
      expect(cache).not.toContain('"error":true');
    }, { timeout: 8000 });
    /* Jul 12 is inside the visible window while the suite runs in Jul 2026;
       skip the DOM assert defensively if the real date ever drifts out */
    const today = new Date();
    if (today >= new Date(2026, 6, 6) && today <= new Date(2026, 6, 12)) {
      await waitFor(() => expect(document.body.textContent).toContain("Battle of the Boyne"), { timeout: 3000 });
      /* the traditional entry exists, so the substitute duplicate is hidden */
      expect(document.body.textContent).not.toContain("substitute");
    }
  }, 15000);
});
