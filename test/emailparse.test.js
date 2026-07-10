import { describe, it, expect } from "vitest";
import { parseEmail } from "../netlify/functions/lib/parse-email.cjs";

const FLIGHT_HTML = `<html><body><p>Your booking</p>
<script type="application/ld+json">
{"@context":"http://schema.org","@type":"FlightReservation","reservationNumber":"ABC123",
 "reservationFor":{"@type":"Flight","flightNumber":"1234","airline":{"@type":"Airline","iataCode":"BA"},
 "departureAirport":{"@type":"Airport","iataCode":"BFS"},"arrivalAirport":{"@type":"Airport","iataCode":"LHR"},
 "departureTime":"2026-07-20T14:30:00+01:00","arrivalTime":"2026-07-20T15:55:00+01:00"}}
</script></body></html>`;

const HOTEL_HTML = `<html><script type="application/ld+json">
[{"@type":"LodgingReservation","reservationNumber":"HH9",
  "reservationFor":{"@type":"LodgingBusiness","name":"The Grand","address":{"streetAddress":"1 Sea Rd"}},
  "checkinTime":"2026-07-20T15:00:00","checkoutTime":"2026-07-23T11:00:00"}]
</script></html>`;

describe("parse-email", () => {
  it("parses a flight reservation from JSON-LD", () => {
    const [s] = parseEmail({ subject: "Your flight confirmation", html: FLIGHT_HTML, text: "" });
    expect(s.kind).toBe("flight");
    expect(s.title).toContain("BA1234");
    expect(s.title).toContain("BFS → LHR");
    expect(s.date).toBe("2026-07-20");
    expect(s.start).toBe(14 * 60 + 30);
    expect(s.end).toBe(15 * 60 + 55);
  });
  it("parses a multi-night hotel stay as all-day span", () => {
    const [s] = parseEmail({ subject: "Booking confirmed", html: HOTEL_HTML, text: "" });
    expect(s.kind).toBe("hotel");
    expect(s.title).toContain("The Grand");
    expect(s.date).toBe("2026-07-20");
    expect(s.endDate).toBe("2026-07-23");
    expect(s.allDay).toBe(true);
  });
  it("falls back to heuristics on plain text", () => {
    const [s] = parseEmail({ subject: "Fwd: Dentist appointment", html: "", text: "Reminder: your appointment is on 21 July 2026 at 9:15 am. Please arrive early." });
    expect(s.kind).toBe("appointment");
    expect(s.title).toBe("Dentist appointment");
    expect(s.date).toBe("2026-07-21");
    expect(s.start).toBe(9 * 60 + 15);
  });
  it("returns nothing when no date is findable", () => {
    expect(parseEmail({ subject: "Newsletter", html: "", text: "Hello! Great offers inside." })).toHaveLength(0);
  });
});
