import type {
  ListNotificationsResponse,
  ListProjectsResponse,
  Notification,
  Project,
  ServerEvent,
  Settings as SettingsType,
} from "@orc/types";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api, setUnauthorizedHandler } from "./api/client";
import { useWS } from "./hooks/useWS";
import { useBrowserNotify } from "./hooks/useBrowserNotify";
import { useToast } from "./hooks/useToast";
import { ProjectHeader } from "./components/ProjectHeader";
import { TokenGate } from "./components/TokenGate";
import { AuditView } from "./pages/AuditView";
import { Board } from "./pages/Board";
import { CostView } from "./pages/CostView";
import { NewProject } from "./pages/NewProject";
import { Notifications } from "./pages/Notifications";
import { PlanView } from "./pages/PlanView";
import { ProjectsView } from "./pages/ProjectsView";
import { Settings } from "./pages/Settings";
import { SetupView } from "./pages/SetupView";
import { Welcome } from "./pages/Welcome";

export type Page =
  | "board"
  | "plan"
  | "costs"
  | "audit"
  | "notifications"
  | "settings"
  | "setup"
  | "new-project"
  | "projects"
  // Not a nav tab — only reached via the first-run auto-redirect (F1) or
  // SetupView's "Re-run setup" link.
  | "welcome";

const NAV: { page: Page; label: string }[] = [
  { page: "board", label: "Board" },
  { page: "plan", label: "Plan" },
  { page: "costs", label: "Costs" },
  { page: "audit", label: "Audit" },
  { page: "notifications", label: "Notifications" },
  { page: "projects", label: "Projects" },
  { page: "settings", label: "Settings" },
  { page: "setup", label: "Setup" },
];

/** Pages that need a selected project to render anything useful. */
const PROJECT_PAGES: Page[] = ["board", "plan", "costs", "audit", "notifications"];

/** U9: first NAV index that isn't project-scoped — renders a divider there
 *  so project tabs (Board…Notifications) read as visually distinct from
 *  app-level ones (Projects/Settings/Setup). */
const GLOBAL_NAV_START = NAV.findIndex((item) => !PROJECT_PAGES.includes(item.page));

const STORAGE_KEY = "hoop.projectId";

/** F21: global (non-project-scoped) pages that make sense as a deep link.
 *  Deliberately excludes "welcome" — it's only reached via the F1 auto
 *  redirect / SetupView's "Re-run setup" link, never a real destination. */
const GLOBAL_HASH_PAGES: Page[] = ["settings", "setup", "projects", "new-project"];

/** F21: `#/<page>` for global pages, `#/p/<projectId>/<page>` for project
 *  pages — the inverse of `hashFor` below. Returns null for anything that
 *  doesn't parse into a known, deep-linkable page (an empty hash, garbage
 *  in the URL bar, or a page like "welcome" that isn't meant to be one) —
 *  callers fall back to their own defaults in that case. */
