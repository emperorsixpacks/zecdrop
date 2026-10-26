// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import "@/test/dom";

import { UnitNote, UnitProvider } from "./UnitProvider";
import { Zec } from "./Zec";

describe("<Zec>", () => {
  it("labels testnet amounts TAZ", () => {
    render(
      <UnitProvider network="testnet">
        <Zec zatoshi="12500000" />
      </UnitProvider>,
    );
    expect(screen.getByText("0.125 TAZ")).toBeInTheDocument();
  });

  it("labels mainnet amounts ZEC", () => {
    render(
      <UnitProvider network="mainnet">
        <Zec zatoshi="12500000" />
      </UnitProvider>,
    );
    expect(screen.getByText("0.125 ZEC")).toBeInTheDocument();
  });

  it("follows the nearest provider", () => {
    render(
      <UnitProvider network="mainnet">
        <Zec zatoshi="100000000" />
        <UnitProvider network="testnet">
          <Zec zatoshi="200000000" />
        </UnitProvider>
      </UnitProvider>,
    );
    expect(screen.getByText("1 ZEC")).toBeInTheDocument();
    expect(screen.getByText("2 TAZ")).toBeInTheDocument();
  });

  it("without a provider, uses the network this page was built for (testnet by default)", () => {
    render(<Zec zatoshi="100000000" />);
    expect(screen.getByText("1 TAZ")).toBeInTheDocument();
  });

  it("keeps the exact zatoshi value in the tooltip, whatever the coin", () => {
    render(
      <UnitProvider network="testnet">
        <Zec zatoshi="123456789" />
      </UnitProvider>,
    );
    expect(screen.getByText("1.23456789 TAZ")).toHaveAttribute("title", "123456789 zatoshi");
  });

  it("shows Unknown, in no coin, when the amount is not known", () => {
    render(
      <UnitProvider network="testnet">
        <Zec zatoshi={null} />
      </UnitProvider>,
    );
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/TAZ|ZEC/u);
  });
});

describe("<UnitNote>", () => {
  it("explains TAZ on testnet", () => {
    render(
      <UnitProvider network="testnet">
        <UnitNote />
      </UnitProvider>,
    );
    expect(screen.getByText("Amounts are in TAZ, the testnet coin. It has no value.")).toBeInTheDocument();
  });

  it("says nothing on mainnet", () => {
    const { container } = render(
      <UnitProvider network="mainnet">
        <UnitNote />
      </UnitProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
