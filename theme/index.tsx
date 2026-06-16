import { Layout as BaseLayout } from "@rspress/core/theme-original";
import { useLocation } from "@rspress/core/runtime";
import { type FormEvent, useEffect, useRef, useState } from "react";
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

type TestFormSubmission = {
  id: string;
  submittedAt: string;
  fullName: string;
  email: string;
  organization: string;
  attendanceType: string;
  message: string;
  consent: boolean;
};

const testFormSessionKey = "watasu:test-form:submissions";

const createSubmissionId = () =>
  `submission-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const formatAttendanceType = (value: string) => {
  switch (value) {
    case "in_person":
      return "In person";
    case "remote":
      return "Remote";
    case "undecided":
      return "Undecided";
    default:
      return value;
  }
};

const readStoredSubmissions = (): TestFormSubmission[] => {
  try {
    const stored = window.sessionStorage.getItem(testFormSessionKey);
    if (!stored) {
      return [];
    }

    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeStoredSubmissions = (submissions: TestFormSubmission[]) => {
  try {
    window.sessionStorage.setItem(testFormSessionKey, JSON.stringify(submissions));
  } catch {
    // The page still works with in-memory state when browser storage is blocked.
  }
};

const TestForm = () => {
  const formRef = useRef<HTMLFormElement>(null);
  const [submissions, setSubmissions] = useState<TestFormSubmission[]>([]);
  const [loadedStorage, setLoadedStorage] = useState(false);
  const [status, setStatus] = useState<"idle" | "submitted" | "cleared">("idle");

  useEffect(() => {
    setSubmissions(readStoredSubmissions());
    setLoadedStorage(true);
  }, []);

  useEffect(() => {
    if (loadedStorage) {
      writeStoredSubmissions(submissions);
    }
  }, [loadedStorage, submissions]);

  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const form = event.currentTarget;
    const data = new FormData(form);
    const nextSubmission: TestFormSubmission = {
      id: createSubmissionId(),
      submittedAt: new Date().toISOString(),
      fullName: String(data.get("fullName") ?? ""),
      email: String(data.get("email") ?? ""),
      organization: String(data.get("organization") ?? ""),
      attendanceType: String(data.get("attendanceType") ?? ""),
      message: String(data.get("message") ?? ""),
      consent: data.get("consent") === "on"
    };

    setSubmissions((current) => [nextSubmission, ...current]);
    setStatus("submitted");
    form.reset();
  };

  const clearSubmissions = () => {
    setSubmissions([]);
    setStatus("cleared");
    formRef.current?.reset();
  };

  return (
    <section className="watasu-test-form" aria-label="Test form">
      <div className="watasu-test-form__notice">
        <strong>Local review only.</strong>
        <span>
          This test form does not send data to a server. Submitted entries stay
          in this browser session so you can review the form contents on this
          page.
        </span>
      </div>

      <div className="watasu-test-form__layout">
        <form ref={formRef} className="watasu-test-form__form" onSubmit={submitForm}>
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
            <span>I agree to use this form for this browser-local test.</span>
          </label>

          <div className="watasu-test-form__actions">
            <button type="submit">Submit test entry</button>
            <button type="button" onClick={clearSubmissions} disabled={submissions.length === 0}>
              Clear entries
            </button>
          </div>

          <p className="watasu-test-form__status" role="status" aria-live="polite">
            {status === "submitted"
              ? "Entry saved in this browser session."
              : status === "cleared"
                ? "Entries cleared from this browser session."
                : "Ready for a local test submission."}
          </p>
        </form>

        <section className="watasu-test-form__submissions" aria-label="Submitted entries">
          <div className="watasu-test-form__submissions-header">
            <h2>Submitted entries</h2>
            <span>{submissions.length}</span>
          </div>

          {submissions.length === 0 ? (
            <p className="watasu-test-form__empty">
              No entries yet. Submit the form to review the captured contents here.
            </p>
          ) : (
            <div className="watasu-test-form__entry-list">
              {submissions.map((submission) => (
                <article className="watasu-test-form__entry" key={submission.id}>
                  <div className="watasu-test-form__entry-meta">
                    <strong>{submission.id}</strong>
                    <time dateTime={submission.submittedAt}>
                      {new Date(submission.submittedAt).toLocaleString()}
                    </time>
                  </div>
                  <dl>
                    <div>
                      <dt>Name</dt>
                      <dd>{submission.fullName}</dd>
                    </div>
                    <div>
                      <dt>Email</dt>
                      <dd>{submission.email}</dd>
                    </div>
                    <div>
                      <dt>Organization</dt>
                      <dd>{submission.organization || "Not provided"}</dd>
                    </div>
                    <div>
                      <dt>Attendance</dt>
                      <dd>{formatAttendanceType(submission.attendanceType)}</dd>
                    </div>
                    <div>
                      <dt>Consent</dt>
                      <dd>{submission.consent ? "Accepted" : "Missing"}</dd>
                    </div>
                    <div className="watasu-test-form__entry-message">
                      <dt>Message</dt>
                      <dd>{submission.message || "Not provided"}</dd>
                    </div>
                  </dl>
                </article>
              ))}
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
