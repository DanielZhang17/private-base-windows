import type { SVGProps } from "react";
import { ICON_PATHS, type IconName } from "./icons/paths.js";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** Pixel size of the square icon box. Defaults to 20. */
  size?: number;
  /** Accessible name. Omit for decorative icons, which are hidden from assistive tech. */
  label?: string;
}

export function Icon({ name, size = 20, label, ...rest }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      data-icon={name}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      {...rest}
      style={{ flexShrink: 0, ...rest.style }}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
