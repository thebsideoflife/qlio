/**
 * Turn word edits that saved the editor's old "[deleted]" placeholder (or a
 * partly erased copy of it, like "[]" or "[delet") back into real deletions
 * (empty text). The editor used to show deleted words as that placeholder, and
 * leaving one saved the placeholder as the word.
 *
 * Each edit is rewritten only if it still holds the value that was read, so a
 * concurrent save is never overwritten. captionSettingsUpdatedAt is left alone:
 * this is not a user edit. An editor tab already open on an affected project
 * can still autosave its older copy, so run this when nobody is editing them.
 *
 * Usage: PROJECTS_TABLE=zeevee-projects \
 *   npx tsx src/maintenance/clear-deleted-placeholder-edits.ts [--apply]
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { captionWordText, type WordEdit } from "../utils/caption-grouping";

const PROJECTS_TABLE = process.env.PROJECTS_TABLE || "zeevee-projects";
const apply = process.argv.includes("--apply");
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** "[deleted]" or a partly erased copy of it: has a bracket, and nothing but "deleted" letters. */
export function isPlaceholderLeftover(value: string): boolean {
  const text = captionWordText(value);
  return /[[\]]/.test(text) && "deleted".includes(text.replace(/[[\]]/g, ""));
}

function editText(edit: WordEdit): string {
  return typeof edit === "string" ? edit : edit?.value ?? "";
}

async function main() {
  let startKey: Record<string, unknown> | undefined;
  let changedProjects = 0;
  let changedEdits = 0;
  let skipped = 0;
  do {
    const page = await docClient.send(
      new ScanCommand({
        TableName: PROJECTS_TABLE,
        ProjectionExpression: "projectId, title, captionSettings.wordEdits",
        ExclusiveStartKey: startKey,
      }),
    );
    startKey = page.LastEvaluatedKey;

    for (const project of page.Items || []) {
      const wordEdits = (project.captionSettings?.wordEdits ?? {}) as Record<string, WordEdit>;
      const leftovers = Object.entries(wordEdits).filter(([, edit]) =>
        isPlaceholderLeftover(editText(edit)),
      );
      if (leftovers.length === 0) continue;
      changedProjects++;
      console.log(`${project.projectId} (${project.title ?? "untitled"}): ${leftovers.length} edit(s)`);

      for (const [key, edit] of leftovers) {
        const isObject = typeof edit === "object" && edit !== null;
        console.log(`  ${key}: ${JSON.stringify(editText(edit))} -> ""`);
        if (!apply) {
          changedEdits++;
          continue;
        }
        try {
          await docClient.send(
            new UpdateCommand({
              TableName: PROJECTS_TABLE,
              Key: { projectId: project.projectId },
              UpdateExpression: isObject
                ? "SET captionSettings.wordEdits.#k.#v = :empty"
                : "SET captionSettings.wordEdits.#k = :empty",
              ConditionExpression: isObject
                ? "captionSettings.wordEdits.#k.#v = :old"
                : "captionSettings.wordEdits.#k = :old",
              ExpressionAttributeNames: isObject ? { "#k": key, "#v": "value" } : { "#k": key },
              ExpressionAttributeValues: { ":empty": "", ":old": editText(edit) },
            }),
          );
          changedEdits++;
        } catch (error) {
          if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
          console.log(`    skipped: changed since it was read`);
          skipped++;
        }
      }
    }
  } while (startKey);

  console.log(
    `${apply ? "Cleared" : "Would clear"} ${changedEdits} edit(s) in ${changedProjects} project(s)` +
      (skipped ? `; ${skipped} skipped` : "") +
      (apply ? "" : ". Re-run with --apply to write."),
  );
}

if (process.argv[1]?.endsWith("clear-deleted-placeholder-edits.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