export function parseHash(hash: string): { page: Page; projectId?: string } | null {
  const path = hash.replace(/^#\/?/, "");
  if (!path) return null;
  const parts = path.split("/");
  if (parts[0] === "p" && parts.length >= 3 && parts[1]) {
    const page = parts[2] as Page;
    return PROJECT_PAGES.includes(page) ? { page, projectId: parts[1] } : null;
  }
  const page = parts[0] as Page;
  return GLOBAL_HASH_PAGES.includes(page) ? { page } : null;
}

/** The exact inverse of `parseHash` — kept as one function so the two can
 *  never drift into producing/accepting different shapes. */
export function hashFor(page: Page, projectId: string): string {
  if (PROJECT_PAGES.includes(page) && projectId) return `#/p/${projectId}/${page}`;
  return `#/${page}`;
}

/** F21: parsed once at module load (i.e. once per real page load/reload) —
 *  never re-read afterward, since it only seeds the initial state below.
 *  Runtime hash changes (back/forward, a pasted link while the SPA is
 *  already running) are handled separately by the hashchange listener. */
const initialHashState =
  typeof window !== "undefined" ? parseHash(window.location.hash) : null;

export function App() {
  // F21: a valid project id parsed from the hash wins over localStorage —
  // this only matters on first mount (a fresh load or a pasted deep link);
  // an invalid/empty hash falls through to the exact pre-F21 defaults.
  const [page, setPage] = useState<Page>(initialHashState?.page ?? "board");
  // Once the Plan tab is visited we keep PlanView mounted (hidden behind CSS
  // display:none when inactive) so any in-flight chat or deconstruct request
  // finishes even if the user switches tabs before the reply arrives.
  const [planMounted, setPlanMounted] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  // U1: global "action required" nav badge — notifications aren't
  // project-scoped on the wire (see ws-hub.ts's isGlobalEvent), so this
  // tracks every notification regardless of which project tab is open.
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    () => initialHashState?.projectId ?? localStorage.getItem(STORAGE_KEY) ?? "",
  );
  // F1: whether to auto-redirect to the onboarding wizard is decided once,
  // right after the first settings+projects load — re-checking on every
  // render would yank the user back to Welcome if they navigate away from it
  // before creating a project.
  const [onboardingChecked, setOnboardingChecked] = useState(false);

  // S6: registers the in-app TokenGate as client.ts's 401 handler, replacing
  // the old blocking browser-prompt stopgap. Never shows unless a real
  // request 401s — auth-off (the default) never trips this.
  const [tokenGateOpen, setTokenGateOpen] = useState(false);
  const tokenGateResolveRef = useRef<((token: string | null) => void) | null>(
    null,
  );

  // U4: Settings unmounts on tab switch ({page === "settings" && <Settings
  // />}), silently discarding unsaved edits — a ref (not state) because
  // Settings reports it on every keystroke and this must never trigger a
  // re-render of App itself. Read only inside navigate(), and only while
  // page === "settings", so it's irrelevant everywhere else.
  const settingsDirtyRef = useRef(false);
  const handleSettingsDirtyChange = useCallback((dirty: boolean) => {
    settingsDirtyRef.current = dirty;
  }, []);
  const navigate = useCallback(
    (next: Page) => {
      if (
        page === "settings" &&
        settingsDirtyRef.current &&
        !window.confirm("Discard unsaved settings changes?")
      ) {
        return;
      }
      setPage(next);
    },
    [page],
  );

  // F21: keep the URL hash in sync with (page, selectedProjectId), covering
  // every way those two can change (nav clicks via navigate(), the project
  // dropdown, project creation/deletion, the F1 welcome redirect) rather
  // than threading a hash-write through each call site individually.
  // pushState so back/forward actually has entries to move through —
  // except the very first write, which replaces instead so a browser with
  // no pre-existing hash (a fresh install, or upgrading from a pre-F21
  // build) doesn't gain a useless extra back-stack entry on load. "welcome"
  // is never written — it's not a real deep-link destination. The equality
  // check is what makes this a no-op during a hashchange-driven update
  // below (the browser has already set location.hash to that same value by
  // the time this effect runs), so no extra "don't push back what we just
  // received" flag is needed.
  const isFirstHashSyncRef = useRef(true);
  useEffect(() => {
    if (page === "welcome") return;
    // Consumed here (not before the "welcome" check above) so a page of
    // "welcome" on the very first render doesn't burn the "first write
    // should replace" allowance before any real page gets a chance to use it.
    const isFirst = isFirstHashSyncRef.current;
    isFirstHashSyncRef.current = false;
    const next = hashFor(page, selectedProjectId);
    if (location.hash === next) return;
    if (isFirst) history.replaceState(null, "", next);
    else history.pushState(null, "", next);
  }, [page, selectedProjectId]);

  // F21: back/forward (and a hash typed/pasted into an already-open tab —
  // a fresh tab's initial hash is handled once by initialHashState instead)
  // land here. Routed through the exact same Settings-dirty guard navigate()
  // uses; on cancel the browser has already moved location.hash to the
  // target entry, so it's explicitly pushed back to the still-current page.
  useEffect(() => {
    function onHashChange() {
      const parsed = parseHash(location.hash);
      if (!parsed) {
        // U18: an unparseable hash (a bad paste, a stale link to a page
        // that no longer exists) previously left location.hash sitting at
        // the bogus value while the UI kept showing whatever it already
        // was — URL and UI silently disagreed until the next real
        // navigation. Snap the address bar back to the current page's own
        // canonical hash instead (replace, not push — this isn't a real
        // navigation the user should be able to "back" out of).
        history.replaceState(null, "", hashFor(page, selectedProjectId));
        return;
      }
      if (
        page === "settings" &&
        settingsDirtyRef.current &&
        !window.confirm("Discard unsaved settings changes?")
      ) {
        history.pushState(null, "", hashFor(page, selectedProjectId));
        return;
      }
      if (parsed.projectId) setSelectedProjectId(parsed.projectId);
      setPage(parsed.page);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [page, selectedProjectId]);

  useEffect(() => {
    setUnauthorizedHandler(
      () =>
        new Promise<string | null>((resolve) => {
          tokenGateResolveRef.current = resolve;
          setTokenGateOpen(true);
        }),
    );
    return () => setUnauthorizedHandler(null);
  }, []);

  const handleTokenAuthenticated = useCallback((token: string) => {
    setTokenGateOpen(false);
    tokenGateResolveRef.current?.(token);
    tokenGateResolveRef.current = null;
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const res = await api<ListProjectsResponse>("listProjects");
      setProjects(res.projects);
      setSelectedProjectId((cur) =>
        cur && res.projects.some((p) => p.id === cur)
          ? cur
          : (res.projects[0]?.id ?? ""),
      );
    } catch {
      /* ignore — server may be starting */
    } finally {
      setProjectsLoaded(true);
    }
  }, []);

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await api<ListNotificationsResponse>("listNotifications");
      setNotifications(res.notifications);
    } catch {
      /* non-critical — badge just stays at its last known count */
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  useEffect(() => {
    if (onboardingChecked || !projectsLoaded) return;
    setOnboardingChecked(true);
    if (projects.length > 0) return;
    api<{ settings: SettingsType }>("getSettings")
      .then((r) => {
        if (!r.settings.onboardedAt) setPage("welcome");
      })
      .catch(() => {
        /* server may be starting — leave the user on Board, not stuck */
      });
  }, [onboardingChecked, projectsLoaded, projects.length]);

  useEffect(() => {
    if (selectedProjectId) localStorage.setItem(STORAGE_KEY, selectedProjectId);
  }, [selectedProjectId]);

  // Keep names/status fresh as the engine runs (update existing entries in place).
  const { notify } = useBrowserNotify();
  const toast = useToast();

  const onWS = useCallback(
    (e: ServerEvent) => {
      if (e.type === "project.updated") {
        setProjects((prev) =>
          prev.some((p) => p.id === e.payload.id)
            ? prev.map((p) => (p.id === e.payload.id ? e.payload : p))
            : [e.payload, ...prev],
        );
      } else if (e.type === "project.deleted") {
        setProjects((prev) => prev.filter((p) => p.id !== e.payload.id));
        setSelectedProjectId((cur) => (cur === e.payload.id ? "" : cur));
      } else if (e.type === "notification") {
        // Global (B15) — reaches every client regardless of which project
        // tab is open, matching "action needed" mattering everywhere. Also
        // covers respond()'s own broadcast, so the U1 badge clears the
        // moment an approval is answered from any tab.
        setNotifications((prev) => {
          const idx = prev.findIndex((n) => n.id === e.payload.id);
          if (idx >= 0) return prev.map((n, i) => (i === idx ? e.payload : n));
          return [e.payload, ...prev];
        });
        if (e.payload.severity === "action_required") {
          notify(e.payload.title, { body: e.payload.message });
        }
      } else if (e.type === "task.updated" && e.payload.status === "failed") {
        notify(`Task failed: ${e.payload.title}`, {
          body: e.payload.description.split("\n")[0],
        });
      }
    },
    [notify],
  );
  useWS(selectedProjectId, onWS);

  useEffect(() => {
    if (page === "plan") setPlanMounted(true);
  }, [page]);

  // A freshly created project becomes the active one, then go straight to Plan.
  const handleProjectCreated = useCallback((p: Project) => {
    setProjects((prev) => [p, ...prev.filter((x) => x.id !== p.id)]);
    setSelectedProjectId(p.id);
    setPage("plan");
  }, []);

  const handleProjectDeleted = useCallback(
    (id: string) => {
      setSelectedProjectId((cur) => (cur === id ? "" : cur));
    },
    [],
  );

  // F23: the global "Stop all" panic button — rendered only while
  // something is actually running (live via the same project.updated WS
  // events App already tracks, not a separate poll).
  const [stopAllBusy, setStopAllBusy] = useState(false);
  const runningProjects = projects.filter((p) => p.status === "running");
  const handleStopAll = useCallback(async () => {
    if (runningProjects.length === 0) return;
    const names = runningProjects.map((p) => p.name).join(", ");
    if (
      !window.confirm(
        `Stop all running projects now? Every active agent is aborted immediately: ${names}.`,
      )
    ) {
      return;
    }
    setStopAllBusy(true);
    try {
      await api("stopAll");
      // Project statuses update via the project.updated broadcasts the
      // route itself fires (the same pattern every other pause/start
      // control in this app already relies on) — no local state patch here.
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setStopAllBusy(false);
    }
  }, [runningProjects, toast]);

  const needsProject = PROJECT_PAGES.includes(page);
  const hasProject = Boolean(selectedProjectId);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const pendingApprovals = notifications.filter(
    (n) => n.requiresApproval && !n.respondedWith,
  ).length;

  // U19: route changes are page changes, not in-page anchors. Without an
  // explicit reset, a long Settings/Plan scroll position carries into the
  // next view and can make it look as though the page opened halfway down.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [page, selectedProjectId]);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {tokenGateOpen && (
        <TokenGate onAuthenticated={handleTokenAuthenticated} />
      )}
      {/*
        Two fixed rows rather than one flex row with a flex-1 middle section:
        a flex-1 nav-links container next to a fixed-width project selector
        will starve itself down to near-zero width on narrow screens instead
        of wrapping (flex-wrap only kicks in once children hit their min
        content size, and overflow-x-auto children have no min size to hit).
        Two rows sidesteps that — the nav links always get the full row width.
      */}
      <nav className="sticky top-0 z-40 border-b border-neutral-800 bg-neutral-900 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-4">
        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <span className="mr-auto text-sm font-semibold tracking-wide text-neutral-100">
            Hoopedorc
          </span>
          <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
            <label
              htmlFor="project-selector"
              className="sr-only text-[10px] uppercase tracking-wide text-neutral-500 sm:not-sr-only"
            >
              Project
            </label>
            <select
              id="project-selector"
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              className="min-h-10 min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus-visible:ring-2 focus-visible:ring-blue-500 sm:w-[220px] sm:flex-none"
            >
              {projects.length === 0 && <option value="">No projects</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.status})
                </option>
              ))}
            </select>
            <button
              onClick={() => navigate("new-project")}
              title="Create a new project"
              className={
                "min-h-10 shrink-0 rounded border px-3 py-1 text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 " +
                (page === "new-project"
                  ? "border-blue-700 bg-blue-950/40 text-blue-200"
                  : "border-neutral-700 text-neutral-300 hover:bg-neutral-800")
              }
            >
              + New
            </button>
            {runningProjects.length > 0 && (
              <button
                onClick={handleStopAll}
                disabled={stopAllBusy}
                title="Abort every running project immediately"
                className="min-h-10 shrink-0 rounded border border-red-800 px-3 py-1 text-[11px] font-medium text-red-300 hover:bg-red-950/40 focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50"
              >
                {stopAllBusy ? "…" : "⏹ Stop all"}
              </button>
            )}
          </div>
        </div>

        <div
          data-horizontal-scroll="navigation"
          className="mt-2 flex items-center gap-1 overflow-x-auto"
        >
          {NAV.map((item, i) => (
            <Fragment key={item.page}>
              {i === GLOBAL_NAV_START && GLOBAL_NAV_START > 0 && (
                <span
                  aria-hidden="true"
                  className="mx-1 h-4 w-px shrink-0 bg-neutral-700"
                />
              )}
              <button
                onClick={() => navigate(item.page)}
                className={
                  "min-h-10 shrink-0 rounded px-3 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 " +
                  (page === item.page
                    ? "bg-neutral-700 text-neutral-100"
                    : "text-neutral-400 hover:text-neutral-200")
                }
              >
                {item.label}
                {item.page === "notifications" && pendingApprovals > 0 && (
                  <span className="ml-1.5 inline-flex min-w-[1.1rem] items-center justify-center rounded-full border border-amber-700 bg-amber-900/60 px-1 text-[10px] font-medium text-amber-300">
                    {pendingApprovals}
                  </span>
                )}
              </button>
            </Fragment>
          ))}
        </div>
      </nav>

      <main className="p-3 sm:p-4">
        {needsProject && !hasProject ? (
          <div className="mx-auto max-w-md rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-center">
            <p className="text-sm text-neutral-300">No project selected.</p>
            <p className="mt-1 text-xs text-neutral-400">
              Create one to get started.
            </p>
            <button
              onClick={() => setPage("new-project")}
              className="mt-4 rounded bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500"
            >
              New Project
            </button>
          </div>
        ) : (
          <>
            {needsProject && selectedProject && (
              <ProjectHeader
                key={selectedProject.id}
                project={selectedProject}
                compact={page !== "board"}
              />
            )}
            {page === "board" && (
              <Board
                projectId={selectedProjectId}
                repoUrl={selectedProject?.repoUrl}
                onViewNotifications={() => setPage("notifications")}
              />
            )}
            {/* PlanView stays mounted once first visited so in-flight chat/deconstruct
                requests survive tab switches. CSS hides it when inactive. */}
            {planMounted && (
              <div style={{ display: page === "plan" ? undefined : "none" }}>
                <PlanView
                  projectId={selectedProjectId}
                  onDone={() => setPage("board")}
                />
              </div>
            )}
            {page === "costs" && <CostView projectId={selectedProjectId} />}
            {page === "audit" && <AuditView projectId={selectedProjectId} />}
            {page === "notifications" && (
              <Notifications projectId={selectedProjectId} />
            )}
            {page === "settings" && (
              <Settings onDirtyChange={handleSettingsDirtyChange} />
            )}
            {page === "setup" && (
              <SetupView onRerunSetup={() => setPage("welcome")} />
            )}
            {page === "projects" && (
              <ProjectsView
                selectedProjectId={selectedProjectId}
                onSelect={setSelectedProjectId}
                onDeleted={handleProjectDeleted}
              />
            )}
            {page === "new-project" && (
              <NewProject onProjectCreated={handleProjectCreated} />
            )}
            {page === "welcome" && <Welcome onDone={handleProjectCreated} />}
          </>
        )}
      </main>
    </div>
  );
}
