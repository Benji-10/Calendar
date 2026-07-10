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

describe("forwarded emails", () => {
  it("ignores the forwarded header's send-date and finds the travel date", () => {
    const text = `---------- Forwarded message ---------
From: Cathay Pacific <noreply@cathaypacific.com>
Date: Wed, 8 Jul 2026 at 15:02
Subject: Your boarding pass for flight CX238
To: ben@example.com

Your flight CX238 departs on 20 July 2026 at 23:35 from Gate 12.`;
    const [s] = parseEmail({ subject: "Fwd: Your boarding pass for flight CX238 to Hong Kong", html: "", text });
    expect(s.kind).toBe("flight");
    expect(s.date).toBe("2026-07-20");
    expect(s.start).toBe(23 * 60 + 35);
    expect(s.title).toBe("Your boarding pass for flight CX238 to Hong Kong");
  });
});

describe("attachments and date preference", () => {
  it("parses an attached .ics as the authoritative source", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART:20260720T233500
DTEND:20260721T041500
SUMMARY:CX238 HKG
UID:cx238@cathay
END:VEVENT
END:VCALENDAR`;
    const out = parseEmail({
      subject: "Fwd: Your boarding pass",
      html: "", text: "Sent on 8 July 2026. See attached.",
      attachments: [{ name: "flight.ics", contentType: "text/calendar", content: Buffer.from(ics).toString("base64") }],
    });
    expect(out[0].kind).toBe("calendar");
    expect(out[0].title).toBe("CX238 HKG");
    expect(out[0].date).toBe("2026-07-20");
    expect(out[0].start).toBe(23 * 60 + 35);
  });
  it("prefers a future date over the email's own past timestamps", () => {
    const [s] = parseEmail({
      subject: "Your booking",
      html: "",
      text: "Booked on 2 July 2026 at 09:12. Your table is confirmed for 25 July 2026 at 19:30. Reservation ref 88.",
    });
    expect(s.date).toBe("2026-07-25");
    expect(s.start).toBe(19 * 60 + 30);
  });
  it('strips "On ... wrote:" attribution lines', () => {
    const [s] = parseEmail({
      subject: "Fwd: Appointment",
      html: "",
      text: "On Wed, 8 Jul 2026 at 15:02, Clinic <x@y> wrote:\nYour appointment is on 22 July 2026 at 10:00.",
    });
    expect(s.date).toBe("2026-07-22");
    expect(s.start).toBe(600);
  });
});

describe("timezone instants", () => {
  it("carries the utc instant for Z-stamped ics attachments", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART:20260706T125500Z
DTEND:20260706T141700Z
SUMMARY:Split Ticketing
UID:split@test
END:VEVENT
END:VCALENDAR`;
    const [s] = parseEmail({ subject: "Fwd: Booking", html: "", text: "",
      attachments: [{ name: "trip.ics", contentType: "text/calendar", content: Buffer.from(ics).toString("base64") }] });
    expect(s.startUtcMs).toBe(Date.UTC(2026, 6, 6, 12, 55));
    expect(s.endUtcMs).toBe(Date.UTC(2026, 6, 6, 14, 17));
  });
  it("pins the instant for offset-bearing JSON-LD times", () => {
    const html = `<script type="application/ld+json">
{"@type":"FlightReservation","reservationFor":{"@type":"Flight","flightNumber":"250",
 "airline":{"iataCode":"CX"},"departureAirport":{"iataCode":"HKG"},"arrivalAirport":{"iataCode":"LHR"},
 "departureTime":"2026-08-01T16:00:00+08:00","arrivalTime":"2026-08-01T22:05:00+01:00"}}
</script>`;
    const [s] = parseEmail({ subject: "Your flight", html, text: "" });
    /* wall time as written stays for reference; the instant enables local display */
    expect(s.start).toBe(16 * 60);
    expect(s.startUtcMs).toBe(Date.UTC(2026, 7, 1, 8, 0));
    expect(s.endUtcMs).toBe(Date.UTC(2026, 7, 1, 21, 5));
  });
  it("leaves floating times without an instant", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART:20260720T233500
SUMMARY:Local thing
UID:float@test
END:VEVENT
END:VCALENDAR`;
    const [s] = parseEmail({ subject: "x", html: "", text: "",
      attachments: [{ name: "a.ics", contentType: "text/calendar", content: Buffer.from(ics).toString("base64") }] });
    expect(s.startUtcMs).toBeNull();
    expect(s.start).toBe(23 * 60 + 35);
  });
});
