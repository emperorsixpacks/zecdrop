import { useLayoutEffect, useRef } from "react";
import { NavigationType, useLocation, useNavigationType } from "react-router";

/** A page that is opened by a link or a button starts at its top. The router does not do that for an app like this one, and without it
 * a link at the foot of a page opened the next page at the same depth, with its heading far above the window. A page that is only
 * left and come back to (back, forward) is the browser's own business, and a change that leaves the path alone (a choice in the
 * address, a hash) moves nothing. It draws nothing. It runs in the commit that puts the new page on the screen, so a page change
 * that is a view transition (src/lib/view-transition.ts) has its picture taken at the top. */
export function ScrollToTop() {
  const { pathname } = useLocation();
  const type = useNavigationType();
  const last = useRef(pathname);
  useLayoutEffect(() => {
    if (last.current === pathname) return;
    last.current = pathname;
    if (type !== NavigationType.Pop) window.scrollTo(0, 0);
  }, [pathname, type]);
  return null;
}
