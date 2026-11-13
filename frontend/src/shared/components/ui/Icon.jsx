import React from "react";
import {
  Archive,
  ArchiveRestore,
  Bell,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  Eye,
  Home,
  Lock,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";

const iconMap = {
  archive: Archive,
  archiveRestore: ArchiveRestore,
  bell: Bell,
  calendarDays: CalendarDays,
  check: Check,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  close: X,
  columns: Columns3,
  delete: Trash2,
  download: Download,
  eye: Eye,
  edit: Pencil,
  home: Home,
  lock: Lock,
  more: MoreVertical,
  plus: Plus,
  upload: Upload,
  users: Users,
};

export default function Icon({
  name,
  size = 18,
  color = "currentColor",
  strokeWidth = 2,
  style,
  ...props
}) {
  const LucideIcon = iconMap[name];

  if (!LucideIcon) {
    if (process.env.NODE_ENV !== "production") {
      // Helps catch typoed icon names during development.
      console.warn(`[Icon] Unknown icon name: "${name}"`);
    }
    return null;
  }

  return (
    <LucideIcon
      size={size}
      color={color}
      strokeWidth={strokeWidth}
      style={style}
      aria-hidden="true"
      focusable="false"
      {...props}
    />
  );
}
