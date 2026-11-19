import { renderToStaticMarkup } from "react-dom/server";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { RelayDemo } from "./relay-demo";

vi.mock("react", async (original) => ({
  ...await original<object>(),
  useState: vi.fn()
}));

it("shows only the events caused by the actions taken so far", () => {
  const expected = [
    "ListingPublished.v1", "ApplicationSubmitted.v1", "ApplicationSubmitted.v1",
    "RecipientSelected.v1", "HandoffCancelled.v1", "RecipientReoffered.v1", "HandoffCompleted.v1"
  ];
  for (const [step, count] of [1, 2, 3, 4, 6, 7].entries()) {
    vi.mocked(useState).mockReturnValue([step, vi.fn()]);
    const html = renderToStaticMarkup(<RelayDemo />);
    const actual = Array.from(html.matchAll(/<strong>([A-Za-z]+\.v1)<\/strong>/g), (match) => match[1]);
    expect(actual, `step ${step}`).toEqual(expected.slice(0, count));
  }
});
