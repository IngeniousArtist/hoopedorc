import { useState } from "react";
import { Board } from "./pages/Board";
import { CostView } from "./pages/CostView";
import { NewProject } from "./pages/NewProject";
import { Notifications } from "./pages/Notifications";
import { Settings } from "./pages/Settings";

type Page =
  | "board"
  | "costs"
  | "notifications"
  | "settings"
  | "new-project";

const NAV: { page: Page; label: string }[] = [
  { page: "board", label: "Board" },
  { page: "costs", label: "Costs" },
  { page: "notifications", label: "Notifications" },
  { page: "settings", label: "Settings" },
  { page: "new-project", label: "New Project" },
];

const PROJECT_ID = "proj-hoopedorc";

export function App() {
  const [page, setPage] = useState<Page>("board");

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
      </nav>
      <main className="p-4">
        {page === "board" && (
          <Board projectId={PROJECT_ID} />
        )}
        {page === "costs" && (
          <CostView projectId={PROJECT_ID} />
        )}
        {page === "notifications" && (
          <Notifications projectId={PROJECT_ID} />
        )}
        {page === "settings" && <Settings />}
        {page === "new-project" && <NewProject />}
      </main>
    </div>
  );
}
