import { spawn } from "node:child_process";
import { watasuA2aHttpJsonContentType, watasuA2aProtocolVersion } from "./a2a.js";
import { watasuEncryptedIntakeExtensionUri } from "./agent-card.js";
import {
  parseConsentStatus,
  runConsentHandoff,
  type ConsentPollResult,
  type HandoffSubmitResponse,
  type RunConsentHandoffResult
} from "./consent-handoff.js";

export interface OpenCommand {
  command: string;
  args(url: string): string[];
}

export function resolveOpenCommand(platform: NodeJS.Platform): OpenCommand {
  if (platform === "darwin") {
    return { command: "open", args: (url) => [url] };
  }
  if (platform === "win32") {
    // Empty "" is the required title argument for `start`. The URL is quoted so
    // cmd.exe does not treat `&`/`|`/`^` in it as command separators.
    return { command: "cmd", args: (url) => ["/c", "start", "", `"${url}"`] };
  }
  return { command: "xdg-open", args: (url) => [url] };
}

export function defaultOpenUrl(url: string): void {
  const { command, args } = resolveOpenCommand(process.platform);
  const child = spawn(command, args(url), { stdio: "ignore", detached: true });
  child.unref();
}

export interface SubmitWithConsentInput {
  submitUrl: string;
  /** The caller's already-encrypted A2A submission body. */
  envelope: unknown;
  /**
   * Plaintext for the consent page — only ever placed in the URL fragment, never in the
   * submit body (see `test_plaintext_never_enters_submit_body`).
   *
   * Note this still touches the local machine outside the encrypted envelope: the fragment
   * URL is printed to stdout (`print`) and passed as a process argument to the opener command
   * (`openImpl`/`defaultOpenUrl`), so it can land in terminal scrollback, captured logs, and
   * the local process table (e.g. `ps`). That exposure stays on the user's machine — it never
   * reaches watasu's server — so no-custody is preserved, but callers logging stdout or process
   * args should be aware plaintext PII may appear there.
   */
  plaintext: string;
  /** Attach the minted consent receipt token to the envelope for resubmission. */
  withReceipt(envelope: unknown, consentReceiptToken: string): unknown;
  fetchImpl?: typeof fetch;
  openImpl?(url: string): void;
  sleepImpl?(ms: number): Promise<void>;
  print?(message: string): void;
  autoOpen?: boolean;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function submitWithConsent(
  input: SubmitWithConsentInput
): Promise<RunConsentHandoffResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const print = input.print ?? ((message: string) => console.log(message));
  const autoOpen = input.autoOpen ?? true;

  const submit = async (token?: string): Promise<HandoffSubmitResponse> => {
    const envelope = token === undefined ? input.envelope : input.withReceipt(input.envelope, token);
    const response = await fetchImpl(input.submitUrl, {
      method: "POST",
      // The hosted submit endpoint is behind the A2A protocol gate; it rejects
      // anything that is not application/a2a+json carrying the version and
      // required-extension headers before the consent gate is ever reached.
      headers: {
        "content-type": watasuA2aHttpJsonContentType,
        "a2a-version": watasuA2aProtocolVersion,
        "a2a-extensions": watasuEncryptedIntakeExtensionUri
      },
      body: JSON.stringify(envelope)
    });
    return { httpStatus: response.status, body: await readJson(response) };
  };

  const openConsentUrl = (url: string): void => {
    // Always surface the URL (source of truth); auto-open is best-effort.
    print(`Approve this submission in your browser: ${url}`);
    if (autoOpen) {
      const open = input.openImpl ?? defaultOpenUrl;
      try {
        open(url);
      } catch {
        // Printing already gave the user a way through; opening is a convenience.
      }
    }
  };

  const pollConsent = async (pollUrl: string): Promise<ConsentPollResult> => {
    const response = await fetchImpl(pollUrl, { method: "GET" });
    return parseConsentStatus(await readJson(response)) ?? { status: "pending" };
  };

  return runConsentHandoff(
    { submit, openConsentUrl, pollConsent, sleep },
    {
      plaintext: input.plaintext,
      ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {}),
      ...(input.maxWaitMs !== undefined ? { maxWaitMs: input.maxWaitMs } : {})
    }
  );
}
