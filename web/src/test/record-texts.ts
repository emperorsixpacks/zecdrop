// Recording what a page said, instead of looking for it.
//
// A text that is on the screen for a fixed number of milliseconds (a step of a simulated run, the debounce of a refresh) cannot
// be waited for: a test that polls looks away for just as long as a slow machine takes between two looks, and the text comes and
// goes unseen. This watches the DOM change instead, and looks at the page after every change to it, so a text that was on the
// screen at all, for however short a time, is in the list. A test then asks, afterwards, what was said and what never was.

/** The text of every element that holds some of its own, trimmed and on one line. An element whose text is split in several
 * pieces (React writes `{a} {b}` as three text nodes) still counts as the one sentence it reads as. */
function say(root: Element, into: Set<string>): void {
  for (const element of [root, ...root.querySelectorAll("*")]) {
    const holdsText = Array.from(element.childNodes).some((node) => node.nodeType === 3 && (node.textContent ?? "").trim() !== "");
    if (!holdsText) continue;
    const text = (element.textContent ?? "").replace(/\s+/gu, " ").trim();
    if (text !== "") into.add(text);
  }
}

export interface TextRecorder {
  /** Every distinct text the page showed since recording began (and what it shows now), in the order it was first seen. */
  texts: () => string[];
  /** Stop watching. What was seen stays in `texts()`. */
  stop: () => void;
}

/** Start recording the texts shown under `root` (the whole page by default). The observer runs in the microtask after each change
 * to the DOM, so it sees a state as soon as React has drawn it and before any timer can draw the next. */
export function recordTexts(root: Element = document.body): TextRecorder {
  const seen = new Set<string>();
  say(root, seen);
  const observer = new MutationObserver(() => {
    say(root, seen);
  });
  observer.observe(root, { childList: true, characterData: true, subtree: true });
  return {
    texts: () => {
      say(root, seen);
      return [...seen];
    },
    stop: () => {
      observer.disconnect();
    },
  };
}
