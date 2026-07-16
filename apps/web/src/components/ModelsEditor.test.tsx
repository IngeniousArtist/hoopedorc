import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { modelFixture, settingsFixture } from "../test/fixtures";
import { ModelsEditor } from "./ModelsEditor";

describe("ModelsEditor effort controls", () => {
  it("writes the selected runner-specific effort into the model config", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ModelsEditor
        models={[modelFixture]}
        routing={settingsFixture().routing}
        onChange={onChange}
      />,
    );

    const selects = screen.getAllByRole("combobox");
    await user.selectOptions(selects[1]!, "high");

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: modelFixture.id, effort: "high" }),
    ]);
  });

  it("offers runner-specific slugs without preventing manual model ids", () => {
    render(
      <ModelsEditor
        models={[
          {
            ...modelFixture,
            id: "claude",
            displayName: "Claude",
            runner: "claude-code",
            claudeModel: "",
          },
          {
            ...modelFixture,
            id: "codex",
            displayName: "Codex",
            runner: "codex",
            codexModel: "",
          },
          {
            ...modelFixture,
            id: "deepseek",
            displayName: "DeepSeek",
            runner: "opencode",
            opencodeModel: "",
          },
        ]}
        modelSlugs={{
          "claude-code": ["sonnet"],
          codex: ["gpt-5.6-sol"],
          opencode: ["deepseek/deepseek-v4-flash"],
        }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Claude Claude model")).toHaveAttribute(
      "list",
      "claude-code-model-catalog",
    );
    expect(screen.getByLabelText("Codex Codex model")).toHaveAttribute(
      "list",
      "codex-model-catalog",
    );
    expect(screen.getByLabelText("DeepSeek OpenCode model")).toHaveAttribute(
      "list",
      "opencode-model-catalog",
    );
  });
});
