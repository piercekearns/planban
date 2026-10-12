// The tidy-up for strict Local Mode: moves the files out of a card's folder to
// a folder the person chooses, then records where they went in the card's Spec.
// It never overwrites and never deletes a file: each one is moved, or copied
// and checked before the original is removed when the folders are on
// different disks.
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, readlink, readdir, rmdir, symlink, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { PlanbanConflictError, PlanbanNotFoundError, PlanbanValidationError } from "./boardOperations";
import { cardFolder } from "./cardFiles";
import { checkIndexDocument } from "./contentRules";
import { filesInCard, friendlyPath, machineName } from "./indexCheck";
import { defaultPlanbanRoot, expandHome, isPathInsideRoot } from "./paths";
import { loadState, readDoc, withRoadmapWriteLock, writeDoc } from "./storage";
import type { PlanbanHistoryActor } from "./types";

export interface MoveFilesOutResult {
  cardId: string;
  title: string;
  dryRun: boolean;
  /** True when the card's folder held no files, so nothing was done. */
  alreadyClean: boolean;
  machine: string;
  destination: string;
  /** Each file, by its path inside the card folder, and where it goes. */
  moves: Array<{ from: string; to: string }>;
  /** Paths that already exist at the destination; nothing moves while there are any. */
  conflicts: string[];
  /** The section added to the end of the card's Spec. */
  specSection: string;
}

function exists(path: string) {
  return lstat(path).then(() => true, () => false);
}

function longDate(now: Date) {
  return now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** One line per top-level file or folder, so a folder of many files stays one reference. */
function referenceLines(files: string[], destination: string, machine: string) {
  const top = new Map<string, number>();
  for (const file of files) {
    const [first, ...rest] = file.split("/");
    top.set(rest.length ? `${first}/` : first!, (top.get(rest.length ? `${first}/` : first!) ?? 0) + 1);
  }
  return [...top].map(([name, count]) => {
    const where = friendlyPath(join(destination, name.replace(/\/$/, "")));
    return name.endsWith("/")
      ? `- On ${machine}: ${where}/ (a folder of ${count} file${count === 1 ? "" : "s"})`
      : `- On ${machine}: ${where}`;
  });
}

function filesSection(input: { spec: string; files: string[]; destination: string; machine: string; now: Date }) {
  const heading = /^## Files\s*$/mu.test(input.spec) ? `## Files moved out on ${longDate(input.now)}` : "## Files";
  return [
    heading,
    "",
    `Moved out of this card's Planban folder on ${longDate(input.now)}. Planban is an index, not file storage, so these files now live here:`,
    "",
    ...referenceLines(input.files, input.destination, input.machine),
    "",
  ].join("\n");
}

/** Paths at the destination that already exist, or that sit under something that is not a folder. */
async function conflictsAt(destination: string, files: string[]) {
  const conflicts: string[] = [];
  for (const file of files) {
    const target = join(destination, file);
    if (await exists(target)) {
      conflicts.push(target);
      continue;
    }
    let parent = dirname(target);
    while (parent.length > destination.length) {
      const info = await lstat(parent).catch(() => null);
      if (info && !info.isDirectory()) {
        conflicts.push(parent);
        break;
      }
      parent = dirname(parent);
    }
  }
  return [...new Set(conflicts)];
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

/** Moves one file without ever replacing an existing one. */
async function moveOne(source: string, target: string) {
  await mkdir(dirname(target), { recursive: true });
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), target);
  } else if (info.isFile()) {
    try {
      // A hard link fails if the target exists, so nothing is ever replaced.
      await link(source, target);
    } catch (error) {
      if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK"].includes(errorCode(error))) throw error;
      await copyFile(source, target, constants.COPYFILE_EXCL);
      if ((await lstat(target)).size !== info.size) {
        throw new Error(`Copying ${source} to ${target} did not complete; the original is untouched.`);
      }
    }
  } else {
    throw new PlanbanValidationError(`${source} is not a regular file or link, so Planban will not move it. Move it yourself.`);
  }
  await unlink(source);
}

/** Removes folders inside the card folder that the move left empty. */
async function removeEmptyFolders(folder: string) {
  const visit = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) {
        await visit(join(dir, entry.name));
        await rmdir(join(dir, entry.name)).catch(() => undefined);
      }
    }
  };
  await visit(folder);
}

