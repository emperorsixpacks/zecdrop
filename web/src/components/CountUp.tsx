import { useState } from "react";

import { useCountTo } from "@/lib/use-count";
import { motionScale } from "@/lib/motion";
import { formatZec } from "@/lib/zec";

/** An amount of coin that counts to its value. */
export function CountUp({ zatoshi, className }: { zatoshi: bigint; className?: string }) {
  const final = formatZec(zatoshi);
  const decimals = final.includes(".") ? (final.split(".")[1] ?? "").length : 0;
  // Starts at the value when nothing will move (reduced motion, or no way to tell).
  const [shown, setShown] = useState<bigint>(() => (motionScale() === 0 ? zatoshi : 0n));
  useCountTo(Number(zatoshi), (value) => {
    setShown(BigInt(Math.round(value)));
  });

  // While it runs it shows no more decimals than the finished number has, so it does not jitter.
  const step = 10n ** BigInt(8 - decimals);
  const text = formatZec(shown === zatoshi ? zatoshi : (shown / step) * step);
  const [whole = "0", fraction = ""] = text.split(".");
  // The digits are tabular, so the width does not change while it counts. The decimal point is
  // left out of that: the font gives it a digit's width under tabular figures. The box is as wide
  // as the finished number, so a longer one does not push its neighbours.
  const digits = final.replace(/\D/gu, "").length;
  const room = { minWidth: `${(digits + (decimals > 0 ? 0.3 : 0)).toFixed(1)}ch` };
  if (decimals === 0) {
    return (
      <span className={`${className ?? ""} inline-block tabular-nums`} style={room}>
        {whole}
      </span>
    );
  }
  return (
    <span className={`${className ?? ""} inline-block`} style={room}>
      <span className="tabular-nums">{whole}</span>.<span className="tabular-nums">{fraction.padEnd(decimals, "0")}</span>
    </span>
  );
}

/** A whole number that counts to its value ("5 people"). */
export function CountInt({ value }: { value: number }) {
  const [shown, setShown] = useState(() => (motionScale() === 0 ? value : 0));
  useCountTo(value, (v) => {
    setShown(Math.round(v));
  });
  return (
    <span className="inline-block tabular-nums" style={{ minWidth: `${String(String(value).length)}ch` }}>
      {shown}
    </span>
  );
}
