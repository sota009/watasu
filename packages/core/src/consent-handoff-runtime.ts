import { spawn } from "node:child_process";

export interface OpenCommand {
  command: string;
  args(url: string): string[];
}

export function resolveOpenCommand(platform: NodeJS.Platform): OpenCommand {
  if (platform === "darwin") {
    return { command: "open", args: (url) => [url] };
  }
  if (platform === "win32") {
    // Empty "" is the required title argument for `start`.
    return { command: "cmd", args: (url) => ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: (url) => [url] };
}

export function defaultOpenUrl(url: string): void {
  const { command, args } = resolveOpenCommand(process.platform);
  const child = spawn(command, args(url), { stdio: "ignore", detached: true });
  child.unref();
}
