import { Avatar } from "../../ui/index.js";
import { resolveAvatarImageUrl } from "../../features/chat/avatar.js";

interface UserAvatarProps {
  avatarUrl?: string | null;
  displayName: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
  online?: boolean;
  group?: boolean;
}

export default function UserAvatar({ avatarUrl, displayName, size = "md", className, online, group }: UserAvatarProps) {
  return <Avatar name={displayName} src={avatarUrl ? resolveAvatarImageUrl(avatarUrl) : null} size={size}
    className={className} shape={group ? "rounded" : "circle"} presence={online ? "online" : undefined} />;
}

export { resolveAvatarImageUrl };
