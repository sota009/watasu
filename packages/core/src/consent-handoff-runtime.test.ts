import { describe, expect, test } from "vitest";
import { resolveOpenCommand } from "./consent-handoff-runtime.js";

describe("resolveOpenCommand", () => {
  test("test_macos_uses_open", () => {
    const c = resolveOpenCommand("darwin");
    expect(c.command).toBe("open");
    expect(c.args("https://x")).toEqual(["https://x"]);
  });

  test("test_windows_uses_cmd_start", () => {
    const c = resolveOpenCommand("win32");
    expect(c.command).toBe("cmd");
    expect(c.args("https://x")).toEqual(["/c", "start", "", "https://x"]);
  });

  test("test_linux_uses_xdg_open", () => {
    const c = resolveOpenCommand("linux");
    expect(c.command).toBe("xdg-open");
    expect(c.args("https://x")).toEqual(["https://x"]);
  });
});
