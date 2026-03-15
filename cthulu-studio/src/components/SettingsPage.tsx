import CloudSection from "./settings/CloudSection";
import CredentialsSection from "./settings/CredentialsSection";
import ThemeSection from "./settings/ThemeSection";

function AboutSection() {
  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span className="settings-section-title">About</span>
      </div>
      <div className="settings-section-body">
        <div className="settings-row">
          <span className="settings-label">Application</span>
          <span className="settings-value">Cthulu Studio</span>
        </div>
        <div className="settings-row">
          <span className="settings-label">Version</span>
          <span className="settings-value">0.1.0</span>
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="settings-page">
      <div className="settings-content">
        <h2 className="settings-title">Settings</h2>
        <CloudSection />
        <CredentialsSection />
        <ThemeSection />
        <AboutSection />
      </div>
    </div>
  );
}
