import type {
  ListProjectsResponse,
  Project,
  ServerEvent,
} from "@orc/types";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api/client";
import { useWS } from "./hooks/useWS";
import { ProjectHeader } from "./components/ProjectHeader";
import { AuditView } from "./pages/AuditView";
import { Board } from "./pages/Board";
import { CostView } from "./pages/CostView";
import { NewProject } from "./pages/NewProject";
import { Notifications } from "./pages/Notifications";
import { PlanView } from "./pages/PlanView";
import { ProjectsView } from "./pages/ProjectsView";
import { Settings } from "./pages/Settings";
import { SetupView } from "./pages/SetupView";

type Page =
  | "board"
  | "plan"
  | "costs"
  | "audit"
  | "notifications"
  | "settings"
  | "setup"
  | "new-project"
  | "projects";

const NAV: { page: Page; label: string }[] = [
  { page: "board", label: "Board" },
  { page: "plan", label: "Plan" },
  { page: "costs", label: "Costs" },
  { page: "audit", label: "Audit" },
  { page: "notifications", label: "Notifications" },
  { page: "projects", label: "Projects" },
  { page: "settings", label: "Settings" },
  { page: "setup", label: "Setup" },
  { page: "new-project", label: "New Project" },
];

/** Pages that need a selected project to render anything useful. */
const PROJECT_PAGES: Page[] = ["board", "plan", "costs", "audit", "notifications"];

const STORAGE_KEY = "hoop.projectId";

export function App() {
  const [page, setPage] = useState<Page>("board");
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? "",
  );

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
    }
  }, []);

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    if (selectedProjectId) localStorage.setItem(STORAGE_KEY, selectedProjectId);
  }, [selectedProjectId]);

  // Keep names/status fresh as the engine runs (update existing entries in place).
  const onWS = useCallback((e: ServerEvent) => {
    if (e.type === "project.updated") {
      setProjects((prev) =>
        prev.some((p) => p.id === e.payload.id)
          ? prev.map((p) => (p.id === e.payload.id ? e.payload : p))
          : [e.payload, ...prev],
      );
    } else if (e.type === "project.deleted") {
      setProjects((prev) => prev.filter((p) => p.id !== e.payload.id));
      setSelectedProjectId((cur) => (cur === e.payload.id ? "" : cur));
    }
  }, []);
  useWS(selectedProjectId, onWS);

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

  const needsProject = PROJECT_PAGES.includes(page);
  const hasProject = Boolean(selectedProjectId);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <nav className="flex items-center gap-1 border-b border-neutral-800 bg-neutral-900 px-4 py-2">
        <span className="mr-4 text-sm font-semibold tracking-wide text-neutral-100">
          Hoopedorc
        </span>
        {NAV.map((item) => (
          <button
            key={item.page}
            onClick={() => setPage(item.page)}
            className={
              "rounded px-3 py-1 text-xs transition-colors " +
              (page === item.page
                ? "bg-neutral-700 text-neutral-100"
                : "text-neutral-400 hover:text-neutral-200")
            }
          >
            {item.label}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-neutral-600">
            Project
          </span>
          <select
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            className="max-w-[220px] rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
          >
            {projects.length === 0 && <option value="">No projects</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.status})
              </option>
            ))}
          </select>
        </div>
      </nav>

      <main className="p-4">
        {needsProject && !hasProject ? (
          <div className="mx-auto max-w-md rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-center">
            <p className="text-sm text-neutral-300">No project selected.</p>
            <p className="mt-1 text-xs text-neutral-500">
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
              <ProjectHeader key={selectedProject.id} project={selectedProject} />
            )}
            {page === "board" && <Board projectId={selectedProjectId} />}
            {page === "plan" && (
              <PlanView
                projectId={selectedProjectId}
                onDone={() => setPage("board")}
              />
            )}
            {page === "costs" && <CostView projectId={selectedProjectId} />}
            {page === "audit" && <AuditView projectId={selectedProjectId} />}
            {page === "notifications" && (
              <Notifications projectId={selectedProjectId} />
            )}
            {page === "settings" && <Settings />}
            {page === "setup" && <SetupView />}
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
          </>
        )}
      </main>
    </div>
  );
}
