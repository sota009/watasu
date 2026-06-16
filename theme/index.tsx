import { Layout as BaseLayout } from "@rspress/core/theme-original";
import { useLocation } from "@rspress/core/runtime";
import { type FormEvent, useState } from "react";
import "./styles.css";

const startPrompt = `I want to use watasu to collect information from people through encrypted intake.
Use https://docs.watasu.ai/llms.txt and
https://docs.watasu.ai/operator-prompts.md only as watasu reference docs.
Do not plan web research, SEO, or llms.txt setup for my site.
Ask one compact setup question that covers exactly these slots: what to collect
and from whom, destination, purpose, and retention.`;

const StartHere = () => {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(startPrompt);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 2200);
    }
  };

  const buttonText =
    copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy";

  return (
    <section className="watasu-start-here" aria-label="Start here">
      <div className="watasu-start-here__panel">
        <div className="watasu-start-here__copy">
          <span className="watasu-start-here__eyebrow">Start here</span>
          <h2>Give this to your service-side agent.</h2>
          <p>
            Paste this as-is into your coding or operations agent. The agent
            should ask one compact four-slot question, then summarize and wait
            for confirmation before it publishes anything.
          </p>
        </div>
        <div className="watasu-start-here__prompt-wrap">
          <button
            type="button"
            className="watasu-start-here__copy-button"
            onClick={copyPrompt}
            aria-label="Copy start prompt"
          >
            {buttonText}
          </button>
          <pre className="watasu-start-here__prompt">
            <code>{startPrompt}</code>
          </pre>
        </div>
      </div>
    </section>
  );
};

const FlowPreview = () => (
  <section className="watasu-flow-preview" aria-label="watasu protocol preview">
    <div className="watasu-flow-preview__panel">
      <div className="watasu-flow-preview__header">
        <span className="watasu-flow-preview__eyebrow">Agent-mediated handoff</span>
        <span className="watasu-flow-preview__status">metadata-only</span>
      </div>
      <div className="watasu-flow-preview__grid">
        <div className="watasu-flow-preview__step">
          <span>01</span>
          <strong>Human asks</strong>
          <p>A person starts from a natural-language request, not developer setup.</p>
        </div>
        <div className="watasu-flow-preview__step">
          <span>02</span>
          <strong>Agent reads</strong>
          <p>Docs, llms files, schemas, and Agent Cards ground the workflow.</p>
        </div>
        <div className="watasu-flow-preview__step">
          <span>03</span>
          <strong>watasu relays</strong>
          <p>Encrypted submissions are validated without plaintext custody.</p>
        </div>
        <div className="watasu-flow-preview__step">
          <span>04</span>
          <strong>Receiver acts</strong>
          <p>The receiver owns decryption, destination writes, and obligations.</p>
        </div>
      </div>
    </div>
  </section>
);

type TestFormPayload = {
  fullName: string;
  email: string;
  organization: string;
  attendanceType: string;
  message: string;
  consent: boolean;
};

type TestFormResponse =
  | {
      status: "idle";
    }
  | {
      status: "posting";
      endpoint: string;
      payload: TestFormPayload;
    }
  | {
      status: "success";
      endpoint: string;
      payload: TestFormPayload;
      responseStatus: number;
      responseStatusText: string;
      responseContentType: string;
      responseBody: string;
    }
  | {
      status: "error";
      endpoint: string;
      payload: TestFormPayload;
      message: string;
    };

