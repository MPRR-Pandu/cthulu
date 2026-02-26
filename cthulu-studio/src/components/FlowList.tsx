import { useState } from "react";
import type { FlowSummary, Flow } from "../types/flow";
import ToggleSwitch from "./ToggleSwitch";
import TemplateGallery from "./TemplateGallery";

interface FlowListProps {
  flows: FlowSummary[];
  activeFlowId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onImportTemplate: (flow: Flow) => void;
  onToggleEnabled: (flowId: string) => void;
}

export default function FlowList({
  flows,
  activeFlowId,
  onSelect,
  onCreate,
  onImportTemplate,
  onToggleEnabled,
}: FlowListProps) {
  const [showGallery, setShowGallery] = useState(false);

  function handleNewClick() {
    setShowGallery(true);
  }

  function handleGalleryImport(flow: Flow) {
    setShowGallery(false);
    onImportTemplate(flow);
  }

  function handleBlank() {
    setShowGallery(false);
    onCreate();
  }

  return (
    <>
      {showGallery && (
        <TemplateGallery
          onImport={handleGalleryImport}
          onBlank={handleBlank}
          onClose={() => setShowGallery(false)}
        />
      )}
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
      <div className="sidebar-header" style={{ flexShrink: 0 }}>
        <h2>Flows</h2>
        <button className="ghost" onClick={handleNewClick}>
          + New
        </button>
      </div>
      <div className="flow-list">
        {flows.map((flow) => (
          <div
            key={flow.id}
            className={`flow-item ${flow.id === activeFlowId ? "active" : ""}${!flow.enabled ? " flow-item-disabled" : ""}`}
            onClick={() => onSelect(flow.id)}
          >
            <div className="flow-item-row">
              <div className="flow-item-name">
                {flow.name}
              </div>
              <ToggleSwitch
                checked={flow.enabled}
                onChange={() => onToggleEnabled(flow.id)}
              />
            </div>
            <div className="flow-item-meta">
              {flow.node_count} nodes
            </div>
          </div>
        ))}
        {flows.length === 0 && (
          <div className="flow-item">
            <div className="flow-item-meta">No flows yet</div>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
