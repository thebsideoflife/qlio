import { updateProject } from "@/services/api";

/**
 * Project renames save immediately instead of riding the 10s editor autosave,
 * which dropped them when the user left the editor (or opened Export) first.
 * While a save is in flight, a project load must show the new name, not the
 * server's old one. Kept outside Redux so it survives resetEditor on route change.
 */
const pendingTitles = new Map<string, string>();

export function pendingProjectTitle(projectId: string): string | undefined {
  return pendingTitles.get(projectId);
}

export async function saveProjectTitle(
  projectId: string,
  title: string,
): Promise<void> {
  pendingTitles.set(projectId, title);
  try {
    await updateProject(projectId, { title });
  } finally {
    if (pendingTitles.get(projectId) === title) pendingTitles.delete(projectId);
  }
}
