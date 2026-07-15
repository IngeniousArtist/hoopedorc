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
});
