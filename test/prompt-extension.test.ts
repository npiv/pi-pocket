// The system prompt's user-level and project-level AGENTS.md context.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadContextFiles } from "../src/server/extensions/prompt.ts";

test("the user's ~/.agents/AGENTS.md loads before Pi and project context", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-pocket-prompt-"));
    const userAgents = join(root, "home", ".agents", "AGENTS.md");
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    const cwd = join(project, "nested");

    try {
        for (const directory of [join(root, "home", ".agents"), agentDir, cwd]) {
            mkdirSync(directory, { recursive: true });
        }

        writeFileSync(userAgents, "User instructions");
        writeFileSync(join(agentDir, "AGENTS.md"), "Pi instructions");
        writeFileSync(join(project, "AGENTS.md"), "Project instructions");

        const warnings: string[] = [];
        const files = loadContextFiles(cwd, agentDir, userAgents, (message) =>
            warnings.push(message),
        );

        assert.deepEqual(
            files.map((file) => [file.path, file.content]),
            [
                [userAgents, "User instructions"],
                [join(agentDir, "AGENTS.md"), "Pi instructions"],
                [join(project, "AGENTS.md"), "Project instructions"],
            ],
        );
        assert.deepEqual(warnings, []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a missing user AGENTS.md does not prevent project context from loading", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-pocket-prompt-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");

    try {
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(project, { recursive: true });
        writeFileSync(join(project, "AGENTS.md"), "Project instructions");

        const warnings: string[] = [];
        const files = loadContextFiles(
            project,
            agentDir,
            join(root, "missing", "AGENTS.md"),
            (message) => warnings.push(message),
        );

        assert.deepEqual(
            files.map((file) => file.content),
            ["Project instructions"],
        );
        assert.deepEqual(warnings, []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
