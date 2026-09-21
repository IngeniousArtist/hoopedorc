import type { ReactNode } from "react";

export interface SectionOption<Id extends string> {
  id: Id;
  label: string;
}

/** Local navigation only: switching sections never submits or resets a form. */
export function SectionTabs<Id extends string>({
  id,
  label,
  sections,
  selected,
  onSelect,
}: {
  id: string;
  label: string;
  sections: readonly SectionOption<Id>[];
  selected: Id;
  onSelect: (section: Id) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 rounded-lg border border-neutral-800 bg-neutral-900 p-1">
      {sections.map((section, index) => (
        <button
          key={section.id}
          type="button"
          role="tab"
          id={`${id}-${section.id}-tab`}
          aria-controls={`${id}-${section.id}-panel`}
          aria-selected={selected === section.id}
          tabIndex={selected === section.id ? 0 : -1}
          onClick={() => onSelect(section.id)}
          onKeyDown={(event) => {
            let next: number;
            if (event.key === "Home") next = 0;
            else if (event.key === "End") next = sections.length - 1;
            else if (event.key === "ArrowRight") next = (index + 1) % sections.length;
            else if (event.key === "ArrowLeft") next = (index + sections.length - 1) % sections.length;
            else return;
            event.preventDefault();
            onSelect(sections[next]!.id);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}
          className={`min-h-10 flex-1 whitespace-nowrap rounded-md px-3 py-2 text-sm sm:flex-none ${selected === section.id ? "bg-neutral-700 text-white" : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"}`}
        >
          {section.label}
        </button>
      ))}
    </div>
  );
}

export function SectionPanel({
  group,
  id,
  selected,
  children,
}: {
  group: string;
  id: string;
  selected: string;
  children: ReactNode;
}) {
  return (
    <div
      id={`${group}-${id}-panel`}
      role="tabpanel"
      aria-labelledby={`${group}-${id}-tab`}
      hidden={selected !== id}
      tabIndex={0}
      className="min-w-0 space-y-4"
    >
      {children}
    </div>
  );
}
