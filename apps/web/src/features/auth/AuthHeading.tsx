import { t } from "../../i18n/index.js";
import { useEffect, useRef } from "react";

export function AuthHeading({ title, focus = true }: { title: string; focus?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previous = document.title;
    document.title = t("privateBase2", { title });
    if (focus) heading.current?.focus();
    return () => { document.title = previous; };
  }, [title, focus]);
  return <h1 ref={heading} tabIndex={-1} className="text-[1.75rem] leading-tight font-semibold tracking-tight outline-none">{title}</h1>;
}
