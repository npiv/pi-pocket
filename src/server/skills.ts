/** Shared skill discovery for the system prompt and `/skill:name` commands. */
import { CONFIG_DIR_NAME, loadSkills } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Use ~/.agents/skills instead of Pi's user default, followed by project and configured skills. */
export function loadPocketSkills(
    cwd: string,
    agentDir: string,
    paths: readonly string[],
    userSkillsDir = join(homedir(), ".agents", "skills"),
) {
    const defaults = [userSkillsDir, resolve(cwd, CONFIG_DIR_NAME, "skills")].filter((path) =>
        existsSync(path),
    );

    return loadSkills({
        cwd,
        agentDir,
        skillPaths: [...defaults, ...paths],
        includeDefaults: false,
    });
}
