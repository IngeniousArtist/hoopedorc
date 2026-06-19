import type { ModelConfig, ModelId } from "@orc/types";

export function ModelSelect({
  value,
  models,
  onChange,
  allowEmpty = false,
  emptyLabel = "—",
}: {
  value: ModelId | undefined;
  models: ModelConfig[];
  onChange: (m: ModelId | undefined) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
}) {
  const enabled = models.filter((m) => m.enabled);
  const selected = value ? models.find((m) => m.id === value) : undefined;
  const isDisabled = Boolean(value && (!selected || !selected.enabled));

  return (
    <div>
      <select
        value={value ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          if (allowEmpty && v === "") {
            onChange(undefined);
          } else if (v !== "") {
            onChange(v as ModelId);
          }
        }}
        className={
          "w-full rounded border bg-neutral-900 px-2 py-1 text-xs " +
          (isDisabled
            ? "border-amber-600 text-amber-400"
            : "border-neutral-700 text-neutral-200")
        }
      >
        {allowEmpty && <option value="">{emptyLabel}</option>}
        {enabled.map((m) => (
          <option key={m.id} value={m.id}>
            {m.displayName}
          </option>
        ))}
        {selected && !selected.enabled && (
          <option value={selected.id} disabled>
            {selected.displayName} (disabled)
          </option>
        )}
      </select>
      {isDisabled && (
        <p className="mt-0.5 text-[10px] text-amber-500">
          Selected model is disabled or missing
        </p>
      )}
      {selected && selected.enabled && (
        <p className="mt-0.5 text-[10px] text-neutral-500">
          Roles: {selected.roles.join(", ")}
        </p>
      )}
    </div>
  );
}
