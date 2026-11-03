import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateMap, type MapFile, type MapListEntry } from "@lootbot/shared";

/** Saved maps: one JSON file each in the `maps/` folder. */
export class MapStore {
  constructor(private dir: string) {}

  /** Turn a map name into a safe file name, e.g. "Level 1 - Open Field" → "level-1-open-field.json". */
  static fileFor(name: string) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "map";
    return `${slug}.json`;
  }

  private pathOf(file: string) {
    const base = path.basename(file);
    if (!base.endsWith(".json")) throw new Error("Map files must end in .json.");
    return path.join(this.dir, base);
  }

  async list(): Promise<MapListEntry[]> {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json")).sort();
    const out: MapListEntry[] = [];
    for (const file of files) {
      try {
        const m = await this.load(file);
        out.push({ file, name: m.name, width: m.width, height: m.height });
      } catch {
        // Skip unreadable files.
      }
    }
    return out;
  }

  async load(file: string): Promise<MapFile> {
    return JSON.parse(await readFile(this.pathOf(file), "utf8"));
  }

  /** Save a map. Refuses invalid maps unless `force` is set. Returns the file name. */
  async save(map: MapFile, file?: string, force = false) {
    const v = validateMap(map);
    if (!v.ok && !force) throw new Error(v.errors.join(" "));
    const name = file ? path.basename(file) : MapStore.fileFor(map.name);
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathOf(name), JSON.stringify(map, null, 2) + "\n");
    return name;
  }

  async remove(file: string) {
    await rm(this.pathOf(file));
  }
}
