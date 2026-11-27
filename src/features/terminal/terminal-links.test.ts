import { expect, it } from "vitest";
import { terminalLinkDestination } from "./terminal-links";

it.each([
  ["http://example.com/report", "http://example.com/report"],
  ["HTTPS://Example.COM/report?format=html", "https://example.com/report?format=html"],
  ["https://example.com/a;b", "https://example.com/a;b"],
  ["mailto:help@example.com?subject=SSH%20Astra", "mailto:help@example.com?subject=SSH%20Astra"],
])("returns the destination of an allowed link (%s)", (uri, destination) => {
  expect(terminalLinkDestination(uri)).toBe(destination);
});

it.each([
  "file:///tmp/report",
  "ssh://example.com",
  "javascript:alert(1)",
  "data:text/plain,hello",
  "tel:+15551234567",
  "//example.com",
  " https://example.com",
  "ht\ttps://example.com",
  "https:example.com",
  "https:///example.com",
  "https://",
  "https://example.com/%xyz",
  "https://example.com/\u202Ereport",
  "https://example.com/%E2%80%AEreport",
  "mailto://example.com",
])("rejects an unsupported, malformed, or deceptive link (%s)", (uri) => {
  expect(terminalLinkDestination(uri)).toBeNull();
});
