import { useContext, useLayoutEffect, useMemo, type ReactNode } from "react";
import { UNSAFE_NavigationContext, useNavigate } from "react-router-dom";
import { navigatePastOverlays, watchOverlayHistory } from "../ui/overlay-stack.js";
import { registerNavigate } from "./navigation.js";

function RegisterNavigation() {
  const navigate = useNavigate();
  useLayoutEffect(() => registerNavigate(navigate), [navigate]);
  return null;
}

export function RouterNavigation({ children }: { children?: ReactNode }) {
  const context = useContext(UNSAFE_NavigationContext);
  useLayoutEffect(watchOverlayHistory, []);
  // Apply the same history rule to links, redirects and imperative navigation.
  const value = useMemo(() => ({
    ...context,
    navigator: {
      ...context.navigator,
      push: (...args: Parameters<typeof context.navigator.push>) =>
        navigatePastOverlays(() => context.navigator.push(...args)),
      replace: (...args: Parameters<typeof context.navigator.replace>) =>
        navigatePastOverlays(() => context.navigator.replace(...args)),
    },
  }), [context]);
  return <UNSAFE_NavigationContext.Provider value={value}><RegisterNavigation />{children}</UNSAFE_NavigationContext.Provider>;
}
