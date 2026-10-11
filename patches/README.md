# Dependency patches

Pi Pocket pins `@earendil-works/pi-durable` and `@earendil-works/pi-ai` to `1.1.0`.
These patches add a persisted OpenAI service tier for each conversation.
They change the installed JavaScript and TypeScript declarations, not provider pricing.

`patch-package` is a production dependency. The `postinstall` script applies these
patches with `--error-on-fail`, including during `npm ci --omit=dev`.
Do not install with `--ignore-scripts` unless you run `npm run postinstall` before
starting Pi Pocket.

## Behavior

The Pi Durable patch adds optional `serviceTier: "default" | "priority"` to the
stored agent and its resolved view. A configuration change with `null` clears
this preference. Without an agent tier, the patch uses the harness-wide tier.
Without either tier, it leaves the provider default unchanged.

Pi Pocket sets the harness-wide tier to `"default"`. Newly prepared requests use
standard service unless the conversation selects `"priority"`, even when the
OpenAI project defaults to priority. This also applies to existing conversations
without a stored tier. The existing agent document supplies restart persistence
and inheritance for forks and subagents.

Generation preparation and compaction selection save the tier in their request
checkpoints. A checkpoint is the saved state of a task. Recovery uses those saved
request options rather than the current agent preference or harness default.
Old checkpoints without a tier still omit it during recovery. A new generation
retry returns through preparation and can capture a changed preference.

One helper, `resolveStreamOptions`, copies request options and selects the agent
tier before the optional harness-wide tier. It includes the tier only for these
resolved model pairs:

- Provider `openai`, API `openai-responses`.
- Provider `openai-codex`, API `openai-codex-responses`.

Other provider/API pairs receive no tier, including subagents that inherit a tier
but use another provider. The guard does not inspect custom endpoint overrides
under either allowed provider ID.

The Pi AI patch adds the same optional field to `SimpleStreamOptions`. Both
Responses adapters forward it from `streamSimple` to their native `stream`
implementation. The existing adapters still set the request payload and calculate
costs, including the Codex fallback when a priority response reports `default`.

## Maintenance

When upgrading either dependency:

1. Review its native tier support before retaining the patch.
2. Update the pinned version and lockfile together.
3. Regenerate the relevant patch with `npx patch-package @earendil-works/pi-durable` or `npx patch-package @earendil-works/pi-ai`.
4. Test a clean `npm ci --omit=dev` in a temporary copy with these patches.
5. Run the type, lint, and test commands in Pi Pocket.
6. Test checkpoint recovery, provider isolation, compaction, and native pricing.

Keep every dependency change in these patch files. Do not rely on an untracked
change inside `node_modules`. Remove a patch only after the pinned upstream
version supplies the required behavior and the tests pass.