export async function moveFilesOut(input: {
  cwd: string;
  cardId: string;
  to: string;
  dryRun?: boolean | undefined;
  actor?: PlanbanHistoryActor | undefined;
  /** Overrides the machine name, for tests. */
  machine?: string | undefined;
  now?: Date | undefined;
}): Promise<MoveFilesOutResult> {
  if (!input.to?.trim()) throw new PlanbanValidationError("Choose a folder to move the files to, outside Planban, such as the project's repository or a shared drive.");
  return withRoadmapWriteLock(input.cwd, async () => {
    const state = await loadState(input.cwd);
    const item = state.roadmap.roadmapItems.find((entry) => entry.id === input.cardId);
    if (!item) throw new PlanbanNotFoundError(`Card not found: ${input.cardId}`);
    const machine = input.machine ?? machineName();
    const now = input.now ?? new Date();
    const destination = resolve(state.cwd, expandHome(input.to.trim()));
    const folder = cardFolder(state.planningRoot, item.id);
    const files = await filesInCard(state.planningRoot, item.id);
    const base = { cardId: item.id, title: item.title, dryRun: input.dryRun === true, machine, destination };
    if (!files.length) return { ...base, alreadyClean: true, moves: [], conflicts: [], specSection: "" };

    if (isPathInsideRoot(state.planningRoot, destination) || isPathInsideRoot(defaultPlanbanRoot(), destination)) {
      throw new PlanbanValidationError(`Choose a folder outside Planban's own folders (${friendlyPath(defaultPlanbanRoot())}), such as the project's repository or a shared drive. Planban is an index and keeps no files.`);
    }
    const destinationInfo = await lstat(destination).catch(() => null);
    if (destinationInfo && !destinationInfo.isDirectory()) {
      throw new PlanbanValidationError(`${friendlyPath(destination)} is a file, not a folder. Choose a folder to move the files to.`);
    }

    const moves = files.map((file) => ({ from: file, to: join(destination, file) }));
    const conflicts = await conflictsAt(destination, files);
    const spec = await readDoc({ cwd: state.cwd, cardId: item.id, kind: "spec" });
    const specSection = filesSection({ spec: spec.markdown, files, destination, machine, now });
    const result = { ...base, alreadyClean: false, moves, conflicts, specSection };
    if (input.dryRun) return result;
    if (conflicts.length) {
      throw new PlanbanConflictError(
        `Nothing was moved: ${conflicts.length === 1 ? "this path already exists" : "these paths already exist"} in ${friendlyPath(destination)}, and Planban never overwrites a file: ${conflicts.map((path) => relative(destination, path).split(sep).join("/")).join(", ")}. Choose another folder, or move those files yourself.`,
      );
    }
    const withSection = (moved: string[]) => {
      const section = filesSection({ spec: spec.markdown, files: moved, destination, machine, now });
      return spec.exists && spec.markdown.trim() ? `${spec.markdown.trimEnd()}\n\n${section}` : `# ${item.title} Spec\n\n${section}`;
    };
    // Refuse before moving anything if the Spec could not take the new section.
    checkIndexDocument(withSection(files), item.id, "spec");

    const moved: string[] = [];
    let failure: unknown = null;
    for (const file of files) {
      try {
        await moveOne(join(folder, file), join(destination, file));
        moved.push(file);
      } catch (error) {
        failure = error;
        break;
      }
    }
    await removeEmptyFolders(folder);
    if (moved.length) {
      await writeDoc({
        cwd: state.cwd,
        cardId: item.id,
        kind: "spec",
        markdown: withSection(moved),
        history: {
          actor: input.actor ?? "user",
          operation: "card.files.move-out",
          summary: `Moved ${moved.length} file${moved.length === 1 ? "" : "s"} out of ${item.title} to ${machine}: ${friendlyPath(destination)}`,
          affectedCards: [item.id],
          affectedDocs: [{ cardId: item.id, kind: "spec", path: item.specDoc ?? `items/${item.id}/spec.md` }],
        },
      });
    }
    if (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      throw new Error(`Moved ${moved.length} of ${files.length} files, then stopped: ${reason}. Nothing was deleted, and the Spec lists the files that moved. Fix the problem and run the command again to move the rest.`);
    }
    return { ...result, specSection: filesSection({ spec: spec.markdown, files: moved, destination, machine, now }) };
  });
}
