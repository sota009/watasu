import { Layout as BaseLayout } from "@rspress/core/theme-original";
import "./styles.css";

const FlowPreview = () => (
  <section className="watasu-flow-preview" aria-label="watasu protocol preview">
    <div className="watasu-flow-preview__panel">
      <div className="watasu-flow-preview__header">
        <span className="watasu-flow-preview__eyebrow">Live intake route</span>
        <span className="watasu-flow-preview__status">metadata-only</span>
      </div>
      <div className="watasu-flow-preview__grid">
        <div className="watasu-flow-preview__step">
          <span>01</span>
          <strong>Request YAML</strong>
          <p>Agent-readable fields and consent text.</p>
        </div>
        <div className="watasu-flow-preview__step">
          <span>02</span>
          <strong>Agent Card</strong>
          <p>Submit URL, schema hash, encryption params.</p>
        </div>
        <div className="watasu-flow-preview__step">
          <span>03</span>
          <strong>Encrypted submit</strong>
          <p>watasu validates without plaintext custody.</p>
        </div>
        <div className="watasu-flow-preview__step">
          <span>04</span>
          <strong>Receiver row</strong>
          <p>Private receiver decrypts and acts.</p>
        </div>
      </div>
    </div>
  </section>
);

export const Layout = () => <BaseLayout afterHero={<FlowPreview />} />;

export * from "@rspress/core/theme-original";
