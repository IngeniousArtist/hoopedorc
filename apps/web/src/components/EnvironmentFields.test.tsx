import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EnvironmentFields, commandFields, environmentFormError, environmentPreset } from "./EnvironmentFields";
import { projectConfigFromForm, projectConfigToForm } from "./ProjectConfigFields";

describe("VW16 environment editor", () => {
  it("confirms replacement, preserves literal args and keeps malformed work visible", () => {
    function Fixture() {
      const [config, setConfig] = useState(environmentPreset("node"));
      const [commands, setCommands] = useState(commandFields(config.gates?.commands));
      return <EnvironmentFields profile={config.environment} commands={commands} onChange={(environment, values) => { setConfig({ ...config, environment }); setCommands(values); }} onPreset={(runtime) => { const next = environmentPreset(runtime); setConfig(next); setCommands(commandFields(next.gates?.commands)); }} />;
    }
    render(<Fixture />);
    fireEvent.click(screen.getByRole("button", { name: "Python backend preset" }));
    expect(screen.getByLabelText("Runtime")).toHaveValue("node");
    fireEvent.click(screen.getByRole("button", { name: "Cancel preset" }));
    expect(screen.queryByRole("button", { name: "Apply preset" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Python backend preset" })); fireEvent.click(screen.getByRole("button", { name: "Apply preset" }));
    expect(screen.getByLabelText("Runtime")).toHaveValue("python3");
    expect(screen.getByLabelText("tests executable")).toHaveValue(".hoopedorc-venv/bin/python");
    fireEvent.change(screen.getByLabelText("tests arguments"), { target: { value: "keep this invalid draft" } });
    expect(screen.getByRole("alert")).toHaveTextContent("JSON array"); expect(screen.getByLabelText("tests arguments")).toHaveValue("keep this invalid draft");
  });
  it("round-trips profiles, legacy settings and existing previews without data loss", () => {
    const config = { ...environmentPreset("python3"), preview: { command: "python3", args: ["app.py", "{port}"], readinessPath: "/health", startupTimeoutSeconds: 10 }, maxAttempts: 4, skillHints: ["keep my skill"], gates: { testCommand: "legacy command", commands: { tests: { command: "tool", args: ["literal space", ""] } } } };
    expect(projectConfigFromForm(projectConfigToForm(config))).toEqual(config);
    expect(environmentFormError(config.environment, { tests: { command: "tool", args: '["a", ""]' } })).toBeNull();
  });
});
