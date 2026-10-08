// Skill discovery uses the same defaults for system prompts and slash commands.
import { cleanUp, modelTexts, newSession, openApp, root, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { loadPocketSkills } from "../src/server/skills.ts";

after(cleanUp);

function writeSkill(directory: string, name: string, description = name): string {
    const folder = join(directory, name);
    const file = join(folder, "SKILL.md");

    mkdirSync(folder, { recursive: true });
    writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\nUse ${name}.\n`);

    return file;
}

test("user skills replace Pi's default, with project and configured skills still available", () => {
    const cwd = join(root, "discovery", "project");
    const agentDir = join(root, "discovery", "agent");
    const userSkills = join(root, "discovery", "home", ".agents", "skills");
    const extra = join(root, "discovery", "extra");
    const userFile = writeSkill(userSkills, "shared", "User version");
    const projectFile = writeSkill(join(cwd, ".pi", "skills"), "project");
    const extraFile = writeSkill(extra, "extra");

    writeSkill(join(agentDir, "skills"), "legacy");
    writeSkill(join(cwd, ".pi", "skills"), "shared", "Project version");
    writeSkill(extra, "shared", "Extra version");

    const { skills } = loadPocketSkills(cwd, agentDir, [extra, userFile], userSkills);

    assert.deepEqual(
        skills.map((skill) => skill.filePath),
        [userFile, projectFile, extraFile],
    );
    assert.equal(skills[0]!.description, "User version");
    assert.deepEqual(
        loadPocketSkills(cwd, agentDir, [join(agentDir, "skills")], userSkills).skills.map(
            (skill) => skill.name,
        ),
        ["shared", "project", "legacy"],
        "Pi's old user directory can still be explicitly configured",
    );
});

test("missing default folders do not prevent configured skills from loading", () => {
    const cwd = join(root, "missing", "project");
    const agentDir = join(root, "missing", "agent");
    const extra = join(root, "missing", "extra");
    const file = writeSkill(extra, "configured");
    const loaded = loadPocketSkills(cwd, agentDir, [extra], join(root, "missing", "skills"));

    assert.deepEqual(
        loaded.skills.map((skill) => skill.filePath),
        [file],
    );
    assert.deepEqual(loaded.diagnostics, []);
});

test("~/.agents instructions and skills load alongside Pocket docs and slash commands", async () => {
    const cwd = join(root, "integration", "project");
    const file = writeSkill(join(homedir(), ".agents", "skills"), "pocket-test");
    const userAgents = join(homedir(), ".agents", "AGENTS.md");
    const legacyFile = writeSkill(join(process.env.PI_CODING_AGENT_DIR!, "skills"), "old-test");
    const sections: Record<string, string> = {};

    writeFileSync(userAgents, "Shared user instructions");

    const app = await openApp(
        scriptedModel((request) => {
            for (const message of (
                request as {
                    messages: { role: string; sections?: Record<string, string | null> }[];
                }
            ).messages) {
                if (message.role === "system") {
                    for (const [name, value] of Object.entries(message.sections ?? {})) {
                        if (value === null) {
                            delete sections[name];
                        } else {
                            sections[name] = value;
                        }
                    }
                }
            }

            return fauxAssistantMessage([fauxText("OK")]);
        }),
        join(root, "skills-data"),
    );

    try {
        mkdirSync(cwd, { recursive: true });

        const id = await newSession(app, cwd);

        assert.deepEqual(
            app.skillCommands(id).map((skill) => skill.path),
            [file],
        );
        await say(app, id, "Which skills are available?");
        assert.ok(sections.project_context?.includes(`<file path="${userAgents}">`));
        assert.ok(sections.project_context?.includes("Shared user instructions"));
        assert.match(sections.pocket_docs ?? "", /Pi Pocket documentation/);
        assert.match(sections.preamble ?? "", /^You are a coding agent running inside Pi Pocket/);
        assert.ok(sections.skills?.includes(`<location>${file}</location>`));
        assert.ok(!sections.skills?.includes(legacyFile));

        await say(app, id, "/skill:pocket-test check this");
        assert.match((await modelTexts(app, id)).join("\n"), /Use pocket-test/);
    } finally {
        await app.close();
    }
});
