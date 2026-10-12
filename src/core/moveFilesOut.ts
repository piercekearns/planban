// The tidy-up for strict Local Mode: moves the files out of a card's folder to
// a folder the person chooses, then records where they went in the card's Spec.
// It never overwrites and never deletes a file: each one is moved, or copied
// and checked before the original is removed when the folders are on
// different disks.
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, readlink, readdir, realpath, rmdir, symlink, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
    const name = rest.length ? `${first}/` : first!;
    // An empty folder ("name/") adds the folder but no file.
    top.set(name, (top.get(name) ?? 0) + (file.endsWith("/") ? 0 : 1));
  }
  return [...top].map(([name, count]) => {
    const where = friendlyPath(join(destination, name.replace(/\/$/, "")));
    if (!name.endsWith("/")) return `- On ${machine}: ${where}`;
    const contents = count ? `a folder of ${count} file${count === 1 ? "" : "s"}` : "an empty folder";
    return `- On ${machine}: ${where}${where.startsWith("~") ? "/" : sep} (${contents})`;
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

/** A path with every existing folder on the way resolved through links, so a link cannot lead back into Planban. */
async function realPathOf(path: string): Promise<string> {
  const real = await realpath(path).catch(() => null);
  if (real) return real;
  const parent = dirname(path);
  return parent === path ? path : join(await realPathOf(parent), basename(path));
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Paths at the destination that already exist, or that sit under something that is not a folder. */
async function conflictsAt(destination: string, files: string[]) {
  const conflicts: string[] = [];
  for (const file of files) {
    const target = join(destination, file);
    if (file.endsWith("/")) {
      // An empty folder may join a folder already there; it replaces nothing.
      const info = await lstat(target).catch(() => null);
      if (info && !info.isDirectory()) conflicts.push(target.replace(/[\\/]$/u, ""));
      if (info) continue;
    } else if (await exists(target)) {
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

/** Entries Planban will not move: anything but a file, a link or an empty folder. */
async function unmovable(folder: string, files: string[]) {
  const found: string[] = [];
  for (const file of files) {
    if (file.endsWith("/")) continue;
    const info = await lstat(join(folder, file)).catch(() => null);
    if (!info || !(info.isFile() || info.isSymbolicLink())) found.push(file);
  }
  return found;
}

/** Moves one file without ever replacing an existing one. */
async function moveOne(input: { folder: string; file: string; destination: string; realDestination: string; moving: Set<string> }) {
  const source = join(input.folder, input.file);
  const target = join(input.destination, input.file);
  await mkdir(dirname(target), { recursive: true });
  // Checked again as each folder is made, in case a link appeared on the way since the start.
  if (!inside(input.realDestination, await realpath(dirname(target)))) {
    throw new Error(`${dirname(target)} now leads outside the chosen folder`);
  }
  if (input.file.endsWith("/")) {
    await mkdir(target, { recursive: true });
    await rmdir(source);
    return;
  }
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    const pointsAt = await readlink(source);
    // A relative link keeps working if it points at something moving with it; otherwise (the Spec or Plan,
    // which stay, or anything outside the card folder) it is made absolute.
    const resolved = resolve(dirname(source), pointsAt);
    await symlink(isAbsolute(pointsAt) || input.moving.has(resolved) ? pointsAt : resolved, target);
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
    throw new PlanbanValidationError(`${source} is not a file or a link, so Planban will not move it. Move it yourself.`);
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

    const realDestination = await realPathOf(destination);
    const planbanFolders = [state.planningRoot, defaultPlanbanRoot()];
    const realPlanbanFolders = await Promise.all(planbanFolders.map(realPathOf));
    if (planbanFolders.some((root) => isPathInsideRoot(root, destination)) || realPlanbanFolders.some((root) => inside(root, realDestination))) {
      throw new PlanbanValidationError(`Choose a folder outside Planban's own folders (${friendlyPath(defaultPlanbanRoot())}), such as the project's repository or a shared drive. Planban is an index and keeps no files.`);
    }
    const destinationInfo = await lstat(destination).catch(() => null);
    if (destinationInfo && !destinationInfo.isDirectory()) {
      throw new PlanbanValidationError(`${friendlyPath(destination)} is a file, not a folder. Choose a folder to move the files to.`);
    }

    const refused = await unmovable(folder, files);
    if (refused.length) {
      throw new PlanbanValidationError(`Nothing was moved: Planban moves only files, links and empty folders, and ${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} something else. Move ${refused.length === 1 ? "it" : "them"} yourself, then run the command again.`);
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

    // Everything that moves, and the folders holding it, so relative links between them can stay relative.
    const moving = new Set<string>();
    for (const file of files) {
      for (let path = join(folder, file.replace(/\/$/u, "")); path !== folder && inside(folder, path); path = dirname(path)) moving.add(path);
    }
    const moved: string[] = [];
    let failure: unknown = null;
    for (const file of files) {
      try {
        await moveOne({ folder, file, destination, realDestination, moving });
        moved.push(file);
      } catch (error) {
        failure = error;
        break;
      }
    }
    await removeEmptyFolders(folder);
    let recordingError: unknown = null;
    if (moved.length) {
      try {
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
        // Files left behind after a failure keep the card flagged; record the ones that moved anyway.
        recordingMovedFiles: true,
        });
      } catch (error) {
        recordingError = error;
      }
    }
    const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
    // If the Spec could not be updated, the references must not be lost: hand back the exact section to add.
    const unrecorded = recordingError
      ? ` The Files section could not be added to the card's Spec (${messageOf(recordingError)}), so add it yourself, for example with planban write-doc:\n\n${filesSection({ spec: spec.markdown, files: moved, destination, machine, now })}`
      : "";
    if (failure) {
      throw new Error(`Moved ${moved.length} of ${files.length} files, then stopped: ${messageOf(failure)}. Nothing was deleted${recordingError ? "." : ", and the Spec lists the files that moved."} Fix the problem and run the command again to move the rest.${unrecorded}`);
    }
    if (recordingError) {
      throw new Error(`Moved ${moved.length === 1 ? "the file" : `all ${moved.length} files`} to ${friendlyPath(destination)}, and nothing was deleted.${unrecorded}`);
    }
    return { ...result, specSection: filesSection({ spec: spec.markdown, files: moved, destination, machine, now }) };
  });
}
