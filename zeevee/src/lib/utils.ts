import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Display-only: "1. Title" — index from list position, not stored on the segment. */
export function formatSegmentLabel(index: number, title: string): string {
  const clean = title.replace(/^\d+\.\s*/, "").trim();
  return clean ? `${index}. ${clean}` : `${index}.`;
}

