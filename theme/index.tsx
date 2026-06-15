import { Layout as BaseLayout } from "@rspress/core/theme-original";
import "./styles.css";

const StartHere = () => (
  <section className="watasu-start-here" aria-label="Start here">
    <div className="watasu-start-here__panel">
      <div className="watasu-start-here__copy">
        <span className="watasu-start-here__eyebrow">Start here</span>
        <h2>Give this to your service-side agent.</h2>
        <p>
          Replace the bracketed parts, then ask your coding or operations agent
          to begin the minimal setup flow. The agent should ask one compact
          setup question before it publishes anything.
        </p>
      </div>
      <pre className="watasu-start-here__prompt">
        <code>{`I want to collect [information] for [use case] with watasu.
Use https://docs.watasu.ai/llms.txt and
https://docs.watasu.ai/operator-prompts.md as watasu reference docs. Ask me
only the minimum setup question needed to proceed.`}</code>
      </pre>
    </div>
  </section>
);

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

export const Layout = () => (
  <BaseLayout
    afterHero={
      <>
        <StartHere />
        <FlowPreview />
      </>
    }
  />
);

export * from "@rspress/core/theme-original";
