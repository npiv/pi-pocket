// Extensions: the modules the owner can turn on and off, Lancet Guard, who may allow risky calls, and when PiP compacts
// its context.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Loader, Sheet, shortPath, Switch } from "../ui.js";

/** What Lancet Guard does here, given the module's switch and Pi's own setting. */
function guardNote(module, guard) {
    if (!guard.available) {
        return { warn: true, text: guard.detail };
    }

    if (!guard.enabled) {
        return {
            warn: true,
            text: "Off in Pi's own settings (~/.pi/lancet-guard.json), so it does not run here either.",
        };
    }

    if (!module.enabled) {
        return {
            warn: true,
            text: "Off in Pi Pocket: bash, write, and edit calls run unchecked here. Pi itself still uses it.",
        };
    }

    return {
        warn: false,
        text: "Checks bash, write, and edit calls. Risky ones wait for someone in the session to allow them.",
    };
}

/** Who may allow a risky call: anyone who can steer, or (for guests) someone other than whoever asked for it. */
function ApprovalRule({ owner }) {
    const others = store.state.server?.approvalRule === "others";
    const change = () =>
        attempt(() => api("settings", { approvalRule: others ? "anyone" : "others" }));

    return html`<div class="setting">
        <div class="grow">
            <div class="small">Approvals need someone else</div>
            <div class="muted small">
                A guest cannot allow a call that their own message led to. You always can.
            </div>
        </div>
        <${Switch}
            on=${others}
            disabled=${!owner}
            label=${`Approvals need someone else: ${others ? "on" : "off"}`}
            onChange=${change}
        />
    </div>`;
}

/** When PiP compacts its own context: once idle above so many tokens (`pip-compact.ts`), or only as sessions do. */
const PIP_COMPACT = [
    [40000, "Above 40k tokens"],
    [60000, "Above 60k tokens"],
    [100000, "Above 100k tokens"],
    [0, "As sessions do"],
];

function PipCompactAt({ owner }) {
    const at = store.state.server?.pipCompactAt ?? 60000;
    const change = (event) =>
        attempt(() => api("settings", { pipCompactAt: Number(event.currentTarget.value) }));

    return html`<div class="setting wrap">
        <div class="grow">
            <div class="small">Compact PiP's context</div>
            <div class="muted small">
                Once PiP is idle above this, older messages become a short summary.
            </div>
        </div>
        <select
            aria-label="Compact PiP's context"
            value=${String(at)}
            disabled=${!owner}
            onChange=${change}
        >
            ${PIP_COMPACT.map(
                ([value, label]) => html`<option value=${String(value)}>${label}</option>`,
            )}
        </select>
    </div>`;
}

export function ExtensionsSheet() {
    const { me } = store.state;
    const owner = me?.role === "owner";
    const [data, setData] = useState(null);
    const [problem, setProblem] = useState(null);
    const [busy, setBusy] = useState(null);
    const load = () =>
        api("extensions").then(
            (result) => {
                setData(result);
                setProblem(null);
            },
            (error) =>
                setProblem(
                    error.status === 404
                        ? "Restart the server (menu → Restart server) to manage extensions from here."
                        : error.message,
                ),
        );

    useEffect(() => {
        load();
    }, []);

    const change = (module, path, body) => {
        setBusy(module.file);
        attempt(async () =>
            setData(await api(`extensions/${encodeURIComponent(module.file)}${path}`, body)),
        ).finally(() => {
            setBusy(null);
            load();
        });
    };

    const toggle = (module) => {
        if (
            module.file === "guard.ts" &&
            module.enabled &&
            !confirm(
                "Turn off Lancet Guard in Pi Pocket?\n\nbash, write, and edit calls will run without checks in every session here. Pi's own setting stays as it is.",
            )
        ) {
            return;
        }

        if (
            module.source === "drop-in" &&
            !module.enabled &&
            !confirm(
                `Turn on ${module.title}?\n\nA drop-in extension runs inside the server with your rights, in every session.`,
            )
        ) {
            return;
        }

        change(module, "", { enabled: !module.enabled });
    };

    return html`<${Sheet} title="Extensions" onClose=${closeSheet}>
        <p class="muted small">
            Extensions give Pi its tools and checks in Pi Pocket. A change applies to every session right away and stays after restarts.${owner ? "" : " Only the owner can change them."}
        </p>
        ${problem && html`<div class="error-box">${problem}</div>`}
        ${!data && !problem && html`<${Loader} label="Loading extensions" />`}
        ${data?.modules.map((module) => {
            const tools = module.extensions.flatMap((extension) => extension.tools);
            const note = module.file === "guard.ts" ? guardNote(module, data.guard) : null;

            return html`<div class=${`extension ${module.enabled ? "" : "off"}`}>
                <div class="extension-main">
                    <div class="extension-title">
                        ${module.title}
                        ${module.error && html` <span class="warn small">· failed to load</span>`}
                    </div>
                    ${module.summary && html`<div class="muted small">${module.summary}</div>`}
                    ${
                        note &&
                        html`<div class=${`small ${note.warn ? "warn" : "ok"}`}>${note.text}</div>`
                    }
                    ${
                        module.file === "guard.ts" &&
                        module.enabled &&
                        html`<${ApprovalRule} owner=${owner} />`
                    }
                    ${
                        module.file === "pip.ts" &&
                        module.enabled &&
                        html`<${PipCompactAt} owner=${owner} />`
                    }
                    ${module.error && html`<div class="error-box small">${module.error}</div>`}
                    <div class="muted small mono">
                        ${module.source === "drop-in" ? `drop-in${module.path ? ` · ${shortPath(module.path, store.state.server?.home)}` : ""}` : module.file}
                        ${tools.length > 0 ? ` · tools: ${tools.join(", ")}` : ""}
                        ${module.required ? " · required" : ""}
                    </div>
                </div>
                <div class="extension-actions">
                    <${Switch}
                        on=${module.enabled}
                        disabled=${!owner || module.required || busy !== null}
                        label=${`${module.title}: ${module.enabled ? "on" : "off"}`}
                        onChange=${() => toggle(module)}
                    />
                    ${
                        owner &&
                        module.enabled &&
                        html`<button
                            class="link small"
                            disabled=${busy !== null}
                            onClick=${() => change(module, "/reload", {})}
                        >
                            Reload
                        </button>`
                    }
                </div>
            </div>`;
        })}
        ${
            data?.dropIns &&
            html`<p class="muted small">
                Add your own: put a <span class="mono">.ts</span> extension module in <span class="mono">${shortPath(data.dropIns, store.state.server?.home)}</span>. Drop-ins stay off until the owner turns them on, and run inside the server with the owner's rights.
            </p>`
        }
    <//>`;
}