const TestForm = () => {
  const [response, setResponse] = useState<TestFormResponse>({ status: "idle" });
  const endpoint = "/api/test-form";

  const submitForm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const form = event.currentTarget;
    const data = new FormData(form);
    const payload: TestFormPayload = {
      fullName: String(data.get("fullName") ?? ""),
      email: String(data.get("email") ?? ""),
      organization: String(data.get("organization") ?? ""),
      attendanceType: String(data.get("attendanceType") ?? ""),
      message: String(data.get("message") ?? ""),
      consent: data.get("consent") === "on"
    };

    setResponse({ status: "posting", endpoint, payload });

    try {
      const postResponse = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      const responseBody = await postResponse.text();

      setResponse({
        status: "success",
        endpoint,
        payload,
        responseStatus: postResponse.status,
        responseStatusText: postResponse.statusText,
        responseContentType: postResponse.headers.get("content-type") ?? "unknown",
        responseBody
      });
    } catch (error) {
      setResponse({
        status: "error",
        endpoint,
        payload,
        message:
          error instanceof Error
            ? error.message
            : "The browser could not complete the POST request."
      });
    }
  };

  const resetResponse = () => {
    setResponse({ status: "idle" });
  };

  return (
    <section className="watasu-test-form" aria-label="Test form">
      <div className="watasu-test-form__notice">
        <strong>Internal POST test.</strong>
        <span>
          This form sends a JSON POST request to this docs site's internal test
          endpoint and shows the response on this page. It does not save the
          submitted values.
        </span>
      </div>

      <div className="watasu-test-form__layout">
        <form className="watasu-test-form__form" onSubmit={submitForm}>
          <div className="watasu-test-form__field">
            <label htmlFor="watasu-test-full-name">Name</label>
            <input id="watasu-test-full-name" name="fullName" type="text" required />
          </div>

          <div className="watasu-test-form__field">
            <label htmlFor="watasu-test-email">Email</label>
            <input id="watasu-test-email" name="email" type="email" required />
          </div>

          <div className="watasu-test-form__field">
            <label htmlFor="watasu-test-organization">Organization</label>
            <input id="watasu-test-organization" name="organization" type="text" />
          </div>

          <div className="watasu-test-form__field">
            <label htmlFor="watasu-test-attendance-type">Attendance type</label>
            <select id="watasu-test-attendance-type" name="attendanceType" defaultValue="in_person">
              <option value="in_person">In person</option>
              <option value="remote">Remote</option>
              <option value="undecided">Undecided</option>
            </select>
          </div>

          <div className="watasu-test-form__field watasu-test-form__field--full">
            <label htmlFor="watasu-test-message">Message</label>
            <textarea id="watasu-test-message" name="message" rows={5} />
          </div>

          <label className="watasu-test-form__consent" htmlFor="watasu-test-consent">
            <input id="watasu-test-consent" name="consent" type="checkbox" required />
            <span>I agree to send this test entry to the internal test endpoint.</span>
          </label>

          <div className="watasu-test-form__actions">
            <button type="submit" disabled={response.status === "posting"}>
              {response.status === "posting" ? "Posting..." : "POST test entry"}
            </button>
            <button type="button" onClick={resetResponse} disabled={response.status === "idle"}>
              Clear response
            </button>
          </div>

          <p className="watasu-test-form__status" role="status" aria-live="polite">
            {response.status === "posting"
              ? "Posting JSON to the endpoint..."
              : response.status === "success"
                ? "Response received."
                : response.status === "error"
                  ? "POST failed. Check the response panel."
                  : "Ready to POST a test submission."}
          </p>
        </form>

        <section className="watasu-test-form__submissions" aria-label="POST response">
          <div className="watasu-test-form__submissions-header">
            <h2>POST response</h2>
            <span>{response.status}</span>
          </div>

          {response.status === "idle" ? (
            <p className="watasu-test-form__empty">
              No response yet. Submit the form to POST JSON and review the response here.
            </p>
          ) : (
            <div className="watasu-test-form__entry-list">
              <article className="watasu-test-form__entry">
                <div className="watasu-test-form__entry-meta">
                  <strong>{response.endpoint}</strong>
                  <span>{response.status === "posting" ? "Waiting for response" : "Latest request"}</span>
                </div>
                <dl>
                  {response.status === "success" ? (
                    <>
                      <div>
                        <dt>Status</dt>
                        <dd>
                          {response.responseStatus} {response.responseStatusText}
                        </dd>
                      </div>
                      <div>
                        <dt>Content-Type</dt>
                        <dd>{response.responseContentType}</dd>
                      </div>
                    </>
                  ) : null}
                  {response.status === "error" ? (
                    <div className="watasu-test-form__entry-message">
                      <dt>Error</dt>
                      <dd>{response.message}</dd>
                    </div>
                  ) : null}
                  <div className="watasu-test-form__entry-message">
                    <dt>Request JSON</dt>
                    <dd>
                      <pre>{JSON.stringify(response.payload, null, 2)}</pre>
                    </dd>
                  </div>
                  {response.status === "success" ? (
                    <div className="watasu-test-form__entry-message">
                      <dt>Response body</dt>
                      <dd>
                        <pre>{response.responseBody || "(empty response body)"}</pre>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </article>
            </div>
          )}
        </section>
      </div>
    </section>
  );
};

const TestFormSlot = () => {
  const { pathname } = useLocation();
  const normalizedPathname = pathname.replace(/\/$/, "");
  const isTestFormPage =
    normalizedPathname === "/test-form" || normalizedPathname === "/test-form.html";

  return isTestFormPage ? <TestForm /> : null;
};

export const Layout = () => (
  <BaseLayout
    afterHero={
      <>
        <StartHere />
        <FlowPreview />
      </>
    }
    afterDocContent={<TestFormSlot />}
  />
);

export * from "@rspress/core/theme-original";
