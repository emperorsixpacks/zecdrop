// The home page tour: one payout in six steps, each with the screen that shows it.
//
// The pictures are taken by e2e/operator/tour-shots.spec.ts (its header says how to run it) from the
// real operator on the practice chain, and from the bundled real testnet receipt. They are served from
// public/tour/, one file per look: /tour/<id>-light.webp and /tour/<id>-dark.webp.
//
// Their sizes are written here, not read from the files, so the page holds the space before a picture
// arrives and nothing moves. The spec takes its sizes from here and refuses a picture of another size,
// and tests/tour-images.test.ts compares these numbers with the files themselves.
//
// This file imports nothing, so the spec (which Playwright runs on its own) can import it.

export type TourLook = "light" | "dark";

export const TOUR_LOOKS: readonly TourLook[] = ["light", "dark"];

/** Where the pictures are served from (web/public/tour). */
export const TOUR_DIR = "/tour";

/** Every picture is this wide: the operator's page at a tablet's width, shown at about its own size. */
export const TOUR_WIDTH = 640;

export interface TourShot {
  /** The file name without the look and the extension. */
  id: string;
  /** In pixels, as the file is. */
  height: number;
  /** What the screen shows, for someone who cannot see it. */
  alt: string;
  /** The words under it, visible. */
  caption: string;
}

export interface TourStep {
  id: string;
  title: string;
  text: string;
  /** What anyone can see at this step, on the chain or on the receipt. */
  publicNote: string;
  /** What stays hidden from them. */
  hiddenNote: string;
  shots: readonly TourShot[];
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "add",
    title: "Add the payouts",
    text: "Import your list, or type people in one by one.",
    publicNote: "Nothing yet.",
    hiddenNote: "The whole list. Only the operator on your computer has it.",
    shots: [
      {
        id: "add-payouts",
        height: 860,
        alt: "The operator's Add the payouts screen for an organisation. The run is named Autumn grants. Above the list it says 8 people, 0.005 TAZ; each row shows a shortened address, an amount and a memo.",
        caption: "Operator screen: Add the payouts",
      },
    ],
  },
  {
    id: "check",
    title: "Check the payouts",
    text: "See the total, the fee and any privacy warnings before anything is sent.",
    publicNote: "Nothing yet. Once sent: the total, the fee and how many payouts.",
    hiddenNote: "Who gets what. A tiny batch or equal amounts can give it away.",
    shots: [
      {
        id: "check-payouts",
        height: 1380,
        alt: "The operator's Check the payouts screen: 8 people, 0.005 TAZ plus a 0.00045 TAZ fee. In the public view every address and amount is a black bar. No privacy warnings.",
        caption: "Operator screen: Check the payouts",
      },
    ],
  },
  {
    id: "fund",
    title: "Fund the campaign",
    text: "Send coins to the funding address. The operator waits until it sees them.",
    publicNote: "The deposit: its address, its amount and where it came from.",
    hiddenNote: "Who the payouts are for.",
    shots: [
      {
        id: "fund-waiting",
        height: 900,
        alt: "The operator's Fund and send screen while it waits for funds. Practice mode offers a button that records a pretend deposit, and the Send 8 payouts button is greyed out.",
        caption: "Operator screen: waiting for funds",
      },
      {
        id: "fund-funded",
        height: 800,
        alt: "The same screen once the pretend deposit is recorded. A green tick says Funded, and the Send 8 payouts button is ready.",
        caption: "Operator screen: funded",
      },
    ],
  },
  {
    id: "send",
    title: "Send",
    text: "The operator asks once, then builds one transaction, sends it and waits for confirmations.",
    publicNote: "One transaction: the total, the fee and how many payouts.",
    hiddenNote: "Who got paid, and how much each person got.",
    shots: [
      {
        id: "send-sheet",
        height: 640,
        alt: "A sheet asks Send 8 payouts? It says this sends 8 payouts, 0.005 TAZ plus 0.00045 TAZ fee, and cannot be undone. Its buttons are Send 8 payouts and Cancel.",
        caption: "Operator screen: the confirmation sheet",
      },
      {
        id: "send-timeline",
        height: 1060,
        alt: "The sending timeline: Preparing, Proving and Sending are done, Confirming 1 is under way, and Confirming 2, Confirming 3 and Done are still to come.",
        caption: "Operator screen: the sending timeline",
      },
    ],
  },
  {
    id: "receipt",
    title: "The public receipt",
    text: "Share one link. Anyone can open the receipt and check the total.",
    publicNote: "The total, the fee, how many payouts and the funding address.",
    hiddenNote: "Who got paid and how much. Only an auditor can check it matches the list.",
    shots: [
      {
        id: "receipt",
        height: 1500,
        alt: "The public receipt page for the real testnet batch: Settled, 8 payouts, 0.005 TAZ, fee 0.00045 TAZ, funded from one address, out in 8 outputs. Below, eight rows of black bars hide who got what.",
        caption: "The public receipt of the real testnet batch",
      },
    ],
  },
  {
    id: "audit",
    title: "The audit",
    text: "An auditor with the viewing key checks the chain against the list, on their own computer.",
    publicNote: "Nothing from the audit itself.",
    hiddenNote: "Everything stays hidden from the public. Whoever holds the key sees it all, for good.",
    shots: [
      {
        id: "audit",
        height: 1050,
        alt: "The operator's Audit screen: the command an auditor runs on their own computer, and a list of what the audit checks.",
        caption: "Operator screen: Audit",
      },
    ],
  },
];

/** What the audit command prints last when the chain and the list agree (crates/drop-operator/src/audit.rs). */
export const AUDIT_RESULT = "RESULT: reconciled. The chain shows exactly the payout list, in the committed amounts.";

/** Every picture of the tour, in order. */
export const TOUR_SHOTS: readonly TourShot[] = TOUR_STEPS.flatMap((step) => step.shots);

/** The address of one picture in one look. */
export function tourImageSrc(shot: Pick<TourShot, "id">, look: TourLook): string {
  return `${TOUR_DIR}/${shot.id}-${look}.webp`;
}
